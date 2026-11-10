import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "../services/session.service";
import { ACCESS_COOKIE } from "../helpers/auth-cookies";

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

// access берётся только из cookie: заголовок Authorization, тело и query не читаются
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(private readonly sessionService: SessionService) {}

  public async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookies = request.cookies as Record<string, string> | undefined;
    request.userId = await this.sessionService.authenticate(cookies?.[ACCESS_COOKIE]);
    return true;
  }
}
