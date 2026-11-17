import { HttpStatus, ServiceUnavailableException } from "@nestjs/common";

// решение нельзя принять безопасно: наружу не сообщается, какая зависимость недоступна
export function authorizationUnavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: "authorization_unavailable",
    message: "Authorization is temporarily unavailable",
  });
}
