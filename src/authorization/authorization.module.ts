import { Module } from "@nestjs/common";
import { APP_GUARD, DiscoveryModule } from "@nestjs/core";
import { AuthModule } from "../auth/auth.module";
import { RbacModule } from "../rbac/rbac.module";
import { AccessControlService } from "./access-control.service";
import { AuthorizationGuard } from "./authorization.guard";
import { CsrfPolicy } from "./csrf-policy";
import { RouteConfigurationService } from "./route-configuration.service";

@Module({
  imports: [AuthModule, RbacModule, DiscoveryModule],
  providers: [
    CsrfPolicy,
    RouteConfigurationService,
    AccessControlService,
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
  exports: [RouteConfigurationService, AccessControlService],
})
export class AuthorizationModule {}
