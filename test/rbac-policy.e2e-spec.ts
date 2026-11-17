import { INestApplication, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { RbacPolicyService } from "../src/access-control/rbac/services/rbac-policy.service";
import { createTestApp } from "./helpers/create-test-app";

describe("RBAC policy (e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let rbac: RbacPolicyService;
  let userId: string;
  let roleId: string;
  let permissionId: string;
  let actions: Record<string, string>;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ({ app, db } = await createTestApp());
    rbac = app.get(RbacPolicyService);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE "grant_actions", "grants", "user_roles", "permission_actions", "permissions", "roles", "users" CASCADE`,
    );
    [{ id: userId }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ('rbac@gmail.com', 'active', 'hash') RETURNING id`,
    );
    [{ id: roleId }] = await db.query(
      `INSERT INTO roles (name) VALUES ('editor') RETURNING id`,
    );
    [{ id: permissionId }] = await db.query(
      `INSERT INTO permissions (name) VALUES ('reports') RETURNING id`,
    );
    const rows: { id: string; name: string }[] = await db.query(
      `INSERT INTO permission_actions (permission_id, name) VALUES ($1, 'read'), ($1, 'delete') RETURNING id, name`,
      [permissionId],
    );
    actions = Object.fromEntries(rows.map((row) => [row.name, row.id]));
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
      userId,
      roleId,
    ]);
  });

  const version = async () =>
    Number((await db.query(`SELECT version FROM rbac_policy_state`))[0].version);

  const grant = async (allActions: boolean) =>
    (
      await db.query(
        `INSERT INTO grants (role_id, permission_id, all_actions) VALUES ($1, $2, $3) RETURNING id`,
        [roleId, permissionId, allActions],
      )
    )[0].id as string;

  const allowed = async (permission: string, action: string, user = userId) =>
    (await rbac.authorize(user, permission, action)).allowed;

  it("increments the policy version once per statement", async () => {
    const before = await version();

    await db.query(
      `INSERT INTO permission_actions (permission_id, name) VALUES ($1, 'export'), ($1, 'share')`,
      [permissionId],
    );

    expect(await version()).toBe(before + 1);
  });

  it("does not change the version when the transaction rolls back", async () => {
    const before = await version();

    await db
      .transaction(async (manager) => {
        await manager.query(`INSERT INTO roles (name) VALUES ('viewer')`);
        throw new Error("rollback");
      })
      .catch(() => undefined);

    expect(await version()).toBe(before);
  });

  it("rejects an action of another permission in a grant", async () => {
    const grantId = await grant(false);
    const [{ id: otherPermissionId }] = await db.query(
      `INSERT INTO permissions (name) VALUES ('users') RETURNING id`,
    );
    const [{ id: foreignActionId }] = await db.query(
      `INSERT INTO permission_actions (permission_id, name) VALUES ($1, 'delete') RETURNING id`,
      [otherPermissionId],
    );

    for (const permission of [permissionId, otherPermissionId]) {
      await expect(
        db.query(
          `INSERT INTO grant_actions (grant_id, permission_action_id, permission_id) VALUES ($1, $2, $3)`,
          [grantId, foreignActionId, permission],
        ),
      ).rejects.toMatchObject({ driverError: { code: "23503" } });
    }
  });

  it("allows only the listed actions", async () => {
    const grantId = await grant(false);
    await db.query(
      `INSERT INTO grant_actions (grant_id, permission_action_id, permission_id) VALUES ($1, $2, $3)`,
      [grantId, actions.read, permissionId],
    );

    expect(await allowed("reports", "read")).toBe(true);
    expect(await allowed("reports", "delete")).toBe(false);
  });

  it("covers actions added later when all actions are granted", async () => {
    await grant(true);
    expect(await allowed("reports", "export")).toBe(false);

    await db.query(
      `INSERT INTO permission_actions (permission_id, name) VALUES ($1, 'export')`,
      [permissionId],
    );

    expect(await allowed("reports", "export")).toBe(true);
  });

  it("applies a revoked role to the next check", async () => {
    await grant(true);
    expect(await allowed("reports", "read")).toBe(true);

    await db.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);

    expect(await allowed("reports", "read")).toBe(false);
  });

  it("denies unknown names and users without roles", async () => {
    await grant(true);
    const [{ id: otherUserId }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ('other@gmail.com', 'active', 'hash') RETURNING id`,
    );

    expect(await allowed("billing", "read")).toBe(false);
    expect(await allowed("reports", "archive")).toBe(false);
    expect(await allowed("reports", "read", otherUserId)).toBe(false);
  });
});
