import { ForbiddenException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";

export const CSRF_HEADER = "x-csrf-protection";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class CsrfPolicy {
  private readonly logger = new Logger(CsrfPolicy.name);

  constructor(private readonly config: ConfigService) {}

  public check(request: Request) {
    const origin = request.headers.origin;

    if (SAFE_METHODS.has(request.method) || origin === undefined) {
      return;
    }
    if (origin === new URL(this.config.getOrThrow<string>("APP_URL")).origin) {
      return;
    }
    if (
      origin === this.config.getOrThrow<string>("FRONTEND_ORIGIN") &&
      request.headers[CSRF_HEADER] === "1"
    ) {
      return;
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
