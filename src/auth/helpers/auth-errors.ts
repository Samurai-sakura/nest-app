import {
  ForbiddenException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

// одинаковый ответ для неизвестного email, неверного пароля и неактивного пользователя
export function invalidCredentials() {
  return new UnauthorizedException({
    statusCode: HttpStatus.UNAUTHORIZED,
    code: "invalid_credentials",
    message: "Invalid email or password",
  });
}

// наружу не сообщается, какая проверка токена или пользователя не прошла
export function invalidSession() {
  return new UnauthorizedException({
    statusCode: HttpStatus.UNAUTHORIZED,
    code: "invalid_session",
    message: "Session is invalid or expired",
  });
}

// решение нельзя принять безопасно: наружу не сообщается, какая зависимость недоступна
export function authorizationUnavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: "authorization_unavailable",
    message: "Authorization is temporarily unavailable",
  });
}

// личность установлена, но права нет; одинаково для существующего и вымышленного ресурса
export function permissionDenied() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code: "permission_denied",
    message: "Permission denied",
  });
}

// право на операцию есть, но запись принадлежит другому пользователю
export function ownershipDenied() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code: "ownership_denied",
    message: "Access to this resource is denied",
  });
}
