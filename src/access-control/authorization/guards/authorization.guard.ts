import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { SessionService } from "../../../identity/authentication/services/session.service";
import { ACCESS_COOKIE } from "../../../identity/authentication/helpers/auth-cookies";
import { invalidSession } from "../../../identity/authentication/helpers/auth-errors";
import { authorizationUnavailable } from "../../../common/errors/authorization-unavailable";
import { permissionDenied } from "../helpers/authorization-errors";
import { RbacPolicyService } from "../../rbac/services/rbac-policy.service";
import { CsrfPolicy } from "../services/csrf-policy.service";
import { readDeclaration } from "../helpers/route-declaration";

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

// единая цепочка для каждого маршрута: декларация → access → пользователь → CSRF → RBAC.
// Маршрут без корректной декларации закрыт, открыть его можно только явным @Public()
@Injectable()
export class AuthorizationGuard implements CanActivate {
  private readonly logger = new Logger(AuthorizationGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessionService: SessionService,
    private readonly csrfPolicy: CsrfPolicy,
    private readonly rbac: RbacPolicyService,
  ) {}

  public async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const route = `${request.method} ${request.path}`;
    const check = readDeclaration(this.reflector, context.getHandler(), context.getClass());

    if (!check.valid) {
      this.logger.error(
        `Authorization unavailable reason=route_configuration route=${route}: ${check.reason}`,
      );
      throw authorizationUnavailable();
    }
    const { declaration } = check;

    // публичная операция и квитанция не разбирают access-cookie, но изменение из другого origin проверяют
    if (declaration.kind === "public") {
      this.csrfPolicy.check(request);
      return true;
    }
    if (declaration.receiptHeader && request.headers[declaration.receiptHeader] !== undefined) {
      this.csrfPolicy.check(request);
      return true;
    }
    if (declaration.kind === "receipt") {
      this.logger.warn(`Access rejected reason=missing_receipt route=${route}`);
      throw invalidSession();
    }

    // access берётся только из cookie: заголовок Authorization, тело и query не читаются
    const cookies = request.cookies as Record<string, string> | undefined;
    const userId = await this.sessionService.authenticate(cookies?.[ACCESS_COOKIE]);

    this.csrfPolicy.check(request);

    const { permission, action, audit } = declaration.required;
    const decision = await this.rbac.authorize(userId, permission, action);
    // requestId дописывает логгер; роли и содержимое снимка в журнал не попадают
    const details = `actorUserId=${userId} operation=${context.getClass().name}.${context.getHandler().name} route=${route} required=${permission}@${action} policyVersion=${decision.version}`;
    if (!decision.allowed) {
      this.logger.warn(`Request rejected reason=permission_denied ${details}`);
      throw permissionDenied();
    }
    if (audit) {
      this.logger.log(`Access granted ${details}`);
    }

    request.userId = userId;
    return true;
  }
}
