import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { RbacModule } from "../rbac/rbac.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [AuthorizationModule, RbacModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
