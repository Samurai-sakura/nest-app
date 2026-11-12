import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, IsNull, Repository } from "typeorm";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { User } from "../entities/user.entity";
import { LoginChallenge } from "../entities/login-challenge.entity";
import type { ConfirmationMethod } from "../entities/registration-confirmation.entity";
import { ConfirmLoginDto, LOGIN_LINK_TOKEN_PATTERN } from "../dto/confirm-login.dto";
import { MailService } from "../../mail/mail.service";
import { invalidCredentials } from "../helpers/auth-errors";
import { TokenPair, TokenService } from "./token.service";

export const LOGIN_CHALLENGE_TTL_SECONDS = 600;
export const LOGIN_RESEND_AFTER_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;

export interface LoginChallengeResponse {
  confirmationRequired: true;
  method: ConfirmationMethod;
  attemptId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export type LoginResendResponse = Omit<LoginChallengeResponse, "confirmationRequired">;

@Injectable()
export class LoginChallengeService {
  private readonly logger = new Logger(LoginChallengeService.name);

  constructor(
    @InjectRepository(LoginChallenge)
    private readonly challenges: Repository<LoginChallenge>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly mailService: MailService,
    private readonly tokenService: TokenService,
  ) {}

  public async start(userId: string): Promise<LoginChallengeResponse> {
    const method = this.config.getOrThrow<ConfirmationMethod>(
      "LOGIN_EMAIL_CONFIRMATION_METHOD",
    );
    const secret = this.generateSecret(method);

    // пользователь блокируется раньше попытки; письмо уходит только после фиксации
    const result = await this.runTransaction(async (manager) => {
      const user = await this.lockUser(manager, userId);
      if (!user || user.status !== "active") {
        return { status: "inactive" as const };
      }

      const previous = await manager.findOne(LoginChallenge, {
        where: { userId, consumedAt: IsNull() },
        lock: { mode: "pessimistic_write" },
      });
      if (previous) {
        const wait = this.secondsUntilResend(previous);
        if (wait > 0) {
          return { status: "too_early" as const, wait, attemptId: previous.id };
        }
        await manager.update(LoginChallenge, previous.id, {
          consumedAt: new Date(),
          consumedReason: "replaced",
        });
      }

      const attempt = await manager.save(
        manager.create(LoginChallenge, {
          userId,
          method,
          secretHash: this.hmac(secret),
          lastSentAt: new Date(),
        }),
      );
      return { status: "created" as const, attempt, email: user.email };
    });

    if (result.status === "inactive") {
      this.logger.warn(`Login challenge rejected reason=user_inactive userId=${userId}`);
      throw invalidCredentials();
    }
    if (result.status === "too_early") {
      this.logger.warn(
        `Login challenge rejected reason=too_early userId=${userId} attemptId=${result.attemptId}`,
      );
      throw this.tooEarly(result.wait);
    }

    const { attempt, email } = result;
    this.logger.log(
      `Login challenge created userId=${userId} attemptId=${attempt.id} method=${method}`,
    );

    try {
      await this.send(email, attempt, secret);
    } catch (error) {
      this.logger.error(
        `Login challenge send failed attemptId=${attempt.id} method=${method}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "email_delivery_failed",
        message: "Failed to send confirmation email",
        confirmationRequired: true,
        method,
        attemptId: attempt.id,
        retryAfterSeconds: LOGIN_RESEND_AFTER_SECONDS,
      });
    }

    this.logger.log(`Login challenge sent attemptId=${attempt.id} method=${method}`);
    return {
      confirmationRequired: true,
      method,
      attemptId: attempt.id,
      expiresInSeconds: LOGIN_CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: LOGIN_RESEND_AFTER_SECONDS,
    };
  }

  public async confirm(dto: ConfirmLoginDto): Promise<TokenPair> {
    const input = this.parseConfirmation(dto);
    if (!input) {
      throw this.invalidConfirmation();
    }
    const { attemptId, secret, method } = input;
    const owner = await this.findOwner(attemptId);
    if (!owner) {
      this.logger.warn(`Login confirmation failed method=${method} reason=not_found`);
      throw this.invalidConfirmation();
    }

    // подпись токенов внутри транзакции: при ошибке попытка откатывается и остаётся годной
    const result = await this.runTransaction(async (manager) => {
      const user = await this.lockUser(manager, owner.userId);
      const attempt = await this.lockAttempt(manager, attemptId);

      if (!attempt || attempt.method !== method) {
        return { status: "not_found" as const };
      }
      if (attempt.consumedReason === "attempts_exhausted") {
        return { status: "exhausted" as const };
      }
      if (attempt.consumedAt) {
        return { status: "consumed" as const };
      }
      if (this.isExpired(attempt)) {
        return { status: "expired" as const };
      }
      if (!user || user.status !== "active") {
        await this.consume(manager, attempt.id, "user_inactive");
        return { status: "user_inactive" as const };
      }

      if (!this.secretMatches(secret, attempt.secretHash)) {
        if (method === "magic_link") {
          return { status: "wrong_secret" as const };
        }
        const attempts = attempt.attempts + 1;
        await manager.update(LoginChallenge, attempt.id, {
          attempts,
          ...(attempts >= MAX_CODE_ATTEMPTS && {
            consumedAt: new Date(),
            consumedReason: "attempts_exhausted" as const,
          }),
        });
        return {
          status: attempts >= MAX_CODE_ATTEMPTS
            ? ("attempts_exhausted_now" as const)
            : ("wrong_secret" as const),
        };
      }

      const tokens = this.tokenService.signPair(user.id);
      await this.consume(manager, attempt.id, "confirmed");
      return { status: "confirmed" as const, tokens, userId: user.id };
    });

    if (result.status !== "confirmed") {
      this.logger.warn(
        `Login confirmation failed method=${method} reason=${result.status} attemptId=${attemptId}`,
      );
    }
    if (result.status === "exhausted") {
      throw this.attemptsExhausted();
    }
    if (result.status === "user_inactive") {
      throw invalidCredentials();
    }
    if (result.status !== "confirmed") {
      throw this.invalidConfirmation();
    }

    this.logger.log(
      `Login confirmation succeeded method=${method} userId=${result.userId} attemptId=${attemptId}`,
    );
    return result.tokens;
  }

  public async resend(attemptId: string): Promise<LoginResendResponse> {
    const owner = await this.findOwner(attemptId);
    if (!owner) {
      this.logger.warn("Login resend rejected reason=not_found");
      throw this.invalidConfirmation();
    }

    const result = await this.runTransaction(async (manager) => {
      const user = await this.lockUser(manager, owner.userId);
      const attempt = await this.lockAttempt(manager, attemptId);

      if (!attempt) {
        return { status: "not_found" as const };
      }
      if (attempt.consumedReason === "attempts_exhausted") {
        return { status: "exhausted" as const };
      }
      if (attempt.consumedAt) {
        return { status: "consumed" as const };
      }
      if (!user || user.status !== "active") {
        await this.consume(manager, attempt.id, "user_inactive");
        return { status: "user_inactive" as const };
      }
      const wait = this.secondsUntilResend(attempt);
      if (wait > 0) {
        return { status: "too_early" as const, wait };
      }

      // истёкший срок не мешает resend: новый секрет заново запускает TTL
      const secret = this.generateSecret(attempt.method);
      const lastSentAt = new Date();
      await manager.update(LoginChallenge, attempt.id, {
        secretHash: this.hmac(secret),
        lastSentAt,
        attempts: 0,
      });
      return {
        status: "ok" as const,
        attempt: { ...attempt, lastSentAt },
        email: user.email,
        secret,
      };
    });

    if (result.status !== "ok") {
      this.logger.warn(
        `Login resend rejected reason=${result.status} attemptId=${attemptId}`,
      );
    }
    if (result.status === "exhausted") {
      throw this.attemptsExhausted();
    }
    if (result.status === "too_early") {
      throw this.tooEarly(result.wait);
    }
    if (result.status === "user_inactive") {
      throw invalidCredentials();
    }
    if (result.status !== "ok") {
      throw this.invalidConfirmation();
    }

    const { attempt, email, secret } = result;
    try {
      await this.send(email, attempt, secret);
    } catch (error) {
      // новый хеш остаётся, старый секрет не восстанавливается
      this.logger.error(
        `Login challenge send failed attemptId=${attempt.id} method=${attempt.method}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "email_delivery_failed",
        message: "Failed to send confirmation email",
        retryAfterSeconds: LOGIN_RESEND_AFTER_SECONDS,
      });
    }

