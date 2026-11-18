import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Role } from "../entities/role.entity";
import { RoleBodyDto, RoleResponse } from "../dto/role.dto";
import { rbacNotFound } from "../helpers/rbac-errors";
import { RbacAdminService } from "./rbac-admin.service";

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    private readonly admin: RbacAdminService,
  ) {}

  public async list() {
    const roles = await this.roleRepository.find({ order: { name: "ASC" } });
    return roles.map(toRoleView);
  }

  public create(actorUserId: string, dto: RoleBodyDto) {
    return this.admin.change({ operation: "role.create", entity: "role", actorUserId }, async (manager) =>
      toRoleView(
        await manager.save(
          manager.create(Role, { name: dto.name, description: dto.description || null }),
        ),
      ),
    );
  }

  public replace(actorUserId: string, roleId: string, dto: RoleBodyDto) {
    return this.admin.change(
      { operation: "role.replace", entity: "role", entityId: roleId, actorUserId },
      async (manager) => {
        const role = await manager.findOneBy(Role, { id: roleId });
        if (!role) {
          throw rbacNotFound("role");
        }
        role.name = dto.name;
        role.description = dto.description || null;
        return toRoleView(await manager.save(role));
      },
    );
  }

  // роль с назначениями или пользователями не удаляется: RESTRICT в базе даёт 409
  public async remove(actorUserId: string, roleId: string) {
    await this.admin.change(
      { operation: "role.delete", entity: "role", entityId: roleId, actorUserId },
      async (manager) => {
        const { affected } = await manager.delete(Role, { id: roleId });
        if (!affected) {
          throw rbacNotFound("role");
        }
      },
    );
  }
}

export function toRoleView(role: Role): RoleResponse {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
