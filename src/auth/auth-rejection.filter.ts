import { ArgumentsHost, BadRequestException, Catch, Logger } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { ThrottlerException } from "@nestjs/throttler";
import type { Request } from "express";

@Catch(BadRequestException, ThrottlerException)
export class AuthRejectionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AuthRejectionFilter.name);

  public catch(
    exception: BadRequestException | ThrottlerException,
    host: ArgumentsHost,
  ) {
    const { method, path } = host.switchToHttp().getRequest<Request>();

    if (exception instanceof ThrottlerException) {
      this.logger.warn(`Request rejected reason=rate_limit route=${method} ${path}`);
    } else {
      const { message } = exception.getResponse() as {
        message: string | string[];
      };
      if (Array.isArray(message)) {
        this.logger.warn(
          `Request rejected reason=validation route=${method} ${path} details=${message.join("; ")}`,
        );
      }
    }

    super.catch(exception, host);
  }
}
