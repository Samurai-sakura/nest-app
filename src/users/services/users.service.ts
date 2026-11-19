import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { User } from "../entities/user.entity";
import { InjectRepository } from "@nestjs/typeorm";
import { FindOptionsSelect, Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { STATUSES_WITHOUT_PHOTO, toUserProfile } from "../helpers/user-profile";
import type { UserProfileResponse } from "../dto/user-profile.dto";
import { PHOTO_STORAGE } from "../../storage/photo-storage";
import type { PhotoStorage } from "../../storage/photo-storage";
import type { Readable } from "stream";
import { isDatabaseUnavailable } from "../../common/errors/database-unavailable";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @Inject(PHOTO_STORAGE)
    private readonly photoStorage: PhotoStorage,
    private readonly configService: ConfigService,
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
      return await this.userRepository.findOne({ where: { id: userId }, select });
    } catch (error) {
      if (!isDatabaseUnavailable(error)) {
        throw error;
      }
      this.logger.error(`User data unavailable reason=database userId=${userId}`);
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "users_unavailable",
        message: "User data is temporarily unavailable",
      });
    }
  }
}