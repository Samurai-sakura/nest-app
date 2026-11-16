import { applyDecorators, SetMetadata } from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { ErrorResponse } from "../../auth/dto/auth-responses.dto";
import { ACCESS_COOKIE } from "../../auth/helpers/auth-cookies";
import { PERMISSION_KEY, RequiredPermission } from "../route-declaration";

interface RequirePermissionOptions {
  audit?: boolean;
}

export const RequirePermission = (
  permission: string,
  action: string,
  options: RequirePermissionOptions = {},
) =>
  applyDecorators(
    SetMetadata(PERMISSION_KEY, {
      permission,
      action,
      ...(options.audit && { audit: true }),
    } satisfies RequiredPermission),
    ApiCookieAuth(ACCESS_COOKIE),
    ApiUnauthorizedResponse({
      description: "invalid_session: access отсутствует, невалиден, истёк или пользователь не активен",
      type: ErrorResponse,
    }),
    ApiForbiddenResponse({
      description: "permission_denied: у пользователя нет права; csrf_rejected: изменение из другого origin без CSRF-заголовка",
      type: ErrorResponse,
    }),
    ApiServiceUnavailableResponse({
      description: "authorization_unavailable: пользователи или политика RBAC временно недоступны",
      type: ErrorResponse,
    }),
  );
