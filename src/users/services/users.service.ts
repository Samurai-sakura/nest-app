import {
  BadRequestException, ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { User } from "../entities/user.entity";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, FindOptionsSelect, IsNull, QueryFailedError, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { STATUSES_WITHOUT_PHOTO, toUserProfile } from "../helpers/user-profile";
import type { UserProfileResponse } from "../dto/user-profile.dto";
import { PHOTO_STORAGE } from "../../storage/photo-storage";
import type { PhotoStorage } from "../../storage/photo-storage";
import type { Readable } from "stream";
import { isDatabaseUnavailable } from "../../common/errors/database-unavailable";
import { UpdateUserDto } from "../dto/update-user.dto";
import { ensureActiveManager, lockPolicy } from "../../access-control/rbac/helpers/policy-lock";
import { LoginChallenge } from "../../identity/authentication/entities/login-challenge.entity";
import { EmailChangeChallenge } from "../entities/email-change-challenge.entity";

const USERS_EMAIL_UNIQUE = "UQ_97672ac88f789774dd47f7c8be3";

function isEmailConflict(error: unknown) {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as { code?: string; constraint?: string };
  return driverError.code === "23505" && driverError.constraint === USERS_EMAIL_UNIQUE;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @Inject(PHOTO_STORAGE)
    private readonly photoStorage: PhotoStorage,
    private readonly configService: ConfigService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  public async findProfile(userId: string): Promise<UserProfileResponse> {
    const user = await this.findUser(userId, {
      id: true,
      email: true,
      displayName: true,
      photoKey: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    });

    if (!user) {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        code: "user_not_found",
        message: "User not found",
      });
    }

    return this.toProfile(user);
  }

  private toProfile(user: User) {
    return toUserProfile(
      user,
      this.configService.getOrThrow<string>("PUBLIC_API_BASE_URL"),
    );
  }

  public async findPhoto(
    userId: string,
  ): Promise<{ stream: Readable; size: number }> {
    const user = await this.findUser(userId, {
      id: true,
      status: true,
      photoKey: true,
    });

    if (
      !user ||
      !user.photoKey ||
      STATUSES_WITHOUT_PHOTO.includes(user.status)
    ) {
      throw new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        code: "photo_not_found",
        message: "Photo not found",
      });
    }

    const result = await this.photoStorage.read(user.photoKey);

    if (result.status === "found") {
      return { stream: result.stream, size: result.size };
    }

    if (result.status === "not_found") {
      this.logger.error(
        `Photo inconsistent reason=object_missing userId=${userId}`,
      );
    } else {
      this.logger.error(
        `Photo unavailable reason=storage_unavailable userId=${userId}`,
      );
    }
    throw new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: "photo_unavailable",
      message: "Photo is temporarily unavailable",
    });
  }

  private async findUser(userId: string, select: FindOptionsSelect<User>) {
    try {
      return await this.userRepository.findOne({
        where: { id: userId },
        select,
      });
    } catch (error) {
      if (!isDatabaseUnavailable(error)) {
        throw error;
      }
      this.logger.error(
        `User data unavailable reason=database userId=${userId}`,
      );
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "users_unavailable",
        message: "User data is temporarily unavailable",
      });
    }
  }

  public async updateUserProfile(userId: string, update: UpdateUserDto): Promise<UserProfileResponse> {
    if (update.displayName === undefined && update.email === undefined && update.status === undefined) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: "empty_update",
        message: "At least one field is required",
      });
    }

    let transition: string | undefined;

    try {
      const profile = await this.dataSource.transaction(async (manager) => {
        if (update.status === "blocked") {
          await lockPolicy(manager);
        }

        const user = await manager.findOne(User, {
          where: { id: userId },
          lock: { mode: "pessimistic_write" },
        });

        if (!user) {
          throw new NotFoundException({
            statusCode: HttpStatus.NOT_FOUND,
            code: "user_not_found",
            message: "User not found",
          })
        }

        if (user.status !== 'active' && user.status !== "blocked") {
          throw new ConflictException({
            statusCode: HttpStatus.CONFLICT,
            code: "user_state_conflict",
            message: "User cannot be changed in its current state",
          });
        }

        const changes: Partial<Pick<User, "displayName" | "email" | "status">> = {};
        if (update.displayName !== undefined && update.displayName !== user.displayName) {
          changes.displayName = update.displayName;
        }
        if (update.email !== undefined && update.email !== user.email) {
          changes.email = update.email;
        }
        if (update.status !== undefined && update.status !== user.status) {
          changes.status = update.status;
          transition = `${user.status}->${update.status}`;
        }

        if (Object.keys(changes).length === 0) {
          return this.toProfile(user);
        }

        const updatedAt = new Date();
        await manager.update(
          User,
          { id: userId },
          { ...changes, updatedAt },
        );

        if (changes.email) {
          await manager.update(
            EmailChangeChallenge,
            { userId, consumedAt: IsNull() },
            { consumedAt: updatedAt, consumedReason: "admin_override" },
          );
        }

        if (changes.status === "blocked") {
          await ensureActiveManager(manager);
          await manager.update(
            LoginChallenge,
            { userId, consumedAt: IsNull() },
            { consumedAt: updatedAt, consumedReason: "user_inactive" },
          );

          await manager.update(
            EmailChangeChallenge,
            { userId, consumedAt: IsNull() },
            { consumedAt: updatedAt, consumedReason: "user_inactive" },
          );
        }

        return this.toProfile({ ...user, ...changes, updatedAt });

      });

      if (transition) {
        this.logger.log(`User status changed transition=${transition} userId=${userId}`);
      }
      return profile;
    } catch (error) {
      if (isEmailConflict(error)) {
        this.logger.warn(`User update rejected reason=email_conflict userId=${userId}`);
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          code: "email_taken",
          message: "Email is already in use",
        });
      }
      if (!isDatabaseUnavailable(error)) {
        throw error;
      }
      this.logger.error(
        `User data unavailable reason=database userId=${userId}`,
      );
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "users_unavailable",
        message: "User data is temporarily unavailable",
      });
    }
  }
}