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
import { RbacBootstrapService } from "./services/rbac-bootstrap.service";
import { UserRolesService } from "./services/user-roles.service";
import { RbacAdminService } from "./services/rbac-admin.service";
import { RolesService } from "./services/roles.service";
import { PermissionsService } from "./services/permissions.service";
import { GrantsService } from "./services/grants.service";
import { RolesController } from "./controllers/roles.controller";
import { PermissionsController } from "./controllers/permissions.controller";
import { GrantsController } from "./controllers/grants.controller";
import { UserRolesController } from "./controllers/user-roles.controller";
import { User } from "../../users/entities/user.entity";

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
      User,
    ]),
  ],
  controllers: [RolesController, PermissionsController, GrantsController, UserRolesController],
  providers: [
    RbacBootstrapService,
    RbacPolicyService,
    RbacAdminService,
    RolesService,
    PermissionsService,
    GrantsService,
    UserRolesService,
  ],
  exports: [RbacPolicyService, UserRolesService],
})
export class RbacModule {}
