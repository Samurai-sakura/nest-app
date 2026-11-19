import { DataSource } from "typeorm";

export const resetRbac = (db: DataSource) =>
  db.query(
    `TRUNCATE "grant_actions", "grants", "user_roles", "permission_actions", "permissions", "roles" CASCADE`,
  );

export async function grantPermission(
  db: DataSource,
  userId: string,
  permission: string,
  actions: string[],
) {
  const [{ id: roleId }] = await db.query(
    `INSERT INTO roles (name) VALUES ($1) RETURNING id`,
    [`${permission}.holder`],
  );
  const [{ id: permissionId }] = await db.query(
    `INSERT INTO permissions (name) VALUES ($1) RETURNING id`,
    [permission],
  );
  await db.query(
    `INSERT INTO permission_actions (permission_id, name) SELECT $1, unnest($2::text[])`,
    [permissionId, actions],
  );
  const [{ id: grantId }] = await db.query(
    `INSERT INTO grants (role_id, permission_id) VALUES ($1, $2) RETURNING id`,
    [roleId, permissionId],
  );
  await db.query(
    `INSERT INTO grant_actions (grant_id, permission_action_id)
     SELECT $1, id FROM permission_actions WHERE permission_id = $2`,
    [grantId, permissionId],
  );
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, roleId]);
  return { roleId };
}
