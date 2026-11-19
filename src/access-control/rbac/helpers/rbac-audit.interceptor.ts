import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, catchError, throwError } from "rxjs";
import type { AuthenticatedRequest } from "../../authorization/guards/authorization.guard";
import { isDatabaseUnavailable } from "../../../common/errors/database-unavailable";
import { rbacUnavailable } from "./rbac-errors";
import { RbacAdminService, RbacChange } from "../services/rbac-admin.service";

const ENTITIES: Record<string, RbacChange["entity"]> = {
  RolesController: "role",
  PermissionsController: "permission",
  GrantsController: "grant",
  UserRolesController: "user_roles",
};

const OPERATIONS: Record<string, string> = {
  list: "list",
  get: "read",
  create: "create",
  replace: "replace",
  remove: "delete",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RbacAuditInterceptor implements NestInterceptor {
  constructor(private readonly admin: RbacAdminService) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => throwError(() => this.handle(context, error))),
    );
  }

  private handle(context: ExecutionContext, error: unknown) {
    if (error instanceof HttpException && hasCode(error)) {
      return error;
    }
    const mapped = isDatabaseUnavailable(error) ? rbacUnavailable() : error;
    this.admin.rejected(this.change(context), mapped);
    return mapped;
  }

  private change(context: ExecutionContext): RbacChange {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const entity = ENTITIES[context.getClass().name];
    const id = Object.values(request.params ?? {})[0] as string | undefined;
    return {
      operation: `${entity}.${OPERATIONS[context.getHandler().name]}`,
      entity,
      entityId: id === undefined ? undefined : UUID_PATTERN.test(id) ? id : "invalid",
      actorUserId: request.userId ?? "unknown",
    };
  }
}

function hasCode(error: HttpException) {
  const body = error.getResponse();
  return typeof body === "object" && "code" in body;
}
