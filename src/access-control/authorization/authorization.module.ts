import { Module } from "@nestjs/common";
import { APP_GUARD, DiscoveryModule } from "@nestjs/core";
import { AuthenticationModule } from "../../identity/authentication/authentication.module";
import { RbacModule } from "../rbac/rbac.module";
import { AccessControlService } from "./services/access-control.service";
import { AuthorizationGuard } from "./guards/authorization.guard";
import { CsrfPolicy } from "./services/csrf-policy.service";
import { RouteConfigurationService } from "./services/route-configuration.service";

@Module({
  imports: [AuthenticationModule, RbacModule, DiscoveryModule],
  providers: [
    CsrfPolicy,
    RouteConfigurationService,
    AccessControlService,
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
  exports: [RouteConfigurationService, AccessControlService],
})
export class AuthorizationModule {}
