import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
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
import { EmailChangeDto } from "../dto/email-change.dto";
import { EmailChangeService } from "../services/email-change.service";
import { EmailChangeChallengeResponse } from "../dto/email-change-responses.dto";
import { permissionDenied } from "../../access-control/authorization/helpers/authorization-errors";
import { EmailChangeResendDto } from "../dto/email-change-resend.dto";
import { EmailChangeConfirmDto } from "../dto/email-change-confirm.dto";
import { UpdatePhotoDto } from "../dto/update-photo.dto";
import { photoRequired } from "../helpers/users-errors";
import { FileInterceptor } from "@nestjs/platform-express";
import { PHOTO_MAX_UPLOAD_BYTES } from "../helpers/photo-normalizer";
import { EMAIL_CHANGE_CONFIRM_PAGE_HTML } from "../helpers/email-change-confirm-page";
import { Public } from "../../access-control/authorization/decorators/public.decorator";

@ApiTags("Users")
@UseInterceptors(UsersAuditInterceptor)
@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accessControl: AccessControlService,
    private readonly readLimiter: ProfileReadLimiter,
    private readonly profileUpdateLimiter: ProfileUpdateLimiter,
    private readonly emailChangeService: EmailChangeService,
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
    description:
      "rate_limited: больше 120 запросов в минуту к своему профилю и фото или 60 к чужим",
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
    description:
      "Байты WebP; заголовки X-Content-Type-Options: nosniff и Cache-Control: private, max-age=300",
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
    description:
      "rate_limited: больше 120 запросов в минуту к своему профилю и фото или 60 к чужим",
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
    await this.ensureCanRead(currentUserId, userId);
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
    description:
      "user_not_found: пользователь не найден; возможен только после всех проверок прав",
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

    const privileged =
      updateData.email !== undefined || updateData.status !== undefined;

    if (userId !== currentUserId || privileged) {
      await this.accessControl.requirePermission(
        currentUserId,
        "users",
        "update_any",
      );
    }

    return await this.usersService.updateUserProfile(userId, updateData);
  }

  @Post(":userId/email-change")
  @HttpCode(202)
  @ApiOperation({
    summary: "Запрос смены email",
    description:
      "Только Self с users@update: чужой userId даёт 403 до поиска пользователя, администратор меняет email через PATCH. Сервер отправляет OTP или magic link на новый адрес по EMAIL_CHANGE_METHOD; email меняется только после confirm с той же сессией. Повторный запрос не раньше чем через 60 секунд заменяет прежний challenge. Не больше 5 писем в час.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiAcceptedResponse({
    description: "Письмо отправлено; код или ссылка действуют 10 минут",
    type: EmailChangeChallengeResponse,
  })
  @ApiBadRequestResponse({
    description:
      "userId не является UUID; validation_failed: newEmail отсутствует, неверного формата или длиннее 255 символов",
    type: ErrorResponse,
  })
  @ApiForbiddenResponse({
    description:
      "permission_denied: нет users@update или userId не совпадает с текущим пользователем; csrf_rejected: изменение из другого origin без CSRF-заголовка",
    type: ErrorResponse,
  })
  @ApiConflictResponse({
    description:
      "email_taken: адрес занят другим пользователем; email_unchanged: адрес совпадает с текущим",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description:
      "resend_too_early: прошло меньше 60 секунд с прошлого письма; rate_limited: больше 5 писем в час. Тело содержит retryAfterSeconds",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "email_delivery_failed: challenge сохранён, но письмо не ушло, тело содержит confirmationRequired, method, challengeId и retryAfterSeconds, повтор через resend; users_unavailable: база недоступна, состояние не изменено",
    type: ErrorResponse,
  })
  @RequirePermission("users", "update")
  public async updateUserEmail(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
    @Body() updateData: EmailChangeDto,
  ): Promise<EmailChangeChallengeResponse> {
    if (userId !== currentUserId) {
      throw permissionDenied();
    }
    return await this.emailChangeService.start(userId, updateData.newEmail);
  }

  @Post(":userId/email-change/resend")
  @HttpCode(202)
  @ApiOperation({
    summary: "Повторная отправка письма смены email",
    description:
      "Только Self с users@update: чужой userId даёт 403 до поиска пользователя. Не раньше чем через 60 секунд после прошлого письма; способ и новый адрес не меняются, новый код или ссылка заменяет прежний, продлевает срок на 10 минут и обнуляет счётчик вводов. Не больше 5 писем в час вместе с запросом смены email.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiAcceptedResponse({
    description: "Письмо отправлено; код или ссылка действуют 10 минут",
    type: EmailChangeChallengeResponse,
  })
  @ApiBadRequestResponse({
    description:
      "userId не является UUID; validation_failed: challengeId не UUID; invalid_challenge: challenge не найден, заменён, уже подтверждён или погашен из-за неактивного пользователя",
    type: ErrorResponse,
  })
  @ApiForbiddenResponse({
    description:
      "permission_denied: нет users@update или userId не совпадает с текущим пользователем; csrf_rejected: изменение из другого origin без CSRF-заголовка",
    type: ErrorResponse,
  })
  @ApiConflictResponse({
    description:
      "admin_override: email изменён администратором; email_conflict: новый адрес занял другой пользователь",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description:
      "resend_too_early: прошло меньше 60 секунд с прошлого письма; rate_limited: больше 5 писем в час, тело содержит retryAfterSeconds; attempts_exhausted: код введён неверно 5 раз, нужен новый запрос смены email",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "email_delivery_failed: новый секрет сохранён, но письмо не ушло, тело содержит confirmationRequired, method, challengeId и retryAfterSeconds, повтор через resend; users_unavailable: база недоступна, состояние не изменено",
    type: ErrorResponse,
  })
  @RequirePermission("users", "update")
  public async resend(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
    @Body() dto: EmailChangeResendDto,
  ): Promise<EmailChangeChallengeResponse> {
    if (userId !== currentUserId) {
      throw permissionDenied();
    }
    return await this.emailChangeService.resend(userId, dto.challengeId);
  }

  @Post(":userId/email-change/confirm")
  @HttpCode(200)
  @ApiOperation({
    summary: "Подтверждение смены email",
    description:
      "Только Self с users@update и той же активной сессией. Тело содержит ровно один вариант: challengeId и code из 6 цифр для OTP либо token из фрагмента ссылки для magic link. Код или ссылка действуют 10 минут с последней отправки. Пятый неверный код гасит challenge, следующий запрос получает 429. При успехе email меняется атомарно, challenge гасится.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiOkResponse({
    description: "Профиль из семи полей с новым email",
    type: UserProfileResponse,
  })
  @ApiBadRequestResponse({
    description:
      "userId не является UUID; validation_failed: тело не содержит ровно один вариант или поля неверного формата; invalid_challenge: challenge не найден, другого способа, заменён, уже подтверждён или погашен из-за неактивного пользователя; challenge_expired: прошло больше 10 минут; invalid_code: неверный код или ссылка; attempts_exhausted: пятый неверный код",
    type: ErrorResponse,
  })
  @ApiUnauthorizedResponse({
    description:
      "invalid_session: access отсутствует или невалиден, либо пользователь перестал быть активным до подтверждения",
    type: ErrorResponse,
  })
  @ApiForbiddenResponse({
    description:
      "permission_denied: нет users@update или userId не совпадает с текущим пользователем; csrf_rejected: изменение из другого origin без CSRF-заголовка",
    type: ErrorResponse,
  })
  @ApiConflictResponse({
    description:
      "admin_override: email изменён администратором; email_conflict: новый адрес уже занят, challenge погашен",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description:
      "attempts_exhausted: код уже введён неверно 5 раз, нужен новый запрос смены email",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "users_unavailable: база недоступна, изменения откатаны, challenge можно подтвердить снова",
    type: ErrorResponse,
  })
  @RequirePermission("users", "update")
  public async confirm(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
    @Body() dto: EmailChangeConfirmDto,
  ): Promise<UserProfileResponse> {
    if (userId !== currentUserId) {
      throw permissionDenied();
    }

    return await this.emailChangeService.confirm(userId, dto);
  }

  @Put(":userId/photo")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: PHOTO_MAX_UPLOAD_BYTES,
        files: 1,
        fields: 0,
        parts: 1,
      },
    }),
  )
  @ApiOperation({
    summary: "Загрузка фотографии профиля",
    description:
      "Self с users@update меняет своё фото, чужое требует ещё users@update_any; оба права проверяются до поиска пользователя. Ровно один multipart-файл в поле file: JPEG, PNG или WebP до 5 МиБ, один кадр от 64×64 до 4096×4096. Сервер применяет EXIF-поворот, вписывает изображение в 1024×1024 без увеличения, удаляет метаданные и сохраняет WebP до 2 МиБ под новым непрозрачным ключом. Прежний объект удаляется фоновой очисткой. Не больше 30 изменений профиля и фото в час.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: UpdatePhotoDto })
  @ApiOkResponse({
    description: "Профиль из семи полей с новым photoUrl",
    type: UserProfileResponse,
  })
  @ApiBadRequestResponse({
    description:
      "userId не является UUID; photo_required: нет файла в поле file; bad_request: второй файл, файл в другом поле или лишняя часть multipart; invalid_photo: изображение повреждено, анимировано, меньше 64 или больше 4096 пикселей по стороне либо не укладывается в 2 МиБ после кодирования",
    type: ErrorResponse,
  })
  @ApiForbiddenResponse({
    description:
      "permission_denied: нет users@update или чужой профиль без users@update_any; csrf_rejected: изменение из другого origin без CSRF-заголовка",
    type: ErrorResponse,
  })
  @ApiNotFoundResponse({
    description:
      "user_not_found: пользователь не найден; возможен только после всех проверок прав",
    type: ErrorResponse,
  })
  @ApiConflictResponse({
    description:
      "user_state_conflict: статус цели pending, deleting или deleted",
    type: ErrorResponse,
  })
  @ApiPayloadTooLargeResponse({
    description: "payload_too_large: файл больше 5 МиБ",
    type: ErrorResponse,
  })
  @ApiUnsupportedMediaTypeResponse({
    description:
      "unsupported_media_type: файл не JPEG, PNG или WebP либо заявленный тип не совпадает с содержимым",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "rate_limited: больше 30 изменений профиля и фото в час",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "photo_unavailable: хранилище не приняло файл, профиль не изменён; users_unavailable: база недоступна, профиль не изменён; authorization_unavailable: RBAC временно недоступен",
    type: ErrorResponse,
  })
  @RequirePermission("users", "update")
  public async setPhoto(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<UserProfileResponse> {
    this.profileUpdateLimiter.consume(currentUserId);

    if (userId !== currentUserId) {
      await this.accessControl.requirePermission(
        currentUserId,
        "users",
        "update_any",
      );
    }

    if (!file) {
      throw photoRequired();
    }

    return await this.usersService.replacePhoto(
      userId,
      file.buffer,
      file.mimetype,
    );
  }

  @Delete(":userId/photo")
  @HttpCode(204)
  @ApiOperation({
    summary: "Удаление фотографии профиля",
    description:
      "Self с users@update удаляет своё фото, чужое требует ещё users@update_any; оба права проверяются до поиска пользователя. Ссылка удаляется сразу, объект удаляет фоновая очистка. Если фото не задано, ответ тот же без изменения updatedAt. Не больше 30 изменений профиля и фото в час.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiNoContentResponse({
    description: "Фото удалено или его не было; тела нет",
  })
  @ApiBadRequestResponse({
    description: "userId не является UUID",
    type: ErrorResponse,
  })
  @ApiForbiddenResponse({
    description:
      "permission_denied: нет users@update или чужой профиль без users@update_any; csrf_rejected: изменение из другого origin без CSRF-заголовка",
    type: ErrorResponse,
  })
  @ApiNotFoundResponse({
    description:
      "user_not_found: пользователь не найден; возможен только после всех проверок прав",
    type: ErrorResponse,
  })
  @ApiConflictResponse({
    description:
      "user_state_conflict: статус цели pending, deleting или deleted",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "rate_limited: больше 30 изменений профиля и фото в час",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "users_unavailable: база недоступна, фото не изменено; authorization_unavailable: RBAC временно недоступен. Недоступность хранилища на ответ не влияет",
    type: ErrorResponse,
  })
  @RequirePermission("users", "update")
  public async deletePhoto(
    @Param("userId", ParseUUIDPipe) userId: string,
    @CurrentUserId() currentUserId: string,
  ): Promise<void> {
    this.profileUpdateLimiter.consume(currentUserId);

    if (userId !== currentUserId) {
      await this.accessControl.requirePermission(
        currentUserId,
        "users",
        "update_any",
      );
    }

    await this.usersService.deletePhoto(userId);
  }

  @Public()
  @Get(":userId/email-change/confirm")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiOperation({
    summary: "Страница подтверждения нового email по ссылке из письма",
    description:
      "Открывается по magic link при EMAIL_CHANGE_METHOD=magic_link. Токен передаётся во фрагменте URL и на сервер не уходит; GET состояние не меняет. По нажатию кнопки страница отправляет POST /users/{userId}/email-change/confirm с токеном, cookie действующей сессии того же пользователя и заголовком X-CSRF-Protection.",
  })
  @ApiParam({ name: "userId", format: "uuid" })
  @ApiProduces("text/html")
  @ApiOkResponse({
    description: "HTML-страница с кнопкой подтверждения",
    schema: { type: "string" },
  })
  public async getConfirmPage() {
    return EMAIL_CHANGE_CONFIRM_PAGE_HTML;
  }

  private async ensureCanRead(actorUserId: string, userId: string) {
    this.readLimiter.consume(
      actorUserId,
      userId === actorUserId ? "self" : "foreign",
    );
    if (userId !== actorUserId) {
      await this.accessControl.requirePermission(
        actorUserId,
        "users",
        "read_any",
      );
    }
  }
}
