import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Role } from "./entities/role.entity";
import { Permission } from "./entities/permission.entity";
import { PermissionAction } from "./entities/permission-action.entity";
import { Grant } from "./entities/grant.entity";
import { GrantAction } from "./entities/grant-action.entity";
import { UserRole } from "./entities/user-role.entity";
import { RbacPolicyState } from "./entities/rbac-policy-state.entity";
import { RbacPolicyService } from "./services/rbac-policy.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Role,
      Permission,
      PermissionAction,
      Grant,
      GrantAction,
      UserRole,
      RbacPolicyState,
    ]),
  ],
  providers: [RbacPolicyService],
  exports: [RbacPolicyService],
})
export class RbacModule {}
