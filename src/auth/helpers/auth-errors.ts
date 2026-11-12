import { HttpStatus, UnauthorizedException } from "@nestjs/common";

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
