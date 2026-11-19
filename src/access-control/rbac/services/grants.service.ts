import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { Grant } from "../entities/grant.entity";
import { GrantAction } from "../entities/grant-action.entity";
import { Role } from "../entities/role.entity";
import { Permission } from "../entities/permission.entity";
import { PermissionAction } from "../entities/permission-action.entity";
import { GrantBodyDto, GrantResponse } from "../dto/grant.dto";
import { rbacBadRequest, rbacNotFound } from "../helpers/rbac-errors";
import { RbacAdminService } from "./rbac-admin.service";

const GRANT_RELATIONS = { actions: { permissionAction: true } } as const;

@Injectable()
export class GrantsService {
  constructor(
    @InjectRepository(Grant)
    private readonly grantRepository: Repository<Grant>,
    private readonly admin: RbacAdminService,
  ) {}

  public async list() {
    const grants = await this.grantRepository.find({
      relations: GRANT_RELATIONS,
      order: { createdAt: "ASC" },
    });
    return grants.map(toGrantView);
  }

  public create(actorUserId: string, dto: GrantBodyDto) {
    return this.admin.change({ operation: "grant.create", entity: "grant", actorUserId }, async (manager) => {
      const actionIds = await this.resolve(manager, dto);
      const grant = await manager.save(
        manager.create(Grant, {
          roleId: dto.roleId,
          permissionId: dto.permissionId,
          allActions: actionIds.length === 0,
        }),
      );
      await this.insertActions(manager, grant.id, actionIds);
      return this.view(manager, grant.id);
    });
  }

  public replace(actorUserId: string, grantId: string, dto: GrantBodyDto) {
    return this.admin.change(
      { operation: "grant.replace", entity: "grant", entityId: grantId, actorUserId },
      async (manager) => {
        if (!(await manager.exists(Grant, { where: { id: grantId } }))) {
          throw rbacNotFound("grant");
        }
        const actionIds = await this.resolve(manager, dto);
        await manager.delete(GrantAction, { grantId });
        await manager.update(Grant, grantId, {
          roleId: dto.roleId,
          permissionId: dto.permissionId,
          allActions: actionIds.length === 0,
        });
        await this.insertActions(manager, grantId, actionIds);
        return this.view(manager, grantId);
      },
    );
  }

  public async remove(actorUserId: string, grantId: string) {
    await this.admin.change(
      { operation: "grant.delete", entity: "grant", entityId: grantId, actorUserId },
      async (manager) => {
        const { affected } = await manager.delete(Grant, { id: grantId });
        if (!affected) {
          throw rbacNotFound("grant");
        }
      },
    );
  }

  private async resolve(manager: EntityManager, dto: GrantBodyDto) {
    if (!(await manager.exists(Role, { where: { id: dto.roleId } }))) {
      throw rbacNotFound("role");
    }
    if (!(await manager.exists(Permission, { where: { id: dto.permissionId } }))) {
      throw rbacNotFound("permission");
    }
    const names = dto.actions ?? [];
    if (names.length === 0) {
      return [];
    }
    const actions = await manager.findBy(PermissionAction, {
      permissionId: dto.permissionId,
      name: In(names),
    });
    if (actions.length !== names.length) {
      const known = new Set(actions.map((action) => action.name));
      const unknown = names.filter((name) => !known.has(name));
      throw rbacBadRequest(
        "unknown_action",
        `Actions do not belong to the permission: ${unknown.join(", ")}`,
      );
    }
    return actions.map((action) => action.id);
  }

  private async insertActions(manager: EntityManager, grantId: string, actionIds: string[]) {
    if (actionIds.length > 0) {
      await manager.insert(
        GrantAction,
        actionIds.map((permissionActionId) => ({ grantId, permissionActionId })),
      );
    }
  }

  private async view(manager: EntityManager, grantId: string) {
    return toGrantView(
      await manager.findOneOrFail(Grant, { where: { id: grantId }, relations: GRANT_RELATIONS }),
    );
  }
}

function toGrantView(grant: Grant): GrantResponse {
  return {
    id: grant.id,
    roleId: grant.roleId,
    permissionId: grant.permissionId,
    allActions: grant.allActions,
    actions: grant.allActions
      ? []
      : grant.actions.map((action) => action.permissionAction.name).sort(),
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}
