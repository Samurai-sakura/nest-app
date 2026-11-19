import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { Permission } from "../entities/permission.entity";
import { PermissionAction } from "../entities/permission-action.entity";
import { GrantAction } from "../entities/grant-action.entity";
import { PermissionBodyDto, PermissionResponse } from "../dto/permission.dto";
import { rbacConflict, rbacNotFound } from "../helpers/rbac-errors";
import { RbacAdminService } from "./rbac-admin.service";

@Injectable()
export class PermissionsService {
  constructor(
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    private readonly admin: RbacAdminService,
  ) {}

  public async list() {
    const permissions = await this.permissionRepository.find({
      relations: { actions: true },
      order: { name: "ASC" },
    });
    return permissions.map(toPermissionView);
  }

  public create(actorUserId: string, dto: PermissionBodyDto) {
    return this.admin.change(
      { operation: "permission.create", entity: "permission", actorUserId },
      async (manager) => {
        const permission = await manager.save(
          manager.create(Permission, { name: dto.name, description: dto.description || null }),
        );
        await this.insertActions(manager, permission.id, dto.actions);
        return this.view(manager, permission.id);
      },
    );
  }

  public replace(actorUserId: string, permissionId: string, dto: PermissionBodyDto) {
    return this.admin.change(
      { operation: "permission.replace", entity: "permission", entityId: permissionId, actorUserId },
      async (manager) => {
        const permission = await manager.findOne(Permission, {
          where: { id: permissionId },
          relations: { actions: true },
        });
        if (!permission) {
          throw rbacNotFound("permission");
        }

        const removed = permission.actions.filter((action) => !dto.actions.includes(action.name));
        const kept = new Set(permission.actions.map((action) => action.name));
        const added = dto.actions.filter((name) => !kept.has(name));

        if (
          removed.length > 0 &&
          (await manager.exists(GrantAction, {
            where: { permissionActionId: In(removed.map((action) => action.id)) },
          }))
        ) {
          throw rbacConflict(
            "action_in_use",
            "A removed action is still listed in a role grant",
          );
        }
        if (removed.length > 0) {
          await manager.delete(PermissionAction, { id: In(removed.map((action) => action.id)) });
        }
        await this.insertActions(manager, permission.id, added);

        await manager.update(Permission, permission.id, {
          name: dto.name,
          description: dto.description || null,
        });
        return this.view(manager, permission.id);
      },
    );
  }

  public async remove(actorUserId: string, permissionId: string) {
    await this.admin.change(
      { operation: "permission.delete", entity: "permission", entityId: permissionId, actorUserId },
      async (manager) => {
        const { affected } = await manager.delete(Permission, { id: permissionId });
        if (!affected) {
          throw rbacNotFound("permission");
        }
      },
    );
  }

  private async insertActions(manager: EntityManager, permissionId: string, names: string[]) {
    if (names.length > 0) {
      await manager.insert(
        PermissionAction,
        names.map((name) => ({ permissionId, name })),
      );
    }
  }

  private async view(manager: EntityManager, permissionId: string) {
    const permission = await manager.findOneOrFail(Permission, {
      where: { id: permissionId },
      relations: { actions: true },
    });
    return toPermissionView(permission);
  }
}

function toPermissionView(permission: Permission): PermissionResponse {
  return {
    id: permission.id,
    name: permission.name,
    description: permission.description,
    actions: permission.actions.map((action) => action.name).sort(),
    createdAt: permission.createdAt,
    updatedAt: permission.updatedAt,
  };
}
