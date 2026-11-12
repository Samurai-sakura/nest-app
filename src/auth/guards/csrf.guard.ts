import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";

export const CSRF_HEADER = "x-csrf-protection";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// изменяющий запрос из другого origin принимается только от FRONTEND_ORIGIN
// и только с X-CSRF-Protection: 1, даже если оба origin на одном site.
// Запрос без Origin браузер не отправляет кросс-доменно: это curl, тесты или тот же origin
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger(CsrfGuard.name);

  constructor(private readonly config: ConfigService) {}

  public canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.headers.origin;

    if (SAFE_METHODS.has(request.method) || origin === undefined) {
      return true;
    }
    if (origin === new URL(this.config.getOrThrow<string>("APP_URL")).origin) {
      return true;
    }
    if (
      origin === this.config.getOrThrow<string>("FRONTEND_ORIGIN") &&
      request.headers[CSRF_HEADER] === "1"
    ) {
      return true;
    }

    this.logger.warn(
      `Request rejected reason=csrf_rejected route=${request.method} ${request.path} trustedOrigin=${origin === this.config.get("FRONTEND_ORIGIN")}`,
    );
    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      code: "csrf_rejected",
      message: "Cross-origin request rejected",
    });
  }
}
