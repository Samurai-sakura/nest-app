import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  Res,
  StreamableFile,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import type { RawBodyRequest } from "@nestjs/common";
import type { Response, Request } from "express";
import { UsersService } from "../services/users.service";
import { ProfileReadLimiter } from "../services/profile-read-limiter.service";
import { RequirePermission } from "../../access-control/authorization/decorators/require-permission.decorator";
import { CurrentUserId } from "../../access-control/authorization/decorators/current-user-id.decorator";
import { AccessControlService } from "../../access-control/authorization/services/access-control.service";
import { ErrorResponse } from "../../common/dto/error-response.dto";
import { UserProfileResponse } from "../dto/user-profile.dto";
import { UsersAuditInterceptor } from "../helpers/users-audit.interceptor";
import { UpdateUserDto } from "../dto/update-user.dto";
import { ProfileUpdateLimiter } from "../services/profile-update-limiter.service";
import { checkAllowedFields } from "../helpers/allowed-fields";
import { assertNoDuplicateKeys } from "../../common/duplicate-json-keys";

@ApiTags("Users")
@UseInterceptors(UsersAuditInterceptor)
@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accessControl: AccessControlService,
    private readonly readLimiter: ProfileReadLimiter,
    private readonly profileUpdateLimiter: ProfileUpdateLimiter,
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

  @Patch(":userId")
  @ApiOperation({
    summary: "Изменение профиля",
    description:
      "Self с users@update меняет только displayName. Чужой профиль, а также email и status даже у себя требуют ещё users@update_any; оба права проверяются до поиска пользователя. Тело содержит от одного до трёх полей из displayName, email, status; повтор ключа, пустое тело и любые другие поля дают 400. Совпадающие после нормализации значения — успешный no-op без изменения updatedAt. Не больше 30 изменений в час на пользователя.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiOkResponse({
    description: "Обновлённый профиль из семи полей",
    type: UserProfileResponse,
  })
  @ApiBadRequestResponse({
    description:
      "userId не является UUID; invalid_body: тело не JSON-объект; empty_update: пустое тело; unknown_field: поле вне displayName, email, status; duplicate_field: повтор ключа; validation_failed: неверные displayName, email или status",
    type: ErrorResponse,
  })
  @ApiForbiddenResponse({
    description:
      "permission_denied: нет users@update, либо чужой профиль, email или status без users@update_any; csrf_rejected: изменение из другого origin без CSRF-заголовка",
    type: ErrorResponse,
  })
  @ApiNotFoundResponse({
    description: "user_not_found: пользователь не найден; возможен только после всех проверок прав",
    type: ErrorResponse,
  })
  @ApiConflictResponse({
    description:
      "email_taken: email занят другим пользователем; user_state_conflict: статус цели pending, deleting или deleted; last_rbac_manager: блокировка оставила бы систему без активного пользователя с rbac@manage",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "rate_limited: больше 30 изменений профиля в час",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "users_unavailable: база пользователей недоступна; authorization_unavailable: пользователи или политика RBAC временно недоступны",
    type: ErrorResponse,
  })
  @RequirePermission("users", "update")
  public async updateProfile(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
    @Body() updateData: UpdateUserDto,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<UserProfileResponse> {
    assertNoDuplicateKeys(req.rawBody);
    checkAllowedFields(req.body);

    this.profileUpdateLimiter.consume(currentUserId);

    const privileged = updateData.email !== undefined || updateData.status !== undefined;

    if (userId !== currentUserId || privileged) {
      await this.accessControl.requirePermission(
        currentUserId,
        "users",
        "update_any",
      );
    }

    return await this.usersService.updateUserProfile(userId, updateData);
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
