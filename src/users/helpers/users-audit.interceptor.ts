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

const OPERATIONS: Record<string, string> = {
  getUser: "users.profile",
  getPhoto: "users.photo",
};

const RESULTS: Record<number, { result: string; withTarget: boolean }> = {
  403: { result: "forbidden", withTarget: false },
  429: { result: "rate_limited", withTarget: false },
  404: { result: "not_found", withTarget: true },
  503: { result: "unavailable", withTarget: true },
};

@Injectable()
export class UsersAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger("UsersAudit");

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const targetUserId = request.params?.userId as string;
    const actorUserId = request.userId ?? "unknown";
    const scope = targetUserId === actorUserId ? "self" : "foreign";
    const event = `operation=${OPERATIONS[context.getHandler().name]} scope=${scope} actorUserId=${actorUserId}`;
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
        const known = error instanceof HttpException ? RESULTS[error.getStatus()] : undefined;
        if (known) {
          const body = (error as HttpException).getResponse() as { code?: string };
          const target = known.withTarget ? ` targetUserId=${targetUserId}` : "";
          this.logger.warn(
            `User read result=${known.result} ${event}${target} code=${body.code} ${duration()}`,
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
