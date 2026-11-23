import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, IsNull, Repository } from "typeorm";
import { User } from "../../../users/entities/user.entity";
import { LoginChallenge } from "../entities/login-challenge.entity";
import type { ConfirmationMethod } from "../../confirmation-method";
import {
  CONFIRMATION_LINK_TOKEN_PATTERN,
  CONFIRMATION_MAX_ATTEMPTS,
  CONFIRMATION_RESEND_AFTER_SECONDS,
  CONFIRMATION_TTL_SECONDS,
  generateSecret,
  hashSecret,
  isExpired,
  secondsUntilResend,
  secretMatches,
} from "../../confirmation/confirmation-secret";
import {
  attemptsExhausted,
  emailDeliveryFailed,
  invalidConfirmation,
  resendTooEarly,
} from "../../confirmation/confirmation-errors";
import { ConfirmLoginDto } from "../dto/confirm-login.dto";
import { MailService } from "../../../mail/mail.service";
import { invalidCredentials, loginUnavailable } from "../helpers/auth-errors";
import { TokenPair, TokenService } from "./token.service";

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
    const secret = generateSecret(method);

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
        const wait = secondsUntilResend(previous.lastSentAt);
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
          secretHash: hashSecret(this.hmacKey(), secret),
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
      throw resendTooEarly(result.wait);
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
      throw emailDeliveryFailed({
        confirmationRequired: true,
        method,
        attemptId: attempt.id,
        retryAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
      });
    }

    this.logger.log(`Login challenge sent attemptId=${attempt.id} method=${method}`);
    return {
      confirmationRequired: true,
      method,
      attemptId: attempt.id,
      expiresInSeconds: CONFIRMATION_TTL_SECONDS,
      resendAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
    };
  }

  public async confirm(dto: ConfirmLoginDto): Promise<TokenPair> {
    const input = this.parseConfirmation(dto);
    if (!input) {
      throw invalidConfirmation();
    }
    const { attemptId, secret, method } = input;
    const owner = await this.findOwner(attemptId);
    if (!owner) {
      this.logger.warn(`Login confirmation failed method=${method} reason=not_found`);
      throw invalidConfirmation();
    }

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
      if (isExpired(attempt.lastSentAt)) {
        return { status: "expired" as const };
      }
      if (!user || user.status !== "active") {
        await this.consume(manager, attempt.id, "user_inactive");
        return { status: "user_inactive" as const };
      }

      if (!secretMatches(this.hmacKey(), secret, attempt.secretHash)) {
        if (method === "magic_link") {
          return { status: "wrong_secret" as const };
        }
        const attempts = attempt.attempts + 1;
        await manager.update(LoginChallenge, attempt.id, {
          attempts,
          ...(attempts >= CONFIRMATION_MAX_ATTEMPTS && {
            consumedAt: new Date(),
            consumedReason: "attempts_exhausted" as const,
          }),
        });
        return {
          status: attempts >= CONFIRMATION_MAX_ATTEMPTS
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
      throw attemptsExhausted();
    }
    if (result.status === "user_inactive") {
      throw invalidCredentials();
    }
    if (result.status !== "confirmed") {
      throw invalidConfirmation();
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
      throw invalidConfirmation();
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
      const wait = secondsUntilResend(attempt.lastSentAt);
      if (wait > 0) {
        return { status: "too_early" as const, wait };
      }

      // истёкший срок не мешает resend: новый секрет заново запускает TTL
      const secret = generateSecret(attempt.method);
      const lastSentAt = new Date();
      await manager.update(LoginChallenge, attempt.id, {
        secretHash: hashSecret(this.hmacKey(), secret),
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
      throw attemptsExhausted();
    }
    if (result.status === "too_early") {
      throw resendTooEarly(result.wait);
    }
    if (result.status === "user_inactive") {
      throw invalidCredentials();
    }
    if (result.status !== "ok") {
      throw invalidConfirmation();
    }

    const { attempt, email, secret } = result;
    try {
      await this.send(email, attempt, secret);
    } catch (error) {
      // новый хеш остаётся, старый секрет не восстанавливается
      this.logger.error(
        `Login challenge send failed attemptId=${attempt.id} method=${attempt.method}: ${(error as Error).message}`,
      );
      throw emailDeliveryFailed({
        retryAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
      });
    }

    this.logger.log(
      `Login challenge resent attemptId=${attempt.id} method=${attempt.method}`,
    );
    return {
      method: attempt.method,
      attemptId: attempt.id,
      expiresInSeconds: CONFIRMATION_TTL_SECONDS,
      resendAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
    };
  }

  private parseConfirmation(dto: ConfirmLoginDto) {
    if (dto.token !== undefined) {
      const match = CONFIRMATION_LINK_TOKEN_PATTERN.exec(dto.token);
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
      throw loginUnavailable();
    }
  }

  private async runTransaction<T>(work: (manager: EntityManager) => Promise<T>) {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      this.logger.error(`Login challenge transaction failed: ${(error as Error).message}`);
      throw loginUnavailable();
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

  private hmacKey() {
    return this.config.getOrThrow<string>("LOGIN_CHALLENGE_HMAC_KEY");
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