    this.logger.log(
      `Login challenge resent attemptId=${attempt.id} method=${attempt.method}`,
    );
    return {
      method: attempt.method,
      attemptId: attempt.id,
      expiresInSeconds: LOGIN_CHALLENGE_TTL_SECONDS,
      resendAfterSeconds: LOGIN_RESEND_AFTER_SECONDS,
    };
  }

  private parseConfirmation(dto: ConfirmLoginDto) {
    if (dto.token !== undefined) {
      const match = LOGIN_LINK_TOKEN_PATTERN.exec(dto.token);
      return match
        ? { attemptId: match[1], secret: match[2], method: "magic_link" as const }
        : null;
    }
    return { attemptId: dto.attemptId!, secret: dto.code!, method: "otp" as const };
  }

  private async findOwner(attemptId: string) {
    try {
      return await this.challenges.findOne({
        where: { id: attemptId },
        select: { id: true, userId: true },
      });
    } catch (error) {
      this.logger.error(`Login challenge lookup failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException("Login is temporarily unavailable");
    }
  }

  private async runTransaction<T>(work: (manager: EntityManager) => Promise<T>) {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      this.logger.error(`Login challenge transaction failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException("Login is temporarily unavailable");
    }
  }

  private lockUser(manager: EntityManager, userId: string) {
    return manager.findOne(User, {
      where: { id: userId },
      select: { id: true, email: true, status: true },
      lock: { mode: "pessimistic_write" },
    });
  }

  private lockAttempt(manager: EntityManager, attemptId: string) {
    return manager.findOne(LoginChallenge, {
      where: { id: attemptId },
      lock: { mode: "pessimistic_write" },
    });
  }

  private consume(
    manager: EntityManager,
    attemptId: string,
    reason: "confirmed" | "user_inactive",
  ) {
    return manager.update(LoginChallenge, attemptId, {
      consumedAt: new Date(),
      consumedReason: reason,
    });
  }

  private isExpired(attempt: LoginChallenge) {
    return (
      attempt.lastSentAt.getTime() + LOGIN_CHALLENGE_TTL_SECONDS * 1000 < Date.now()
    );
  }

  private secondsUntilResend(attempt: LoginChallenge) {
    const readyAt = attempt.lastSentAt.getTime() + LOGIN_RESEND_AFTER_SECONDS * 1000;
    return Math.max(0, Math.ceil((readyAt - Date.now()) / 1000));
  }

  private tooEarly(wait: number) {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: "resend_too_early",
        message: `Email can be requested again in ${wait} seconds`,
        retryAfterSeconds: wait,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private invalidConfirmation() {
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "invalid_confirmation",
      message: "Invalid or expired confirmation code",
    });
  }

  private attemptsExhausted() {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: "attempts_exhausted",
        message: "Too many attempts",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private generateSecret(method: ConfirmationMethod) {
    return method === "otp"
      ? randomInt(0, 1_000_000).toString().padStart(6, "0")
      : randomBytes(32).toString("base64url");
  }

  private hmac(value: string) {
    return createHmac(
      "sha256",
      this.config.getOrThrow<string>("LOGIN_CHALLENGE_HMAC_KEY"),
    )
      .update(value)
      .digest("hex");
  }

  private secretMatches(secret: string, storedHash: string) {
    return timingSafeEqual(
      Buffer.from(this.hmac(secret), "hex"),
      Buffer.from(storedHash, "hex"),
    );
  }

  private async send(email: string, attempt: LoginChallenge, secret: string) {
    if (attempt.method === "otp") {
      await this.mailService.sendLoginOtp(email, secret);
      return;
    }
    const origin = this.config.getOrThrow<string>("FRONTEND_ORIGIN");
    const link = `${origin}/auth/login/confirm#token=${attempt.id}.${secret}`;
    await this.mailService.sendLoginMagicLink(email, link);
  }
}
