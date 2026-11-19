import { HttpException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import { POLICY_STATE_ID } from "../entities/rbac-policy-state.entity";
import { lastManagerConflict, rbacConflict, rbacUnavailable } from "../helpers/rbac-errors";
import { isDatabaseUnavailable } from "../../../common/errors/database-unavailable";

export interface RbacChange {
  operation: string;
  entity: "role" | "permission" | "grant" | "user_roles";
  entityId?: string;
  actorUserId: string;
}

const UNIQUE_CONFLICTS: Record<string, [string, string]> = {
  uq_roles_name: ["name_taken", "Role name is already taken"],
  uq_permissions_name: ["name_taken", "Permission name is already taken"],
  uq_grants_role_permission: ["grant_exists", "The role already has a grant for this permission"],
};

const ACTIVE_MANAGER_QUERY = `
  SELECT EXISTS (
    SELECT 1
    FROM "user_roles" ur
    JOIN "users" u ON u."id" = ur."user_id" AND u."status" = 'active'
    JOIN "grants" g ON g."role_id" = ur."role_id"
    JOIN "permissions" p ON p."id" = g."permission_id" AND p."name" = 'rbac'
    JOIN "permission_actions" pa ON pa."permission_id" = p."id" AND pa."name" = 'manage'
    WHERE g."all_actions"
      OR EXISTS (
        SELECT 1 FROM "grant_actions" ga
        WHERE ga."grant_id" = g."id" AND ga."permission_action_id" = pa."id"
      )
  ) AS "exists"
`;

@Injectable()
export class RbacAdminService {
  private readonly logger = new Logger(RbacAdminService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public async change<T>(change: RbacChange, work: (manager: EntityManager) => Promise<T>) {
    try {
      const { result, version } = await this.dataSource.transaction(async (manager) => {
        await manager.query(`SELECT 1 FROM "rbac_policy_state" WHERE "id" = $1 FOR UPDATE`, [
          POLICY_STATE_ID,
        ]);
        const result = await work(manager);
        const [{ exists }] = await manager.query(ACTIVE_MANAGER_QUERY);
        if (!exists) {
          throw lastManagerConflict();
        }
        const [{ version }] = await manager.query(
          `SELECT "version" FROM "rbac_policy_state" WHERE "id" = $1`,
          [POLICY_STATE_ID],
        );
        return { result, version: version as number };
      });

      const entityId = change.entityId ?? (result as { id?: string } | undefined)?.id;
      this.logger.log(
        `RBAC change result=success operation=${change.operation} entity=${change.entity} entityId=${entityId} actorUserId=${change.actorUserId} policyVersion=${version}`,
      );
      return result;
    } catch (error) {
      const mapped = toHttpError(error);
      this.rejected(change, mapped);
      throw mapped;
    }
  }

  public rejected(change: RbacChange, error: unknown) {
    if (error instanceof HttpException) {
      this.logger.warn(
        `RBAC change result=rejected operation=${change.operation} entity=${change.entity} entityId=${change.entityId} actorUserId=${change.actorUserId} status=${error.getStatus()} code=${errorCode(error)}`,
      );
    } else {
      this.logger.error(
        `RBAC change result=failed operation=${change.operation} entity=${change.entity} entityId=${change.entityId} actorUserId=${change.actorUserId}: ${(error as Error).message}`,
      );
    }
  }
}

function errorCode(error: HttpException) {
  const body = error.getResponse();
  if (typeof body === "object" && "code" in body) {
    return (body as { code: string }).code;
  }
  const message = typeof body === "object" ? (body as { message?: unknown }).message : body;
  return Array.isArray(message) ? "validation_failed" : "bad_request";
}

export function toHttpError(error: unknown) {
  if (isDatabaseUnavailable(error)) {
    return rbacUnavailable();
  }
  if (!(error instanceof QueryFailedError)) {
    return error;
  }
  const driverError = error.driverError as { code?: string; constraint?: string };
  if (driverError.code === "23505") {
    const [code, message] = UNIQUE_CONFLICTS[driverError.constraint ?? ""] ?? [
      "already_exists",
      "The entity already exists",
    ];
    return rbacConflict(code, message);
  }
  if (driverError.code === "23503") {
    return rbacConflict("in_use", "The entity is still in use");
  }
  return error;
}
