import { EntityManager } from "typeorm";
import { POLICY_STATE_ID } from "../entities/rbac-policy-state.entity";
import { lastManagerConflict } from "./rbac-errors";

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

export async function lockPolicy(manager: EntityManager): Promise<void> {
  await manager.query(
    `SELECT 1 FROM "rbac_policy_state" WHERE "id" = $1 FOR UPDATE`,
    [POLICY_STATE_ID],
  );
}

export async function ensureActiveManager(manager: EntityManager): Promise<void> {
  const [{ exists }] = await manager.query(ACTIVE_MANAGER_QUERY);

  if (!exists) {
    throw lastManagerConflict();
  }
}