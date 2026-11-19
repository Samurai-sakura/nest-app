import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import { Role } from "../entities/role.entity";
import { Permission } from "../entities/permission.entity";
import { PermissionAction } from "../entities/permission-action.entity";
import { Grant } from "../entities/grant.entity";
import { GrantAction } from "../entities/grant-action.entity";
import { UserRole } from "../entities/user-role.entity";
import { POLICY_STATE_ID } from "../entities/rbac-policy-state.entity";
import { User } from "../../../users/entities/user.entity";
import {
  ADMIN_ROLE,
  DEFAULT_PERMISSIONS,
  DEFAULT_ROLES,
  USER_ROLE,
} from "../helpers/default-policy";

interface CreatedPermission {
  id: string;
  actions: Record<string, string>;
}

@Injectable()
export class RbacBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(RbacBootstrapService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  public async onModuleInit() {
    await this.bootstrap();
  }

  public async bootstrap(): Promise<boolean> {
    const adminUserId = this.config.get<string>("RBAC_BOOTSTRAP_ADMIN_USER_ID") || undefined;

    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT 1 FROM "rbac_policy_state" WHERE "id" = $1 FOR UPDATE`, [
        POLICY_STATE_ID,
      ]);
      const configured =
        (await manager.exists(Role)) || (await manager.exists(Permission));
      if (configured) {
        this.logger.log("RBAC bootstrap skipped reason=already_configured");
        return false;
      }

      if (adminUserId && !(await manager.exists(User, { where: { id: adminUserId } }))) {
        throw new Error(
          `RBAC bootstrap failed: RBAC_BOOTSTRAP_ADMIN_USER_ID=${adminUserId} does not match an existing user`,
        );
      }

      const permissions = await this.createPermissions(manager);
      const roles = await this.createRoles(manager, permissions);

      if (adminUserId) {
        await manager.insert(UserRole, { userId: adminUserId, roleId: roles[ADMIN_ROLE] });
      } else {
        this.logger.warn(
          "RBAC bootstrap without RBAC_BOOTSTRAP_ADMIN_USER_ID: nobody can manage RBAC",
        );
      }
      const assigned: unknown[] = await manager.query(
        `INSERT INTO "user_roles" ("user_id", "role_id")
         SELECT u."id", $1 FROM "users" u
         WHERE u."status" <> 'pending'
           AND NOT EXISTS (SELECT 1 FROM "user_roles" ur WHERE ur."user_id" = u."id")
         RETURNING "user_id"`,
        [roles[USER_ROLE]],
      );

      this.logger.log(
        `RBAC bootstrap completed roles=${Object.keys(roles).join(",")} admin=${adminUserId ?? "none"} usersWithUserRole=${assigned.length}`,
      );
      return true;
    });
  }

  private async createPermissions(manager: EntityManager) {
    const permissions: Record<string, CreatedPermission> = {};
    for (const [name, actionNames] of Object.entries(DEFAULT_PERMISSIONS)) {
      const permission = await manager.save(manager.create(Permission, { name }));
      const saved = await manager.save(
        actionNames.map((action) =>
          manager.create(PermissionAction, { permissionId: permission.id, name: action }),
        ),
      );
      permissions[name] = {
        id: permission.id,
        actions: Object.fromEntries(saved.map((action) => [action.name, action.id])),
      };
    }
    return permissions;
  }

  private async createRoles(
    manager: EntityManager,
    permissions: Record<string, CreatedPermission>,
  ) {
    const roles: Record<string, string> = {};
    for (const [name, grants] of Object.entries(DEFAULT_ROLES)) {
      const role = await manager.save(manager.create(Role, { name }));
      roles[name] = role.id;

      for (const [permissionName, actionNames] of Object.entries(grants)) {
        const permission = permissions[permissionName];
        const grant = await manager.save(
          manager.create(Grant, {
            roleId: role.id,
            permissionId: permission.id,
            allActions: actionNames.length === 0,
          }),
        );
        if (actionNames.length > 0) {
          await manager.insert(
            GrantAction,
            actionNames.map((action) => ({
              grantId: grant.id,
              permissionActionId: permission.actions[action],
            })),
          );
        }
      }
    }
    return roles;
  }
}
