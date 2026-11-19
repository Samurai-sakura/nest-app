import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Res,
  StreamableFile,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import type { Response } from "express";
import { UsersService } from "../services/users.service";
import { ProfileReadLimiter } from "../services/profile-read-limiter.service";
import { RequirePermission } from "../../access-control/authorization/decorators/require-permission.decorator";
import { CurrentUserId } from "../../access-control/authorization/decorators/current-user-id.decorator";
import { AccessControlService } from "../../access-control/authorization/services/access-control.service";
import { ErrorResponse } from "../../common/dto/error-response.dto";
import { UserProfileResponse } from "../dto/user-profile.dto";
import { UsersAuditInterceptor } from "../helpers/users-audit.interceptor";

@ApiTags("Users")
@UseInterceptors(UsersAuditInterceptor)
@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accessControl: AccessControlService,
    private readonly readLimiter: ProfileReadLimiter,
  ) {}

  @Get(":userId")
  @ApiOperation({
    summary: "Профиль пользователя",
    description:
      "Свой профиль требует users@read, чужой — ещё и users@read_any. Оба права проверяются до поиска пользователя, поэтому без них ответ 403 одинаков для существующего и вымышленного id.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiOkResponse({
    description: "Профиль из семи полей",
    type: UserProfileResponse,
  })
  @ApiBadRequestResponse({
    description: "userId не является UUID",
    type: ErrorResponse,
  })
  @ApiNotFoundResponse({
    description:
      "Пользователь не найден; возможен только после всех проверок прав",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "rate_limited: больше 120 запросов в минуту к своему профилю и фото или 60 к чужим",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description: "users_unavailable: база пользователей недоступна",
    type: ErrorResponse,
  })
  @RequirePermission("users", "read")
  public async getUser(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
  ): Promise<UserProfileResponse> {
    await this.ensureCanRead(currentUserId, userId);

    return await this.usersService.findProfile(userId);
  }

  @Get(":userId/photo")
  @ApiOperation({
    summary: "Фотография профиля",
    description:
      "Те же права, что у профиля: users@read, для чужого id ещё users@read_any, обе проверки до поиска. Отдаёт нормализованный WebP потоком; ключ и путь хранилища в ответ не попадают.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiProduces("image/webp")
  @ApiOkResponse({
    description: "Байты WebP; заголовки X-Content-Type-Options: nosniff и Cache-Control: private, max-age=300",
    schema: { type: "string", format: "binary" },
  })
  @ApiBadRequestResponse({
    description: "userId не является UUID",
    type: ErrorResponse,
  })
  @ApiNotFoundResponse({
    description:
      "photo_not_found: пользователя нет, фото не задано или статус deleting / deleted; возможен только после всех проверок прав",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "rate_limited: больше 120 запросов в минуту к своему профилю и фото или 60 к чужим",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "photo_unavailable: хранилище недоступно или объект по ключу из профиля пропал; users_unavailable: база пользователей недоступна",
    type: ErrorResponse,
  })
  @RequirePermission("users", "read")
  public async getPhoto(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    await this.ensureCanRead(
      currentUserId,
      userId,
    );
    const photo = await this.usersService.findPhoto(userId);

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=300");
    return new StreamableFile(photo.stream, {
      type: "image/webp",
      length: photo.size,
    });
  }

  private async ensureCanRead(actorUserId: string, userId: string) {
    this.readLimiter.consume(actorUserId, userId === actorUserId ? "self" : "foreign");
    if (userId !== actorUserId) {
      await this.accessControl.requirePermission(
        actorUserId,
        "users",
        "read_any",
      );
    }
  }
}
