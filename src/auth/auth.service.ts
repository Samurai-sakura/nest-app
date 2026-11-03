import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, IsNull, QueryFailedError, Repository } from "typeorm";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import * as argon2 from "argon2";
import { UserRegisterDto } from "./dto/user-register.dto";
import { ConfirmRegistrationDto } from "./dto/confirm-registration.dto";
import { ResendConfirmationDto } from "./dto/resend-confirmation.dto";
import { User } from "./entities/user.entity";
import {
  ConfirmationMethod,
  RegistrationConfirmation,
} from "./entities/registration-confirmation.entity";
import { MailService } from "../mail/mail.service";

const CONFIRMATION_TTL_SECONDS = 600;
const RESEND_AFTER_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RegistrationConfirmation)
    private readonly confirmationRepository: Repository<RegistrationConfirmation>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly mailService: MailService,
  ) {}

  public async register(dto: UserRegisterDto) {
    const passwordHash = await argon2.hash(dto.password);
    const confirmEnabled =
      this.config.get("REGISTRATION_CONFIRM_ENABLED") === "true";

    if (!confirmEnabled) {
      return this.registerActive(dto, passwordHash);
    }
    return this.registerPending(dto, passwordHash);
  }

  private async registerActive(dto: UserRegisterDto, passwordHash: string) {
    const user = this.userRepository.create({
      email: dto.email,
      name: dto.name ?? null,
      passwordHash,
      status: "active",
    });

    try {
      await this.userRepository.save(user);
    } catch (error) {
      this.throwIfEmailTaken(error);
      this.logger.error(`Registration failed: ${(error as Error).message}`);
      throw error;
    }

    this.logger.log(`Registration succeeded userId=${user.id} status=active`);
    return { id: user.id, name: user.name ?? null, email: user.email, status: user.status };
  }

  private async registerPending(dto: UserRegisterDto, passwordHash: string) {
    const method = this.config.getOrThrow<ConfirmationMethod>(
      "REGISTRATION_CONFIRM_METHOD",
    );
    const secret = this.generateSecret(method);

    let user: User;
    let attempt: RegistrationConfirmation;
    try {
      ({ user, attempt } = await this.dataSource.transaction(async (manager) => {
        const user = await manager.save(
          manager.create(User, {
            email: dto.email,
            name: dto.name ?? null,
            passwordHash,
            status: "pending",
          }),
        );
        const attempt = await manager.save(
          manager.create(RegistrationConfirmation, {
            userId: user.id,
            method,
            secretHash: this.hmac(secret),
            expiresAt: new Date(Date.now() + CONFIRMATION_TTL_SECONDS * 1000),
          }),
        );
        return { user, attempt };
      }));
    } catch (error) {
      this.throwIfEmailTaken(error);
      this.logger.error(`Registration failed: ${(error as Error).message}`);
      throw error;
    }

    this.logger.log(
      `Registration succeeded userId=${user.id} status=pending attemptId=${attempt.id}`,
    );

    try {
      await this.sendConfirmation(user.email, method, secret);
    } catch (error) {
      this.logger.error(
        `Confirmation send failed attemptId=${attempt.id} method=${method}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException("Failed to send confirmation email");
    }

    await this.confirmationRepository.update(attempt.id, {
      lastSentAt: new Date(),
    });
    this.logger.log(`Confirmation sent attemptId=${attempt.id} method=${method}`);

    return this.confirmationResponse(attempt.id, method);
  }

  public async resend(dto: ResendConfirmationDto) {
    const result = await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOneBy(User, { email: dto.email });
      if (!user || user.status !== "pending") {
        return { status: "no_pending" as const };
      }

      const attempt = await manager.findOne(RegistrationConfirmation, {
        where: { userId: user.id, consumedAt: IsNull() },
        lock: { mode: "pessimistic_write" },
      });
      if (!attempt) {
        return { status: "no_pending" as const };
      }

      if (
        attempt.lastSentAt &&
        Date.now() - attempt.lastSentAt.getTime() < RESEND_AFTER_SECONDS * 1000
      ) {
        return { status: "too_early" as const, attemptId: attempt.id };
      }

      // способ берём из попытки, а не из текущей настройки
      const secret = this.generateSecret(attempt.method);
      const previousLastSentAt = attempt.lastSentAt;
      // lastSentAt ставим сразу, чтобы параллельный resend получил 429
      await manager.update(RegistrationConfirmation, attempt.id, {
        secretHash: this.hmac(secret),
        failedAttempts: 0,
        expiresAt: new Date(Date.now() + CONFIRMATION_TTL_SECONDS * 1000),
        lastSentAt: new Date(),
      });

      return {
        status: "ok" as const,
        attempt,
        email: user.email,
        secret,
        previousLastSentAt,
      };
    });

    if (result.status === "no_pending") {
      this.logger.warn("Resend rejected reason=no_pending");
      throw new BadRequestException("No pending confirmation for this email");
    }
    if (result.status === "too_early") {
      this.logger.warn(
        `Resend rejected reason=too_early attemptId=${result.attemptId}`,
      );
      throw new HttpException(
        "Resend is allowed once per 60 seconds",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { attempt, email, secret, previousLastSentAt } = result;
    try {
      await this.sendConfirmation(email, attempt.method, secret);
    } catch (error) {
      // письмо не ушло: возвращаем lastSentAt, чтобы можно было повторить сразу
      await this.confirmationRepository.update(attempt.id, {
        lastSentAt: previousLastSentAt,
      });
      this.logger.error(
        `Confirmation send failed attemptId=${attempt.id} method=${attempt.method}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException("Failed to send confirmation email");
    }

    this.logger.log(
      `Confirmation resent attemptId=${attempt.id} method=${attempt.method}`,
    );
    return this.confirmationResponse(attempt.id, attempt.method);
  }

  private confirmationResponse(attemptId: string, method: ConfirmationMethod) {
    return {
      confirmationRequired: true,
      method,
      attemptId,
      expiresInSeconds: CONFIRMATION_TTL_SECONDS,
      resendAfterSeconds: RESEND_AFTER_SECONDS,
    };
  }

  public confirm(dto: ConfirmRegistrationDto) {
    return dto.token !== undefined
      ? this.confirmLink(dto.token)
      : this.confirmOtp(dto.attemptId!, dto.code!);
  }

  private confirmOtp(attemptId: string, code: string) {
    return this.confirmAttempt(
      "otp",
      (attempts) =>
        attempts.findOne({
          where: { id: attemptId, method: "otp" },
          lock: { mode: "pessimistic_write" },
        }),
      code,
    );
  }

  private confirmLink(token: string) {
    return this.confirmAttempt("magic_link", (attempts) =>
      attempts.findOne({
        where: {
          secretHash: this.hmac(token),
          method: "magic_link",
          consumedAt: IsNull(),
        },
        lock: { mode: "pessimistic_write" },
      }),
    );
  }

  private async confirmAttempt(
    method: ConfirmationMethod,
    findAttempt: (
      attempts: Repository<RegistrationConfirmation>,
    ) => Promise<RegistrationConfirmation | null>,
    code?: string,
  ) {
    // ошибки выбрасываем после транзакции, иначе откатится увеличение счётчика
    const result = await this.dataSource.transaction(async (manager) => {
      const attempts = manager.getRepository(RegistrationConfirmation);
      const attempt = await findAttempt(attempts);

      if (!attempt) {
        return { status: "not_found" as const };
      }
      if (attempt.consumedAt) {
        return { status: "consumed" as const, attemptId: attempt.id };
      }

      if (attempt.expiresAt.getTime() < Date.now()) {
        return { status: "expired" as const, attemptId: attempt.id };
      }

      if (attempt.method === "otp") {
        if (attempt.failedAttempts >= MAX_CODE_ATTEMPTS) {
          return { status: "exhausted" as const, attemptId: attempt.id };
        }

        const matches = timingSafeEqual(
          Buffer.from(this.hmac(code!), "hex"),
          Buffer.from(attempt.secretHash, "hex"),
        );
        if (!matches) {
          await attempts.increment({ id: attempt.id }, "failedAttempts", 1);
          return { status: "wrong_code" as const, attemptId: attempt.id };
        }
      }

      await manager.update(User, attempt.userId, { status: "active" });
      await attempts.update(attempt.id, { consumedAt: new Date() });
      const user = await manager.findOneByOrFail(User, { id: attempt.userId });
      return { status: "ok" as const, attemptId: attempt.id, user };
    });

    if (result.status !== "ok") {
      const attemptId = "attemptId" in result ? result.attemptId : "unknown";
      this.logger.warn(
        `Confirmation failed method=${method} reason=${result.status} attemptId=${attemptId}`,
      );
    }

    // клиенту причины не различаем: всё, кроме исчерпанного лимита, — одинаковый 400
    if (result.status === "exhausted") {
      throw new HttpException("Too many attempts", HttpStatus.TOO_MANY_REQUESTS);
    }
    if (result.status !== "ok") {
      throw new BadRequestException("Invalid or expired confirmation code");
    }

    this.logger.log(
      `Confirmation succeeded method=${method} userId=${result.user.id} attemptId=${result.attemptId}`,
    );
    return {
      id: result.user.id,
      email: result.user.email,
      status: result.user.status,
    };
  }

  private generateSecret(method: ConfirmationMethod): string {
    return method === "otp"
      ? randomInt(0, 1_000_000).toString().padStart(6, "0")
      : randomBytes(32).toString("base64url");
  }

  private hmac(value: string): string {
    return createHmac(
      "sha256",
      this.config.getOrThrow<string>("CONFIRMATION_HMAC_SECRET"),
    )
      .update(value)
      .digest("hex");
  }

  private async sendConfirmation(
    email: string,
    method: ConfirmationMethod,
    secret: string,
  ) {
    if (method === "otp") {
      await this.mailService.sendOtp(email, secret);
      return;
    }
    const link = `${this.config.getOrThrow("APP_URL")}/auth/register/confirm?token=${secret}`;
    await this.mailService.sendMagicLink(email, link);
  }

  private throwIfEmailTaken(error: unknown) {
    if (error instanceof QueryFailedError && (error as any).code === "23505") {
      this.logger.warn("Registration rejected: email already registered");
      throw new ConflictException("Email already registered");
    }
  }
}
