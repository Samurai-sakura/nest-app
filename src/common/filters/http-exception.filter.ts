import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import type { Request, Response } from "express";

const DEFAULT_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "too_many_requests",
  500: "internal_error",
  503: "service_unavailable",
};

type ErrorBody = Record<string, unknown> & {
  statusCode: number;
  code: string;
  message: unknown;
};

// единый формат ошибки: statusCode, code, message и необязательные поля конкретной операции.
// Отказы ValidationPipe и ThrottlerGuard срабатывают до сервисов, поэтому журналируются здесь.
// path берётся без query: в нём может быть токен
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const route = `${request.method} ${request.path}`;

    if (!(exception instanceof HttpException)) {
      // подробности только в журнале: наружу не уходят ни текст, ни стек
      this.logger.error(
        `Unhandled error route=${route}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
      return response.status(500).json({
        statusCode: 500,
        code: DEFAULT_CODES[500],
        message: "Internal server error",
      });
    }

    const body = this.toBody(exception);

    if (exception instanceof ThrottlerException) {
      body.code = "rate_limited";
      this.logger.warn(`Request rejected reason=rate_limit route=${route}`);
    } else if (body.statusCode === 400 && Array.isArray(body.message)) {
      // массив приходит только от ValidationPipe; значений полей в сообщениях нет
      body.code = "validation_failed";
      this.logger.warn(
        `Request rejected reason=validation route=${route} details=${body.message.join("; ")}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: HttpException): ErrorBody {
    const statusCode = exception.getStatus();
    const raw = exception.getResponse();
    const { error: _error, ...fields } =
      typeof raw === "string" ? { message: raw } : (raw as Record<string, unknown>);
    return {
      ...fields,
      statusCode,
      code: (fields.code as string) ?? DEFAULT_CODES[statusCode] ?? "error",
      message: fields.message ?? HttpStatus[statusCode] ?? "Error",
    };
  }
}
