import { HttpException, Injectable, Logger } from "@nestjs/common";
import { MailService } from "../../mail/mail.service";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager, IsNull } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { EmailChangeSendLimiter } from "./email-change-send-limiter.service";
import type { ConfirmationMethod } from "../../identity/confirmation-method";
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
} from "../../identity/confirmation/confirmation-secret";
import {
  emailDeliveryFailed,
  invalidConfirmation,
  resendTooEarly,
} from "../../identity/confirmation/confirmation-errors";
import { invalidSession } from "../../identity/authentication/helpers/auth-errors";
import { EmailChangeChallenge } from "../entities/email-change-challenge.entity";
import { User } from "../entities/user.entity";
import {
  EmailChangeChallengeResponse,
} from "../dto/email-change-responses.dto";
import { EmailChangeConfirmDto } from "../dto/email-change-confirm.dto";
import { UserProfileResponse } from "../dto/user-profile.dto";
import { isEmailConflict } from "../helpers/email-conflict";
import { toUserProfile } from "../helpers/user-profile";
import {
  challengeExpired,
  consumedChallenge,
  emailChangeRejected,
  invalidChallenge,
  invalidCode,
  lastAttemptFailed,
} from "../helpers/email-change-errors";
import { usersUnavailable } from "../helpers/users-errors";

