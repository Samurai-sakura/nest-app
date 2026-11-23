import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";

export function invalidConfirmation() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "invalid_confirmation",
    message: "Invalid or expired confirmation code",
  });
}

export function attemptsExhausted() {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: "attempts_exhausted",
      message: "Too many attempts",
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function resendTooEarly(wait: number) {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: "resend_too_early",
      message: `Email can be requested again in ${wait} seconds`,
      retryAfterSeconds: wait,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function emailDeliveryFailed(details: Record<string, unknown> = {}) {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: "email_delivery_failed",
    message: "Failed to send confirmation email",
    ...details,
  });
}
