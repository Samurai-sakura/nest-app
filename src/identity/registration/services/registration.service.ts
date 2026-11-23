import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, IsNull, QueryFailedError, Repository } from "typeorm";
import * as argon2 from "argon2";
import { UserRegisterDto } from "../dto/user-register.dto";
import { ConfirmRegistrationDto } from "../dto/confirm-registration.dto";
import { ResendConfirmationDto } from "../dto/resend-confirmation.dto";
import { User } from "../../../users/entities/user.entity";
import { RegistrationConfirmation } from "../entities/registration-confirmation.entity";
import type { ConfirmationMethod } from "../../confirmation-method";
import {
  CONFIRMATION_MAX_ATTEMPTS,
  CONFIRMATION_RESEND_AFTER_SECONDS,
  CONFIRMATION_TTL_SECONDS,
  generateSecret,
  hashSecret,
  secondsUntilResend,
  secretMatches,
} from "../../confirmation/confirmation-secret";
import {
  attemptsExhausted,
  emailDeliveryFailed,
  invalidConfirmation,
  resendTooEarly,
} from "../../confirmation/confirmation-errors";
import { MailService } from "../../../mail/mail.service";
import { UserRolesService } from "../../../access-control/rbac/services/user-roles.service";

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    @InjectRepository(RegistrationConfirmation)
    private readonly confirmationRepository: Repository<RegistrationConfirmation>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly mailService: MailService,
    private readonly userRoles: UserRolesService,
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
    let user: User;
    try {
      user = await this.dataSource.transaction(async (manager) => {
        const created = await manager.save(
          manager.create(User, {
            email: dto.email,
            passwordHash,
            status: "active",
          }),
        );
        await this.userRoles.assignDefaultRole(manager, created.id);
        return created;
      });
    } catch (error) {
      this.throwIfEmailTaken(error);
      this.logger.error(`Registration failed: ${(error as Error).message}`);
      throw error;
    }

    this.logger.log(`Registration succeeded userId=${user.id} status=active`);
    return { id: user.id, email: user.email, status: user.status };
  }

  private async registerPending(dto: UserRegisterDto, passwordHash: string) {
    const method = this.config.getOrThrow<ConfirmationMethod>(
      "REGISTRATION_CONFIRM_METHOD",
    );
    const secret = generateSecret(method);

    let user: User;
    let attempt: RegistrationConfirmation;
    try {
      ({ user, attempt } = await this.dataSource.transaction(async (manager) => {
        const user = await manager.save(
          manager.create(User, {
            email: dto.email,
            passwordHash,
            status: "pending",
          }),
        );
        const attempt = await manager.save(
          manager.create(RegistrationConfirmation, {
            userId: user.id,
            method,
            secretHash: hashSecret(this.hmacKey(), secret),
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
      throw emailDeliveryFailed();
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

      const wait = attempt.lastSentAt ? secondsUntilResend(attempt.lastSentAt) : 0;
      if (wait > 0) {
        return { status: "too_early" as const, wait, attemptId: attempt.id };
      }

      const secret = generateSecret(attempt.method);
      const previousLastSentAt = attempt.lastSentAt;
      await manager.update(RegistrationConfirmation, attempt.id, {
        secretHash: hashSecret(this.hmacKey(), secret),
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
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: "no_pending_confirmation",
        message: "No pending confirmation for this email",
      });
    }
    if (result.status === "too_early") {
      this.logger.warn(
        `Resend rejected reason=too_early attemptId=${result.attemptId}`,
      );
      throw resendTooEarly(result.wait);
    }

    const { attempt, email, secret, previousLastSentAt } = result;
    try {
      await this.sendConfirmation(email, attempt.method, secret);
    } catch (error) {
      await this.confirmationRepository.update(attempt.id, {
        lastSentAt: previousLastSentAt,
      });
      this.logger.error(
        `Confirmation send failed attemptId=${attempt.id} method=${attempt.method}: ${(error as Error).message}`,
      );
      throw emailDeliveryFailed();
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
      resendAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
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
          secretHash: hashSecret(this.hmacKey(), token),
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
        if (attempt.failedAttempts >= CONFIRMATION_MAX_ATTEMPTS) {
          return { status: "exhausted" as const, attemptId: attempt.id };
        }

        const matches = secretMatches(this.hmacKey(), code!, attempt.secretHash);
        if (!matches) {
          await attempts.increment({ id: attempt.id }, "failedAttempts", 1);
          return { status: "wrong_code" as const, attemptId: attempt.id };
        }
      }

      await manager.update(User, attempt.userId, { status: "active" });
      await this.userRoles.assignDefaultRole(manager, attempt.userId);
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
      throw attemptsExhausted();
    }
    if (result.status !== "ok") {
      throw invalidConfirmation();
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

  private hmacKey() {
    return this.config.getOrThrow<string>("CONFIRMATION_HMAC_SECRET");
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
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        code: "email_taken",
        message: "Email already registered",
      });
    }
  }
}