@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
    private readonly emailLimiter: EmailChangeSendLimiter,
    private readonly configService: ConfigService,
  ) {}

  public async start(
    userId: string,
    newEmail: string,
  ): Promise<EmailChangeChallengeResponse> {
    const method = this.config.getOrThrow<ConfirmationMethod>(
      "EMAIL_CHANGE_METHOD",
    );
    const secret = generateSecret(method);

    const result = await this.runTransaction(async (manager) => {
      const user = await this.lockUser(manager, userId);
      if (!user || user.status !== "active") {
        return { status: "inactive" as const };
      }

      if (newEmail === user.email) {
        return { status: "email_unchanged" as const };
      }
      if (await manager.exists(User, { where: { email: newEmail } })) {
        return { status: "email_taken" as const };
      }

      const previous = await manager.findOne(EmailChangeChallenge, {
        where: { userId, consumedAt: IsNull() },
        lock: { mode: "pessimistic_write" },
      });
      const wait = previous ? secondsUntilResend(previous.lastSentAt) : 0;
      if (previous && wait > 0) {
        return { status: "too_early" as const, wait, challengeId: previous.id };
      }

      this.emailLimiter.check(userId);

      if (previous) {
        await manager.update(EmailChangeChallenge, previous.id, {
          consumedAt: new Date(),
          consumedReason: "replaced",
        });
      }

      const challenge = await manager.save(
        manager.create(EmailChangeChallenge, {
          userId,
          method,
          secretHash: hashSecret(this.hmacKey(), secret),
          lastSentAt: new Date(),
          newEmail,
        }),
      );
      return { status: "created" as const, challenge, email: newEmail };
    });

    if (result.status === "inactive") {
      this.logger.warn(
        `Email change challenge rejected reason=user_inactive userId=${userId}`,
      );
      throw invalidSession();
    }
    if (
      result.status === "email_unchanged" ||
      result.status === "email_taken"
    ) {
      this.logger.warn(
        `Email change challenge rejected reason=${result.status} userId=${userId}`,
      );
      throw emailChangeRejected(result.status);
    }
    if (result.status === "too_early") {
      this.logger.warn(
        `Email change challenge rejected reason=too_early userId=${userId} challengeId=${result.challengeId}`,
      );
      throw resendTooEarly(result.wait);
    }

    const { challenge, email } = result;
    this.logger.log(
      `Email change challenge created userId=${userId} challengeId=${challenge.id} method=${method}`,
    );
    this.emailLimiter.record(userId);

    try {
      await this.send(email, challenge, secret);
    } catch (error) {
      this.logger.error(
        `Email change challenge send failed userId=${userId} challengeId=${challenge.id} method=${method} errorCode=${this.errorCode(error)}`,
      );
      throw emailDeliveryFailed({
        confirmationRequired: true,
        method,
        challengeId: challenge.id,
        retryAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
      });
    }

    this.logger.log(
      `Email change challenge sent userId=${userId} challengeId=${challenge.id} method=${method}`,
    );
    return {
      confirmationRequired: true,
      method,
      challengeId: challenge.id,
      expiresInSeconds: CONFIRMATION_TTL_SECONDS,
      resendAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
    };
  }

  public async resend(
    userId: string,
    challengeId: string,
  ): Promise<EmailChangeChallengeResponse> {
    const result = await this.runTransaction(async (manager) => {
      const user = await this.lockUser(manager, userId);
      if (!user || user.status !== "active") {
        return { status: "inactive" as const };
      }

      const challenge = await manager.findOne(EmailChangeChallenge, {
        where: { id: challengeId, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!challenge) {
        return { status: "invalid" as const };
      }
      if (challenge.consumedAt) {
        return {
          status: "consumed" as const,
          reason: challenge.consumedReason,
          challengeId: challenge.id,
        };
      }

      const wait = secondsUntilResend(challenge.lastSentAt);
      if (wait > 0) {
        return {
          status: "too_early" as const,
          wait,
          challengeId: challenge.id,
        };
      }

      this.emailLimiter.check(userId);

      const secret = generateSecret(challenge.method);
      await manager.update(EmailChangeChallenge, challenge.id, {
        secretHash: hashSecret(this.hmacKey(), secret),
        attempts: 0,
        lastSentAt: new Date(),
      });

      return {
        status: "ok" as const,
        challenge,
        secret,
      };
    });

    if (result.status === "invalid") {
      this.logger.warn(
        `Email change challenge rejected reason=not_found userId=${userId} challengeId=${challengeId}`,
      );
      throw invalidChallenge();
    }
    if (result.status === "consumed") {
      this.logger.warn(
        `Email change challenge rejected reason=${result.reason} userId=${userId} challengeId=${result.challengeId}`,
      );
      throw consumedChallenge(result.reason);
    }
    if (result.status === "too_early") {
      this.logger.warn(
        `Email change challenge rejected reason=too_early userId=${userId} challengeId=${result.challengeId}`,
      );
      throw resendTooEarly(result.wait);
    }

    if (result.status === "inactive") {
      this.logger.warn(
        `Email change challenge rejected reason=user_inactive userId=${userId}`,
      );
      throw invalidSession();
    }

    const { challenge, secret } = result;
    this.emailLimiter.record(userId);
    try {
      await this.send(challenge.newEmail, challenge, secret);
    } catch (error) {
      this.logger.error(
        `Email change challenge send failed userId=${userId} challengeId=${challenge.id} method=${challenge.method} errorCode=${this.errorCode(error)}`,
      );
      throw emailDeliveryFailed({
        confirmationRequired: true,
        method: challenge.method,
        challengeId: challenge.id,
        retryAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
      });
    }

    this.logger.log(
      `Email change challenge resent userId=${userId} challengeId=${challenge.id} method=${challenge.method}`,
    );
    return this.confirmationResponse(challenge.id, challenge.method);
  }

  public async confirm(
    userId: string,
    dto: EmailChangeConfirmDto,
  ): Promise<UserProfileResponse> {
    const input = this.parseConfirmation(dto);
    if (!input) {
      throw invalidConfirmation();
    }

    const result = await this.runTransaction(async (manager) => {
      const user = await this.lockUser(manager, userId);

      if (!user) {
        return { status: "inactive" as const };
      }

      const challenge = await manager.findOne(EmailChangeChallenge, {
        where: { id: input.challengeId, userId },
        lock: { mode: "pessimistic_write" },
      });

      if (!challenge || challenge.method !== input.method) {
        return { status: "invalid" as const };
      }
      if (challenge.consumedAt) {
        return {
          status: "consumed" as const,
          reason: challenge.consumedReason,
          challengeId: challenge.id,
        };
      }

      const now = new Date();
      if (isExpired(challenge.lastSentAt)) {
        return { status: "expired" as const, challengeId: challenge.id };
      }

      if (user.status !== "active") {
        await manager.update(EmailChangeChallenge, challenge.id, {
          consumedAt: now,
          consumedReason: "user_inactive",
        });
        return { status: "inactive" as const };
      }

      const matches = secretMatches(
        this.hmacKey(),
        input.secret,
        challenge.secretHash,
      );

      if (!matches) {
        if (challenge.method === "magic_link") {
          return { status: "wrong" as const, challengeId: challenge.id };
        }

        const attempts = challenge.attempts + 1;
        const exhausted = attempts >= CONFIRMATION_MAX_ATTEMPTS;
        await manager.update(EmailChangeChallenge, challenge.id, {
          attempts,
          ...(exhausted && {
            consumedAt: now,
            consumedReason: "attempts_exhausted" as const,
          }),
        });
        if (exhausted) {
          return {
            status: "exhausted_now" as const,
            challengeId: challenge.id,
            attempts,
          };
        }
        return { status: "wrong" as const, challengeId: challenge.id, attempts };
      }

      await manager.query("SAVEPOINT email_change_update");
      try {
        await manager.update(
          User,
          { id: userId },
          { email: challenge.newEmail, updatedAt: now },
        );
        await manager.query("RELEASE SAVEPOINT email_change_update");
      } catch (error) {
        if (!isEmailConflict(error)) {
          throw error;
        }
        await manager.query("ROLLBACK TO SAVEPOINT email_change_update");
        await manager.update(EmailChangeChallenge, challenge.id, {
          consumedAt: now,
          consumedReason: "email_conflict",
        });
        return { status: "email_conflict" as const, challengeId: challenge.id };
      }

      await manager.update(EmailChangeChallenge, challenge.id, {
        consumedAt: now,
        consumedReason: "confirmed",
      });

      const updated = await manager.findOneOrFail(User, {
        where: { id: userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          photoKey: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return {
        status: "confirmed" as const,
        challengeId: challenge.id,
        user: updated,
      };
    });

    if (result.status === "inactive") {
      this.logger.warn(
        `Email change confirm rejected reason=user_inactive userId=${userId} challengeId=${input.challengeId}`,
      );
      throw invalidSession();
    }
    if (result.status === "invalid") {
      this.logger.warn(
        `Email change confirm rejected reason=not_found userId=${userId} challengeId=${input.challengeId} method=${input.method}`,
      );
      throw invalidChallenge();
    }
    if (result.status === "consumed") {
      this.logger.warn(
        `Email change confirm rejected reason=${result.reason} userId=${userId} challengeId=${result.challengeId}`,
      );
      throw consumedChallenge(result.reason);
    }
    if (result.status === "expired") {
      this.logger.warn(
        `Email change confirm rejected reason=expired userId=${userId} challengeId=${result.challengeId}`,
      );
      throw challengeExpired();
    }
    if (result.status === "wrong") {
      this.logger.warn(
        `Email change confirm rejected reason=invalid_secret userId=${userId} challengeId=${result.challengeId} method=${input.method}` +
          ("attempts" in result ? ` attempts=${result.attempts}` : ""),
      );
      throw invalidCode();
    }
    if (result.status === "exhausted_now") {
      this.logger.warn(
        `Email change confirm rejected reason=attempts_exhausted userId=${userId} challengeId=${result.challengeId} attempts=${result.attempts}`,
      );
      throw lastAttemptFailed();
    }
    if (result.status === "email_conflict") {
      this.logger.warn(
        `Email change confirm rejected reason=email_conflict userId=${userId} challengeId=${result.challengeId}`,
      );
      throw consumedChallenge("email_conflict");
    }

    return this.toProfile({ ...result.user });
  }

  private confirmationResponse(
    challengeId: string,
    method: ConfirmationMethod,
  ): EmailChangeChallengeResponse {
    return {
      confirmationRequired: true,
      method,
      challengeId,
      expiresInSeconds: CONFIRMATION_TTL_SECONDS,
      resendAfterSeconds: CONFIRMATION_RESEND_AFTER_SECONDS,
    };
  }

  private hmacKey() {
    return this.config.getOrThrow<string>("EMAIL_CHANGE_HMAC_KEY");
  }

  private errorCode(error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : "unknown";
  }

  private async runTransaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ) {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(
        `Email change challenge transaction failed: ${(error as Error).message}`,
      );
      throw usersUnavailable();
    }
  }

  private async send(
    email: string,
    challenge: EmailChangeChallenge,
    secret: string,
  ) {
    if (challenge.method === "otp") {
      await this.mailService.sendEmailChangeOtp(email, secret);
      return;
    }
    const origin = this.config.getOrThrow<string>("FRONTEND_ORIGIN");
    const link = `${origin}/users/${challenge.userId}/email-change/confirm#token=${challenge.id}.${secret}`;
    await this.mailService.sendEmailChangeMagicLink(email, link);
  }

  private lockUser(manager: EntityManager, userId: string) {
    return manager.findOne(User, {
      where: { id: userId },
      select: { id: true, email: true, status: true },
      lock: { mode: "pessimistic_write" },
    });
  }

  private parseConfirmation(dto: EmailChangeConfirmDto) {
    if (dto.token !== undefined) {
      const match = CONFIRMATION_LINK_TOKEN_PATTERN.exec(dto.token);
      return match
        ? {
            challengeId: match[1],
            secret: match[2],
            method: "magic_link" as const,
          }
        : null;
    }
    return {
      challengeId: dto.challengeId!,
      secret: dto.code!,
      method: "otp" as const,
    };
  }

  private toProfile(user: User) {
    return toUserProfile(
      user,
      this.configService.getOrThrow<string>("PUBLIC_API_BASE_URL"),
    );
  }
}