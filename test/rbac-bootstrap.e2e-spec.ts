import { INestApplication, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { RbacBootstrapService } from "../src/access-control/rbac/services/rbac-bootstrap.service";
import { RbacPolicyService } from "../src/access-control/rbac/services/rbac-policy.service";
import { createTestApp } from "./helpers/create-test-app";
import { resetRbac } from "./helpers/rbac";

const USERS_ACTIONS = ["read", "read_any", "update", "update_any", "delete", "delete_any", "list"];

describe("RBAC bootstrap (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let bootstrap: RbacBootstrapService;
  let rbac: RbacPolicyService;
  let ids: Record<"admin" | "alice" | "bob" | "pat", string>;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp());
    bootstrap = app.get(RbacBootstrapService);
    rbac = app.get(RbacPolicyService);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    await resetRbac(db);
    logged.forEach((spy) => spy.mockClear());
    const rows: { id: string; email: string }[] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES
         ('admin@gmail.com', 'active', 'hash'),
         ('alice@gmail.com', 'active', 'hash'),
         ('bob@gmail.com', 'blocked', 'hash'),
         ('pat@gmail.com', 'pending', 'hash')
       RETURNING id, email`,
    );
    const id = (name: string) => rows.find((row) => row.email.startsWith(name))!.id;
    ids = { admin: id("admin"), alice: id("alice"), bob: id("bob"), pat: id("pat") };
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = ids.admin;
  });

  afterEach(() => {
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = "";
  });

  const allowed = async (user: keyof typeof ids, permission: string, action: string) =>
    (await rbac.authorize(ids[user], permission, action)).allowed;

  const rolesOf = async (user: keyof typeof ids) =>
    (
      await db.query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.name`,
        [ids[user]],
      )
    ).map((row: { name: string }) => row.name);

  const count = async (table: string) =>
    Number((await db.query(`SELECT count(*) FROM "${table}"`))[0].count);

  const version = async () =>
    Number((await db.query(`SELECT version FROM rbac_policy_state`))[0].version);

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  it("creates the rbac and users permissions with their actions", async () => {
    await expect(bootstrap.bootstrap()).resolves.toBe(true);

    const rows: { permission: string; action: string }[] = await db.query(
      `SELECT p.name AS permission, pa.name AS action
       FROM permissions p JOIN permission_actions pa ON pa.permission_id = p.id
       ORDER BY p.name, pa.name`,
    );
    expect(rows.filter((row) => row.permission === "rbac").map((row) => row.action)).toEqual([
      "manage",
    ]);
    expect(
      rows.filter((row) => row.permission === "users").map((row) => row.action).sort(),
    ).toEqual([...USERS_ACTIONS].sort());
    expect(
      (await db.query(`SELECT name FROM roles ORDER BY name`)).map((row: { name: string }) => row.name),
    ).toEqual(["admin", "user"]);
  });

  it("gives the admin role rbac@manage and every users action", async () => {
    await bootstrap.bootstrap();

    expect(await rolesOf("admin")).toEqual(["admin"]);
    expect(await allowed("admin", "rbac", "manage")).toBe(true);
    for (const action of USERS_ACTIONS) {
      expect(await allowed("admin", "users", action)).toBe(true);
    }
  });

  it("lets the admin grant cover users actions added later", async () => {
    await bootstrap.bootstrap();

    await db.query(
      `INSERT INTO permission_actions (permission_id, name)
       SELECT id, 'export' FROM permissions WHERE name = 'users'`,
    );

    expect(await allowed("admin", "users", "export")).toBe(true);
    expect(await allowed("alice", "users", "export")).toBe(false);
  });

  it("gives the user role only its own read, update and delete", async () => {
    await bootstrap.bootstrap();

    expect(await rolesOf("alice")).toEqual(["user"]);
    for (const action of ["read", "update", "delete"]) {
      expect(await allowed("alice", "users", action)).toBe(true);
    }
    for (const action of ["read_any", "update_any", "delete_any", "list"]) {
      expect(await allowed("alice", "users", action)).toBe(false);
    }
    expect(await allowed("alice", "rbac", "manage")).toBe(false);
  });

  it("gives existing non-pending users the user role and skips pending ones", async () => {
    await bootstrap.bootstrap();

    expect(await rolesOf("bob")).toEqual(["user"]);
    expect(await rolesOf("pat")).toEqual([]);
    expect(logs().join("\n")).toContain(
      `RBAC bootstrap completed roles=user,admin admin=${ids.admin} usersWithUserRole=2`,
    );
  });

  it("runs only once and does not reassign roles", async () => {
    await bootstrap.bootstrap();
    await db.query(`DELETE FROM user_roles WHERE user_id = $1`, [ids.alice]);
    const before = await version();

    await expect(bootstrap.bootstrap()).resolves.toBe(false);

    expect(await rolesOf("alice")).toEqual([]);
    expect(await count("roles")).toBe(2);
    expect(await version()).toBe(before);
    expect(logs().join("\n")).toContain("RBAC bootstrap skipped reason=already_configured");
  });

  it("skips a configuration that already has a role", async () => {
    await db.query(`INSERT INTO roles (name) VALUES ('custom')`);

    await expect(bootstrap.bootstrap()).resolves.toBe(false);

    expect(await count("permissions")).toBe(0);
    expect(await rolesOf("alice")).toEqual([]);
  });

  it("writes nothing when the admin user does not exist", async () => {
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = "00000000-0000-4000-8000-000000000000";
    const before = await version();

    await expect(bootstrap.bootstrap()).rejects.toThrow(
      "RBAC_BOOTSTRAP_ADMIN_USER_ID=00000000-0000-4000-8000-000000000000 does not match an existing user",
    );

    expect(await count("roles")).toBe(0);
    expect(await count("permissions")).toBe(0);
    expect(await version()).toBe(before);
  });

  it("creates the policy without an admin when the variable is not set", async () => {
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = "";

    await expect(bootstrap.bootstrap()).resolves.toBe(true);

    expect(await rolesOf("admin")).toEqual(["user"]);
    expect(await allowed("admin", "rbac", "manage")).toBe(false);
    expect(logs().join("\n")).toContain(
      "RBAC bootstrap without RBAC_BOOTSTRAP_ADMIN_USER_ID: nobody can manage RBAC",
    );
  });

  it("raises the policy version so running processes reload the snapshot", async () => {
    const before = await version();

    await bootstrap.bootstrap();

    expect(await version()).toBeGreaterThan(before);
  });
});
