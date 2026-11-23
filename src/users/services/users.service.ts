import { HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { User } from "../entities/user.entity";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, FindOptionsSelect, IsNull, Repository } from "typeorm";
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
import { isEmailConflict } from "../helpers/email-conflict";
import {
  emailTaken,
  emptyUpdate,
  invalidPhoto,
  photoNotFound,
  photoUnavailable,
  unsupportedPhotoType,
  userNotFound,
  usersUnavailable,
  userStateConflict,
} from "../helpers/users-errors";
import { normalizePhoto } from "../helpers/photo-normalizer";
import { randomBytes } from "crypto";
import {
  StorageCleanupJob,
  type StorageCleanupReason,
} from "../../storage/entities/storage-cleanup-job.entity";

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
      throw userNotFound();
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
      throw photoNotFound();
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
    throw photoUnavailable();
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
      throw usersUnavailable();
    }
  }

  public async updateUserProfile(
    userId: string,
    update: UpdateUserDto,
  ): Promise<UserProfileResponse> {
    if (
      update.displayName === undefined &&
      update.email === undefined &&
      update.status === undefined
    ) {
      throw emptyUpdate();
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
          throw userNotFound();
        }

        if (user.status !== "active" && user.status !== "blocked") {
          throw userStateConflict();
        }

        const changes: Partial<Pick<User, "displayName" | "email" | "status">> =
          {};
        if (
          update.displayName !== undefined &&
          update.displayName !== user.displayName
        ) {
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
        await manager.update(User, { id: userId }, { ...changes, updatedAt });

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
        this.logger.log(
          `User status changed transition=${transition} userId=${userId}`,
        );
      }
      return profile;
    } catch (error) {
      if (isEmailConflict(error)) {
        this.logger.warn(
          `User update rejected reason=email_conflict userId=${userId}`,
        );
        throw emailTaken();
      }
      if (!isDatabaseUnavailable(error)) {
        throw error;
      }
      this.logger.error(
        `User data unavailable reason=database userId=${userId}`,
      );
      throw usersUnavailable();
    }
  }

  public async replacePhoto(
    userId: string,
    data: Buffer,
    declaredMime: string,
  ): Promise<UserProfileResponse> {
    const photo = await normalizePhoto(data, declaredMime);

    if (photo.status === "unsupported") {
      this.logger.warn(
        `Photo rejected reason=unsupported_type userId=${userId}`,
      );
      throw unsupportedPhotoType();
    }
    if (photo.status === "invalid") {
      this.logger.warn(
        `Photo rejected reason=${photo.reason} userId=${userId}`,
      );
      throw invalidPhoto();
    }
    const key = randomBytes(16).toString("base64url");
    const written = await this.photoStorage.write(key, photo.data);
    if (written.status !== "written") {
      this.logger.error(
        `Photo upload failed reason=storage_unavailable userId=${userId}`,
      );
      throw photoUnavailable();
    }

    try {
      const { profile, jobId } = await this.dataSource.transaction(async (manager) => {
        const user = await manager.findOne(User, {
          where: { id: userId },
          lock: { mode: "pessimistic_write" },
        });
        if (!user) {
          throw userNotFound();
        }
        if (user.status !== "active" && user.status !== "blocked") {
          throw userStateConflict();
        }

        const updatedAt = new Date();
        await manager.update(User, { id: userId }, { photoKey: key, updatedAt });
        const jobId = user.photoKey
          ? await this.queueCleanup(manager, user.photoKey, "photo_replaced")
          : null;
        return {
          profile: this.toProfile({ ...user, photoKey: key, updatedAt }),
          jobId,
        };
      });

      this.logger.log(`User photo ${jobId ? "replaced" : "uploaded"} userId=${userId}`);
      this.logCleanupQueued(jobId, "photo_replaced");
      return profile;
    } catch (error) {
      await this.photoStorage.delete(key);
      if (error instanceof HttpException || !isDatabaseUnavailable(error)) {
        throw error;
      }
      this.logger.error(
        `User data unavailable reason=database userId=${userId}`,
      );
      throw usersUnavailable();
    }
  }

  public async deletePhoto(userId: string): Promise<void> {
    try {
      const jobId = await this.dataSource.transaction(async (manager) => {
        const user = await manager.findOne(User, {
          where: { id: userId },
          select: { id: true, photoKey: true, status: true },
          lock: { mode: "pessimistic_write" },
        });

        if (!user) {
          throw userNotFound();
        }
        if (user.status !== "active" && user.status !== "blocked") {
          throw userStateConflict();
        }
        if (user.photoKey === null) {
          return null;
        }

        await manager.update(User, { id: userId }, { photoKey: null, updatedAt: new Date() });
        return this.queueCleanup(manager, user.photoKey, "photo_cleared");
      });

      this.logger.log(
        `User photo ${jobId ? "cleared" : "clear skipped reason=no_photo"} userId=${userId}`,
      );
      this.logCleanupQueued(jobId, "photo_cleared");
    } catch (error) {
      if (error instanceof HttpException || !isDatabaseUnavailable(error)) {
        throw error;
      }
      this.logger.error(
        `User data unavailable reason=database userId=${userId}`,
      );
      throw usersUnavailable();
    }
  }

  private async queueCleanup(
    manager: EntityManager,
    objectKey: string,
    reason: StorageCleanupReason,
  ): Promise<string> {
    const { identifiers } = await manager.insert(StorageCleanupJob, { objectKey, reason });
    return identifiers[0].id as string;
  }

  private logCleanupQueued(jobId: string | null, reason: StorageCleanupReason) {
    if (jobId) {
      this.logger.log(`Storage cleanup queued jobId=${jobId} reason=${reason}`);
    }
  }
}
