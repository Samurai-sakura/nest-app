import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, catchError, tap, throwError } from "rxjs";
import type { AuthenticatedRequest } from "../../access-control/authorization/guards/authorization.guard";

const AUDITED_FIELDS = ["displayName", "email", "status"];

interface Operation {
  name: string;
  kind: "read" | "update";
  fields?: string;
}

const OPERATIONS: Record<string, Operation> = {
  getUser: { name: "users.profile", kind: "read" },
  getPhoto: { name: "users.photo", kind: "read" },
  updateProfile: { name: "users.update", kind: "update" },
  setPhoto: { name: "users.photo.update", kind: "update", fields: "photo" },
  deletePhoto: { name: "users.photo.clear", kind: "update", fields: "photo" },
};

const READ_RESULTS: Record<number, { result: string; withTarget: boolean }> = {
  403: { result: "forbidden", withTarget: false },
  429: { result: "rate_limited", withTarget: false },
  404: { result: "not_found", withTarget: true },
  503: { result: "unavailable", withTarget: true },
};

const UPDATE_RESULTS: Record<number, string> = {
  400: "invalid",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  415: "unsupported",
  429: "rate_limited",
  503: "unavailable",
};

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULT_ERROR_CODES: Record<number, string> = {
  400: "validation_failed",
  413: "payload_too_large",
};

@Injectable()
export class UsersAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger("UsersAudit");

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operation = OPERATIONS[context.getHandler().name];
    if (!operation) {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    return operation.kind === "update"
      ? this.auditUpdate(operation, request, next)
      : this.auditRead(operation, request, next);
  }

  private auditRead(
    operation: Operation,
    request: AuthenticatedRequest,
    next: CallHandler,
  ): Observable<unknown> {
    const startedAt = Date.now();
    const targetUserId = request.params?.userId as string;
    const actorUserId = request.userId ?? "unknown";
    const scope = targetUserId === actorUserId ? "self" : "foreign";
    const event = `operation=${operation.name} scope=${scope} actorUserId=${actorUserId}`;
    const duration = () => `durationMs=${Date.now() - startedAt}`;

    return next.handle().pipe(
      tap(() => {
        if (scope === "foreign") {
          this.logger.log(
            `User read result=success ${event} targetUserId=${targetUserId} ${duration()}`,
          );
        }
      }),
      catchError((error: unknown) => {
        const known = error instanceof HttpException ? READ_RESULTS[error.getStatus()] : undefined;
        if (known) {
          const target = known.withTarget ? ` targetUserId=${targetUserId}` : "";
          this.logger.warn(
            `User read result=${known.result} ${event}${target} code=${errorCode(error as HttpException)} ${duration()}`,
          );
        }
        return throwError(() => error);
      }),
    );
  }

  private auditUpdate(
    operation: Operation,
    request: AuthenticatedRequest,
    next: CallHandler,
  ): Observable<unknown> {
    const startedAt = Date.now();
    const rawTarget = request.params?.userId as string | undefined;
    const targetUserId = rawTarget && USER_ID_PATTERN.test(rawTarget) ? rawTarget : "invalid";
    const actorUserId = request.userId ?? "unknown";
    const scope = targetUserId === actorUserId ? "self" : "foreign";
    const event = `operation=${operation.name} scope=${scope} actorUserId=${actorUserId} targetUserId=${targetUserId} fields=${operation.fields ?? fieldNames(request.body)}`;
    const duration = () => `durationMs=${Date.now() - startedAt}`;

    return next.handle().pipe(
      tap(() => {
        this.logger.log(`User update result=success ${event} ${duration()}`);
      }),
      catchError((error: unknown) => {
        const result = error instanceof HttpException ? UPDATE_RESULTS[error.getStatus()] : undefined;
        if (result) {
          this.logger.warn(
            `User update result=${result} ${event} code=${errorCode(error as HttpException)} ${duration()}`,
          );
        } else {
          this.logger.error(`User update result=failed ${event} ${duration()}`);
        }
        return throwError(() => error);
      }),
    );
  }
}

function fieldNames(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "none";
  }
  const names = Object.keys(body).filter((key) => AUDITED_FIELDS.includes(key));
  return names.length > 0 ? names.join(",") : "none";
}

function errorCode(error: HttpException) {
  const body = error.getResponse();
  if (typeof body === "object" && body !== null && "code" in body) {
    return (body as { code: string }).code;
  }
  return DEFAULT_ERROR_CODES[error.getStatus()] ?? "unknown";
}
