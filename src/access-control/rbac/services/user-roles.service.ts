import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { EntityManager, In, Repository } from "typeorm";
import { User } from "../../../users/entities/user.entity";
import { Role } from "../entities/role.entity";
import { UserRole } from "../entities/user-role.entity";
import { UserRolesResponse } from "../dto/user-roles.dto";
import { USER_ROLE } from "../helpers/default-policy";
import { rbacNotFound } from "../helpers/rbac-errors";
import { RbacAdminService } from "./rbac-admin.service";

@Injectable()
export class UserRolesService {
  private readonly logger = new Logger(UserRolesService.name);

  constructor(
    @InjectRepository(UserRole)
    private readonly userRoleRepository: Repository<UserRole>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly admin: RbacAdminService,
  ) {}

  // ответ без email и полей профиля: только идентификаторы
  public async get(actorUserId: string, userId: string): Promise<UserRolesResponse> {
    if (!(await this.userRepository.exists({ where: { id: userId } }))) {
      const error = rbacNotFound("user");
      this.admin.rejected(
        { operation: "user_roles.read", entity: "user_roles", entityId: userId, actorUserId },
        error,
      );
      throw error;
    }
    const links = await this.userRoleRepository.findBy({ userId });
    return { userId, roleIds: links.map((link) => link.roleId).sort() };
  }

  // список заменяется целиком; пустой массив снимает все роли
  public replace(actorUserId: string, userId: string, roleIds: string[]) {
    return this.admin.change(
      { operation: "user_roles.replace", entity: "user_roles", entityId: userId, actorUserId },
      async (manager): Promise<UserRolesResponse> => {
        if (!(await manager.exists(User, { where: { id: userId } }))) {
          throw rbacNotFound("user");
        }
        if (
          roleIds.length > 0 &&
          (await manager.countBy(Role, { id: In(roleIds) })) !== roleIds.length
        ) {
          throw rbacNotFound("role");
        }
        await manager.delete(UserRole, { userId });
        if (roleIds.length > 0) {
          await manager.insert(
            UserRole,
            roleIds.map((roleId) => ({ userId, roleId })),
          );
        }
        return { userId, roleIds: [...roleIds].sort() };
      },
    );
  }

  // вызывается в транзакции, которая переводит пользователя в active: связь и статус
  // фиксируются вместе. Уже назначенная роль не дублируется, состав прав выбирает RBAC
  public async assignDefaultRole(manager: EntityManager, userId: string) {
    const assigned: unknown[] = await manager.query(
      `INSERT INTO "user_roles" ("user_id", "role_id")
       SELECT $1, r."id" FROM "roles" r WHERE r."name" = $2
       ON CONFLICT DO NOTHING
       RETURNING "role_id"`,
      [userId, USER_ROLE],
    );
    if (assigned.length > 0) {
      return;
    }
    // активация не откатывается: пользователь просто остаётся без прав до назначения через API
    const roleExists = await manager.query(`SELECT 1 FROM "roles" WHERE "name" = $1`, [
      USER_ROLE,
    ]);
    if (roleExists.length === 0) {
      this.logger.warn(`Default role not assigned reason=role_missing role=${USER_ROLE} userId=${userId}`);
    }
  }
}
