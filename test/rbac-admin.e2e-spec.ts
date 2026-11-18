import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Role } from "../src/access-control/rbac/entities/role.entity";
import { TokenService } from "../src/identity/authentication/services/token.service";
import { RbacBootstrapService } from "../src/access-control/rbac/services/rbac-bootstrap.service";
import { RbacPolicyService } from "../src/access-control/rbac/services/rbac-policy.service";
import { createTestApp } from "./helpers/create-test-app";
import { resetRbac } from "./helpers/rbac";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

describe("RBAC admin API (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  // шпионы на сервисы снимаются после каждого теста, иначе следующий видит чужие вызовы
  const serviceSpies: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let adminId: string;
  let aliceId: string;
  let adminCookie: string;
  let aliceCookie: string;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp());
  });

  afterEach(() => {
    serviceSpies.splice(0).forEach((spy) => spy.mockRestore());
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    await resetRbac(db);
    [{ id: adminId }, { id: aliceId }] = await db.query(
      `INSERT INTO users (email, status, password_hash)
       VALUES ('admin@gmail.com', 'active', 'hash'), ('alice@gmail.com', 'active', 'hash')
       RETURNING id`,
    );
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = adminId;
    await app.get(RbacBootstrapService).bootstrap();
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = "";
    adminCookie = sessionCookie(adminId);
    aliceCookie = sessionCookie(aliceId);
    logged.forEach((spy) => spy.mockClear());
  });

  const http = () => request(app.getHttpServer());

  // вход проверяют тесты аутентификации; здесь токен выпускается напрямую, без лимита попыток входа
  const sessionCookie = (userId: string) =>
    `access_token=${app.get(TokenService).signPair(userId).accessToken}`;

  const api = {
    get: (path: string, cookie = adminCookie) => http().get(path).set("Cookie", cookie),
    post: (path: string, body: object, cookie = adminCookie) =>
      http().post(path).set("Cookie", cookie).send(body),
    put: (path: string, body: object, cookie = adminCookie) =>
      http().put(path).set("Cookie", cookie).send(body),
    delete: (path: string, cookie = adminCookie) => http().delete(path).set("Cookie", cookie),
  };

  const idOf = async (table: "roles" | "permissions", name: string) =>
    (await db.query(`SELECT id FROM ${table} WHERE name = $1`, [name]))[0].id as string;

  const adminGrantId = async (permission: string) =>
    (
      await db.query(
        `SELECT g.id FROM grants g JOIN roles r ON r.id = g.role_id JOIN permissions p ON p.id = g.permission_id
         WHERE r.name = 'admin' AND p.name = $1`,
        [permission],
      )
    )[0].id as string;

  const version = async () =>
    Number((await db.query(`SELECT version FROM rbac_policy_state`))[0].version);

  const allowed = async (userId: string, permission: string, action: string) =>
    (await app.get(RbacPolicyService).authorize(userId, permission, action)).allowed;

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  async function createPermission(name: string, actions: string[]) {
    return (await api.post("/admin/rbac/permissions", { name, actions }).expect(201)).body as {
      id: string;
    };
  }

  describe("access", () => {
    it("answers 401 without a session", async () => {
      await http().get("/admin/rbac/roles").expect(401);
    });

    it("answers 403 to a user without rbac@manage", async () => {
      const response = await api.get("/admin/rbac/roles", aliceCookie).expect(403);

      expect(response.body.code).toBe("permission_denied");
    });

    it("answers 400 to an invalid id", async () => {
      await api.put("/admin/rbac/roles/not-a-uuid", { name: "x" }).expect(400);
    });
  });

  describe("roles", () => {
    it("lists roles without user data", async () => {
      const response = await api.get("/admin/rbac/roles").expect(200);

      expect(response.body.map((role: { name: string }) => role.name)).toEqual(["admin", "user"]);
      expect(Object.keys(response.body[0]).sort()).toEqual(
        ["createdAt", "description", "id", "name", "updatedAt"],
      );
    });

    it("creates a role with a normalized name and an empty description as null", async () => {
      const response = await api
        .post("/admin/rbac/roles", { name: "  Editor ", description: "   " })
        .expect(201);

      expect(response.body).toMatchObject({ name: "editor", description: null });
    });

    it.each(["", "1editor", "edi tor", "a".repeat(65)])(
      "rejects the invalid name %p",
      async (name) => {
        const response = await api.post("/admin/rbac/roles", { name }).expect(400);

        expect(response.body.code).toBe("validation_failed");
      },
    );

    it("rejects a description longer than 500 characters", async () => {
      await api.post("/admin/rbac/roles", { name: "editor", description: "x".repeat(501) }).expect(400);
    });

    it("answers 409 to a taken name after normalization", async () => {
      const response = await api.post("/admin/rbac/roles", { name: "USER" }).expect(409);

      expect(response.body.code).toBe("name_taken");
    });

    it("replaces the name and description", async () => {
      const { body } = await api.post("/admin/rbac/roles", { name: "editor" }).expect(201);

      const response = await api
        .put(`/admin/rbac/roles/${body.id}`, { name: "writer", description: "Writes" })
        .expect(200);

      expect(response.body).toMatchObject({ id: body.id, name: "writer", description: "Writes" });
    });

    it("answers 404 to replacing a missing role", async () => {
      const response = await api.put(`/admin/rbac/roles/${MISSING_ID}`, { name: "x" }).expect(404);

      expect(response.body.code).toBe("role_not_found");
    });

    it("does not delete a role with grants or users", async () => {
      const response = await api.delete(`/admin/rbac/roles/${await idOf("roles", "user")}`).expect(409);

      expect(response.body.code).toBe("in_use");
      expect(await idOf("roles", "user")).toBeDefined();
    });

    it("deletes an unused role once", async () => {
      const { body } = await api.post("/admin/rbac/roles", { name: "editor" }).expect(201);

      await api.delete(`/admin/rbac/roles/${body.id}`).expect(204);
      await api.delete(`/admin/rbac/roles/${body.id}`).expect(404);
    });
  });

  describe("permissions", () => {
    it("creates a permission with normalized sorted actions", async () => {
      const response = await api
        .post("/admin/rbac/permissions", { name: "Reports", actions: [" Read", "export"] })
        .expect(201);

      expect(response.body).toMatchObject({ name: "reports", actions: ["export", "read"] });
    });

    it.each([
      ["duplicates after normalization", ["read", " READ "]],
      ["an empty set", []],
      ["an invalid action", ["read all"]],
    ])("rejects %s", async (_case, actions) => {
      await api.post("/admin/rbac/permissions", { name: "reports", actions }).expect(400);
    });

    it("lists permissions with their actions", async () => {
      const response = await api.get("/admin/rbac/permissions").expect(200);

      expect(response.body.find((p: { name: string }) => p.name === "rbac").actions).toEqual(["manage"]);
    });

    it("replaces the action set and keeps grants on the remaining actions", async () => {
      const { id } = await createPermission("reports", ["read", "export"]);
      const role = (await api.post("/admin/rbac/roles", { name: "viewer" }).expect(201)).body;
      await api
        .post("/admin/rbac/grants", { roleId: role.id, permissionId: id, actions: ["read"] })
        .expect(201);
      await api.put(`/admin/rbac/users/${aliceId}/roles`, { roleIds: [role.id] }).expect(200);

      const response = await api
        .put(`/admin/rbac/permissions/${id}`, { name: "reports", actions: ["read", "share"] })
        .expect(200);

      expect(response.body.actions).toEqual(["read", "share"]);
      expect(await allowed(aliceId, "reports", "read")).toBe(true);
    });

    it("does not remove an action listed in a grant and changes nothing", async () => {
      const { id } = await createPermission("reports", ["read", "export"]);
      const role = (await api.post("/admin/rbac/roles", { name: "viewer" }).expect(201)).body;
      await api
        .post("/admin/rbac/grants", { roleId: role.id, permissionId: id, actions: ["read"] })
        .expect(201);

      const response = await api
        .put(`/admin/rbac/permissions/${id}`, { name: "renamed", actions: ["export"] })
        .expect(409);

      expect(response.body.code).toBe("action_in_use");
      const [permission] = (await api.get("/admin/rbac/permissions").expect(200)).body.filter(
        (p: { id: string }) => p.id === id,
      );
      expect(permission).toMatchObject({ name: "reports", actions: ["export", "read"] });
    });

    it("lets an all-actions grant follow a removed action", async () => {
      // delete явно перечислено в назначении роли user
      await api
        .put(`/admin/rbac/permissions/${await idOf("permissions", "users")}`, {
          name: "users",
          actions: ["read", "read_any", "update", "update_any", "delete_any", "list"],
        })
        .expect(409);

      // delete_any входит только в назначение admin со всеми действиями
      const response = await api
        .put(`/admin/rbac/permissions/${await idOf("permissions", "users")}`, {
          name: "users",
          actions: ["read", "read_any", "update", "update_any", "delete", "list", "export"],
        })
        .expect(200);

      expect(response.body.actions).not.toContain("delete_any");
      expect(await allowed(adminId, "users", "delete_any")).toBe(false);
      expect(await allowed(adminId, "users", "export")).toBe(true);
    });

    it("does not delete a granted permission and deletes an unused one", async () => {
      await api.delete(`/admin/rbac/permissions/${await idOf("permissions", "users")}`).expect(409);

      const { id } = await createPermission("reports", ["read"]);
      await api.delete(`/admin/rbac/permissions/${id}`).expect(204);
      await api.delete(`/admin/rbac/permissions/${id}`).expect(404);
    });
  });

  describe("grants", () => {
    it("creates a grant with selected actions that applies without a new token", async () => {
      const { id: permissionId } = await createPermission("reports", ["read", "export"]);
      const userRoleId = await idOf("roles", "user");
      expect(await allowed(aliceId, "reports", "read")).toBe(false);

      const response = await api
        .post("/admin/rbac/grants", { roleId: userRoleId, permissionId, actions: ["READ"] })
        .expect(201);

      expect(response.body).toMatchObject({ allActions: false, actions: ["read"] });
      expect(await allowed(aliceId, "reports", "read")).toBe(true);
      expect(await allowed(aliceId, "reports", "export")).toBe(false);
    });

    it.each([[undefined], [[]]])("treats actions %p as all actions", async (actions) => {
      const { id: permissionId } = await createPermission("reports", ["read"]);

      const response = await api
        .post("/admin/rbac/grants", { roleId: await idOf("roles", "user"), permissionId, actions })
        .expect(201);

      expect(response.body).toMatchObject({ allActions: true, actions: [] });
    });

    it("rejects an action of another permission", async () => {
      const { id: permissionId } = await createPermission("reports", ["read"]);

      const response = await api
        .post("/admin/rbac/grants", {
          roleId: await idOf("roles", "user"),
          permissionId,
          actions: ["read", "manage"],
        })
        .expect(400);

      expect(response.body.code).toBe("unknown_action");
    });

    it.each([
      ["role", { roleId: MISSING_ID }],
      ["permission", { permissionId: MISSING_ID }],
    ])("answers 404 to a missing %s", async (entity, override) => {
      const { id: permissionId } = await createPermission("reports", ["read"]);

      const response = await api
        .post("/admin/rbac/grants", { roleId: await idOf("roles", "user"), permissionId, ...override })
        .expect(404);

      expect(response.body.code).toBe(`${entity}_not_found`);
    });

    it("answers 409 to a second grant for the same pair", async () => {
      const response = await api
        .post("/admin/rbac/grants", {
          roleId: await idOf("roles", "user"),
          permissionId: await idOf("permissions", "users"),
        })
        .expect(409);

      expect(response.body.code).toBe("grant_exists");
    });

    it("replaces and deletes a grant", async () => {
      const { id: permissionId } = await createPermission("reports", ["read", "export"]);
      const roleId = await idOf("roles", "user");
      const { body } = await api
        .post("/admin/rbac/grants", { roleId, permissionId, actions: ["read"] })
        .expect(201);

      const replaced = await api
        .put(`/admin/rbac/grants/${body.id}`, { roleId, permissionId, actions: ["export"] })
        .expect(200);
      expect(replaced.body).toMatchObject({ id: body.id, allActions: false, actions: ["export"] });
      expect(await allowed(aliceId, "reports", "read")).toBe(false);

      await api.delete(`/admin/rbac/grants/${body.id}`).expect(204);
      await api.delete(`/admin/rbac/grants/${body.id}`).expect(404);
      expect(await allowed(aliceId, "reports", "export")).toBe(false);
    });

    it("lists grants with allActions and actions", async () => {
      const response = await api.get("/admin/rbac/grants").expect(200);

      expect(response.body).toHaveLength(3);
      expect(response.body).toContainEqual(
        expect.objectContaining({ allActions: false, actions: ["delete", "read", "update"] }),
      );
    });
  });

  describe("user roles", () => {
    it("returns only role ids of an existing user", async () => {
      const response = await api.get(`/admin/rbac/users/${aliceId}/roles`).expect(200);

      expect(response.body).toEqual({ userId: aliceId, roleIds: [await idOf("roles", "user")] });
    });

    it("answers 404 to a missing user and logs the rejection", async () => {
      const response = await api.get(`/admin/rbac/users/${MISSING_ID}/roles`).expect(404);

      expect(response.body.code).toBe("user_not_found");
      expect(logs().join("\n")).toContain(
        `RBAC change result=rejected operation=user_roles.read entity=user_roles entityId=${MISSING_ID} actorUserId=${adminId} status=404 code=user_not_found`,
      );
    });

    it("replaces the roles and clears them with an empty list", async () => {
      const editor = (await api.post("/admin/rbac/roles", { name: "editor" }).expect(201)).body;

      await api
        .put(`/admin/rbac/users/${aliceId}/roles`, { roleIds: [editor.id] })
        .expect(200, { userId: aliceId, roleIds: [editor.id] });
      expect(await allowed(aliceId, "users", "read")).toBe(false);

      await api
        .put(`/admin/rbac/users/${aliceId}/roles`, { roleIds: [] })
        .expect(200, { userId: aliceId, roleIds: [] });
    });

    it("answers 404 to a missing role and 400 to a repeated one", async () => {
      const userRoleId = await idOf("roles", "user");

      await api.put(`/admin/rbac/users/${aliceId}/roles`, { roleIds: [MISSING_ID] }).expect(404);
      await api
        .put(`/admin/rbac/users/${aliceId}/roles`, { roleIds: [userRoleId, userRoleId] })
        .expect(400);
    });
  });

  describe("last rbac manager", () => {
    async function expectLastManager(response: request.Response) {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("last_rbac_manager");
      expect(await allowed(adminId, "rbac", "manage")).toBe(true);
    }

    it("keeps the roles of the only admin", async () => {
      await expectLastManager(await api.put(`/admin/rbac/users/${adminId}/roles`, { roleIds: [] }));
    });

    it("keeps the rbac grant of the admin role", async () => {
      await expectLastManager(await api.delete(`/admin/rbac/grants/${await adminGrantId("rbac")}`));
    });

    it("keeps the rbac grant from moving to another permission", async () => {
      await expectLastManager(
        await api.put(`/admin/rbac/grants/${await adminGrantId("rbac")}`, {
          roleId: await idOf("roles", "admin"),
          permissionId: (await createPermission("reports", ["read"])).id,
        }),
      );
    });

    it("keeps the rbac permission name", async () => {
      await expectLastManager(
        await api.put(`/admin/rbac/permissions/${await idOf("permissions", "rbac")}`, {
          name: "access",
          actions: ["manage"],
        }),
      );
    });

    it("does not count a blocked admin", async () => {
      const [{ id: bobId }] = await db.query(
        `INSERT INTO users (email, status, password_hash) VALUES ('bob@gmail.com', 'blocked', 'hash') RETURNING id`,
      );
      await api
        .put(`/admin/rbac/users/${bobId}/roles`, { roleIds: [await idOf("roles", "admin")] })
        .expect(200);

      await expectLastManager(await api.put(`/admin/rbac/users/${adminId}/roles`, { roleIds: [] }));
    });

    it("lets an admin step down once another active admin exists", async () => {
      const adminRoleId = await idOf("roles", "admin");
      await api.put(`/admin/rbac/users/${aliceId}/roles`, { roleIds: [adminRoleId] }).expect(200);

      await api.put(`/admin/rbac/users/${adminId}/roles`, { roleIds: [] }).expect(200);

      expect(await allowed(adminId, "rbac", "manage")).toBe(false);
      expect(await allowed(aliceId, "rbac", "manage")).toBe(true);
    });
  });

  describe("rejections before and outside the service", () => {
    const connectionRefused = () =>
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

    it("logs a body validation failure with the actor and the operation", async () => {
      await api.post("/admin/rbac/roles", { name: "" }).expect(400);

      expect(logs().join("\n")).toContain(
        `RBAC change result=rejected operation=role.create entity=role entityId=undefined actorUserId=${adminId} status=400 code=validation_failed`,
      );
    });

    it("logs an invalid id without writing it to the log", async () => {
      await api.put("/admin/rbac/roles/not-a-uuid%0Afake", { name: "x" }).expect(400);

      const text = logs().join("\n");
      expect(text).toContain(
        `RBAC change result=rejected operation=role.replace entity=role entityId=invalid actorUserId=${adminId} status=400 code=bad_request`,
      );
      expect(text).not.toContain("not-a-uuid");
    });

    it("logs a rejection from the service once", async () => {
      const { id: permissionId } = await createPermission("reports", ["read"]);

      await api
        .post("/admin/rbac/grants", {
          roleId: await idOf("roles", "user"),
          permissionId,
          actions: ["manage"],
        })
        .expect(400);

      expect(logs().filter((line) => line.includes("code=unknown_action"))).toHaveLength(1);
    });

    it("answers 503 when the database fails during a change", async () => {
      serviceSpies.push(
        jest.spyOn(app.get(DataSource), "transaction").mockRejectedValueOnce(connectionRefused()),
      );

      const response = await api.post("/admin/rbac/roles", { name: "editor" }).expect(503);

      expect(response.body).toEqual({
        statusCode: 503,
        code: "rbac_unavailable",
        message: "RBAC is temporarily unavailable",
      });
      expect(logs().join("\n")).toContain(
        `RBAC change result=rejected operation=role.create entity=role entityId=undefined actorUserId=${adminId} status=503 code=rbac_unavailable`,
      );
    });

    it("answers 503 when the database fails during a read", async () => {
      serviceSpies.push(
        jest
          .spyOn(app.get<Repository<Role>>(getRepositoryToken(Role)), "find")
          .mockRejectedValueOnce(connectionRefused()),
      );

      const response = await api.get("/admin/rbac/roles").expect(503);

      expect(response.body.code).toBe("rbac_unavailable");
      expect(logs().join("\n")).toContain(
        `RBAC change result=rejected operation=role.list entity=role entityId=undefined actorUserId=${adminId} status=503 code=rbac_unavailable`,
      );
    });

    it("keeps answering 500 to an unexpected error", async () => {
      serviceSpies.push(
        jest
          .spyOn(app.get<Repository<Role>>(getRepositoryToken(Role)), "find")
          .mockRejectedValueOnce(new TypeError("unexpected")),
      );

      await api.get("/admin/rbac/roles").expect(500);
    });
  });

  describe("policy version and audit", () => {
    it("raises the version and logs a successful change without the description", async () => {
      const before = await version();

      const { body } = await api
        .post("/admin/rbac/roles", { name: "editor", description: "secret note" })
        .expect(201);

      const after = await version();
      expect(after).toBeGreaterThan(before);
      const text = logs().join("\n");
      expect(text).toContain(
        `RBAC change result=success operation=role.create entity=role entityId=${body.id} actorUserId=${adminId} policyVersion=${after}`,
      );
      expect(text).not.toContain("secret note");
    });

    it("keeps the version and logs a rejected change", async () => {
      const before = await version();

      await api.post("/admin/rbac/roles", { name: "user" }).expect(409);

      expect(await version()).toBe(before);
      expect(logs().join("\n")).toContain(
        `RBAC change result=rejected operation=role.create entity=role entityId=undefined actorUserId=${adminId} status=409 code=name_taken`,
      );
    });
  });
});
