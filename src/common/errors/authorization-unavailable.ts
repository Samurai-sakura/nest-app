import { HttpStatus, ServiceUnavailableException } from "@nestjs/common";

export function authorizationUnavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: "authorization_unavailable",
    message: "Authorization is temporarily unavailable",
  });
}
