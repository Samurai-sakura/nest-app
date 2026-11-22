import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { RbacBootstrapService } from "../src/access-control/rbac/services/rbac-bootstrap.service";
import { TokenService } from "../src/identity/authentication/services/token.service";
import {
  PROFILE_UPDATE_LIMIT,
  ProfileUpdateLimiter,
} from "../src/users/services/profile-update-limiter.service";
import { createTestApp } from "./helpers/create-test-app";
import { resetRbac } from "./helpers/rbac";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const PROFILE_FIELDS = ["createdAt", "displayName", "email", "id", "photoUrl", "status", "updatedAt"];

describe("User profile update (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let adminId: string;
  let aliceId: string;
  let bobId: string;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    await resetRbac(db);
    [{ id: adminId }, { id: aliceId }, { id: bobId }] = await db.query(
      `INSERT INTO users (email, status, password_hash, display_name) VALUES
         ('admin@gmail.com', 'active', 'hash', NULL),
         ('alice@gmail.com', 'active', 'hash', 'Alice'),
         ('bob@gmail.com', 'active', 'hash', NULL)
       RETURNING id`,
    );
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = adminId;
    await app.get(RbacBootstrapService).bootstrap();
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = "";
    (app.get(ProfileUpdateLimiter) as unknown as { requests: Map<string, number[]> }).requests.clear();
    logged.forEach((spy) => spy.mockClear());
  });

  const http = () => request(app.getHttpServer());
  const tokens = (userId: string) => app.get(TokenService).signPair(userId);
  const patch = (actor: string, target: string, body: unknown) =>
    http()
      .patch(`/users/${target}`)
      .set("Cookie", `access_token=${tokens(actor).accessToken}`)
      .send(body as object);

  const row = async (userId: string) =>
    (
      await db.query(
        `SELECT email, display_name, status, updated_at FROM users WHERE id = $1`,
        [userId],
      )
    )[0];

  const setStatus = (userId: string, status: string) =>
    db.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);

  const logs = () => logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  describe("self", () => {
    it("changes the normalized displayName and returns the safe profile", async () => {
      const before = await row(aliceId);

      const response = await patch(aliceId, aliceId, { displayName: "  Alicia  " }).expect(200);

      expect(Object.keys(response.body).sort()).toEqual(PROFILE_FIELDS);
      expect(response.body).toMatchObject({
        id: aliceId,
        email: "alice@gmail.com",
        displayName: "Alicia",
        photoUrl: null,
        status: "active",
      });
      expect(JSON.stringify(response.body)).not.toContain("hash");
      const after = await row(aliceId);
      expect(after.display_name).toBe("Alicia");
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });

    it("clears displayName with null", async () => {
      const response = await patch(aliceId, aliceId, { displayName: null }).expect(200);

      expect(response.body.displayName).toBeNull();
      expect((await row(aliceId)).display_name).toBeNull();
    });

    it("keeps updatedAt on a no-op", async () => {
      const before = await row(aliceId);

      const response = await patch(aliceId, aliceId, { displayName: "Alice" }).expect(200);

      expect(new Date(response.body.updatedAt).getTime()).toBe(before.updated_at.getTime());
      expect((await row(aliceId)).updated_at.getTime()).toBe(before.updated_at.getTime());
    });

    it.each([
      ["email", { email: "new@gmail.com" }],
      ["status", { status: "blocked" }],
      ["email next to displayName", { displayName: "Alicia", email: "new@gmail.com" }],
    ])("answers 403 when Self sends %s without users@update_any", async (_case, body) => {
      const response = await patch(aliceId, aliceId, body).expect(403);

      expect(response.body.code).toBe("permission_denied");
      expect(await row(aliceId)).toMatchObject({
        email: "alice@gmail.com",
        display_name: "Alice",
        status: "active",
      });
    });

    it("logs the change with field names only", async () => {
      await patch(aliceId, aliceId, { displayName: "Secret Name" }).expect(200);

      const text = logs().join("\n");
      expect(text).toMatch(
        new RegExp(
          `User update result=success operation=users.update scope=self actorUserId=${aliceId} targetUserId=${aliceId} fields=displayName durationMs=\\d+`,
        ),
      );
      expect(text).not.toContain("Secret Name");
    });
  });

  describe("foreign target", () => {
    it("answers the same 403 for an existing and a missing user without users@update_any", async () => {
      const existing = await patch(aliceId, bobId, { displayName: "Bobby" }).expect(403);
      const missing = await patch(aliceId, MISSING_ID, { displayName: "Bobby" }).expect(403);

      expect(existing.body).toEqual(missing.body);
      expect((await row(bobId)).display_name).toBeNull();
      expect(logs().join("\n")).toContain(
        `User update result=forbidden operation=users.update scope=foreign actorUserId=${aliceId} targetUserId=${bobId} fields=displayName code=permission_denied`,
      );
    });

    it("answers 404 only after users@update_any", async () => {
      const response = await patch(adminId, MISSING_ID, { displayName: "Ghost" }).expect(404);

      expect(response.body.code).toBe("user_not_found");
    });

    it("lets an admin change displayName, email and status at once", async () => {
      const response = await patch(adminId, aliceId, {
        displayName: "Alicia",
        email: "  Alice+Work@Gmail.COM ",
        status: "blocked",
      }).expect(200);

      expect(response.body).toMatchObject({
        displayName: "Alicia",
        email: "alice+work@gmail.com",
        status: "blocked",
      });
      expect(logs().join("\n")).toContain(
        `User update result=success operation=users.update scope=foreign actorUserId=${adminId} targetUserId=${aliceId} fields=displayName,email,status`,
      );
    });

    it("treats the current email in another case as a no-op", async () => {
      const before = await row(aliceId);

      await patch(adminId, aliceId, { email: "ALICE@gmail.com" }).expect(200);

      expect((await row(aliceId)).updated_at.getTime()).toBe(before.updated_at.getTime());
    });

    it.each(["pending", "deleting", "deleted"])("answers 409 for a %s target", async (status) => {
      await setStatus(bobId, status);

      const response = await patch(adminId, bobId, { displayName: "Bobby" }).expect(409);

      expect(response.body.code).toBe("user_state_conflict");
    });
  });

  describe("email uniqueness", () => {
    it("answers 409 when the email belongs to another user", async () => {
      const response = await patch(adminId, aliceId, { email: "bob@gmail.com" }).expect(409);

      expect(response.body.code).toBe("email_taken");
      expect((await row(aliceId)).email).toBe("alice@gmail.com");
    });

    it("lets exactly one of two parallel changes to the same email win", async () => {
      const responses = await Promise.all([
        patch(adminId, aliceId, { email: "race@gmail.com" }),
        patch(adminId, bobId, { email: "race@gmail.com" }),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const [{ count }] = await db.query(
        `SELECT count(*)::int AS count FROM users WHERE email = 'race@gmail.com'`,
      );
      expect(count).toBe(1);
    });
  });

  describe("blocking", () => {
    it("ends access and refresh of the blocked user", async () => {
      const bob = tokens(bobId);

      await patch(adminId, bobId, { status: "blocked" }).expect(200);

      await http()
        .get(`/users/${bobId}`)
        .set("Cookie", `access_token=${bob.accessToken}`)
        .expect(401);
      await http()
        .post("/auth/refresh")
        .set("Cookie", `refresh_token=${bob.refreshToken}`)
        .expect(401);
    });

    it("consumes pending login and email-change challenges as user_inactive", async () => {
      await db.query(
        `INSERT INTO login_challenges (user_id, method, secret_hash, last_sent_at)
         VALUES ($1, 'otp', 'hash', now())`,
        [bobId],
      );
      await db.query(
        `INSERT INTO email_change_challenges (user_id, new_email, method, secret_hash, last_sent_at)
         VALUES ($1, 'bob.new@gmail.com', 'otp', 'hash', now())`,
        [bobId],
      );

      await patch(adminId, bobId, { status: "blocked" }).expect(200);

      for (const table of ["login_challenges", "email_change_challenges"]) {
        const [challenge] = await db.query(
          `SELECT consumed_at, consumed_reason FROM ${table} WHERE user_id = $1`,
          [bobId],
        );
        expect(challenge.consumed_at).not.toBeNull();
        expect(challenge.consumed_reason).toBe("user_inactive");
      }
    });

    it("logs the active -> blocked transition", async () => {
      await patch(adminId, bobId, { status: "blocked" }).expect(200);

      expect(logs().join("\n")).toContain(
        `User status changed transition=active->blocked userId=${bobId}`,
      );
    });

    it("unblocks a blocked user", async () => {
      await setStatus(bobId, "blocked");

      const response = await patch(adminId, bobId, { status: "active" }).expect(200);

      expect(response.body.status).toBe("active");
    });

    it("refuses to block the last active user with rbac@manage", async () => {
      const response = await patch(adminId, adminId, { status: "blocked" }).expect(409);

      expect(response.body.code).toBe("last_rbac_manager");
      expect((await row(adminId)).status).toBe("active");
      expect(logs().join("\n")).not.toContain("User status changed");
    });
  });

  it("consumes the target's email-change challenge as admin_override on a direct email change", async () => {
    await db.query(
      `INSERT INTO email_change_challenges (user_id, new_email, method, secret_hash, last_sent_at)
       VALUES ($1, 'alice.self@gmail.com', 'otp', 'hash', now())`,
      [aliceId],
    );

    await patch(adminId, aliceId, { email: "alice.admin@gmail.com" }).expect(200);

    const [challenge] = await db.query(
      `SELECT consumed_reason FROM email_change_challenges WHERE user_id = $1`,
      [aliceId],
    );
    expect(challenge.consumed_reason).toBe("admin_override");
  });

  describe("validation", () => {
    it.each([
      ["an empty body", {}, "empty_update"],
      ["id", { displayName: "A", id: "x" }, "unknown_field"],
      ["password", { displayName: "A", password: "Passw0rd" }, "unknown_field"],
      ["photoUrl", { photoUrl: "http://evil" }, "unknown_field"],
      ["an array", [{ displayName: "A" }], undefined],
      ["email: null", { email: null }, undefined],
      ["status: null", { status: null }, undefined],
      ["status: pending", { status: "pending" }, undefined],
      ["a whitespace-only displayName", { displayName: "   " }, undefined],
      ["a too long displayName", { displayName: "a".repeat(81) }, undefined],
      ["an invalid email", { email: "not-an-email" }, undefined],
    ])("answers 400 to %s without changes", async (_case, body, code) => {
      const before = await row(aliceId);

      const response = await patch(adminId, aliceId, body).expect(400);

      if (code) {
        expect(response.body.code).toBe(code);
      }
      expect(await row(aliceId)).toEqual(before);
    });

    it("does not log the values or the names of unknown fields", async () => {
      await patch(aliceId, aliceId, { displayName: "A", password: "Passw0rd" }).expect(400);

      const text = logs().join("\n");
      expect(text).toContain(
        `User update result=invalid operation=users.update scope=self actorUserId=${aliceId} targetUserId=${aliceId} fields=displayName code=unknown_field`,
      );
      expect(text).not.toContain("Passw0rd");
    });

    it.each([
      ["a repeated field", '{"displayName":"First","displayName":"Second"}'],
      ["an escaped spelling of the same field", '{"displayName":"First","\\u0064isplayName":"Second"}'],
    ])("answers 400 duplicate_field to %s without changes", async (_case, raw) => {
      const before = await row(aliceId);

      const response = await http()
        .patch(`/users/${aliceId}`)
        .set("Cookie", `access_token=${tokens(aliceId).accessToken}`)
        .set("Content-Type", "application/json")
        .send(raw)
        .expect(400);

      expect(response.body).toEqual({
        statusCode: 400,
        code: "duplicate_field",
        message: "Request body contains a repeated field",
      });
      expect(await row(aliceId)).toEqual(before);
      const text = logs().join("\n");
      expect(text).toContain(
        `User update result=invalid operation=users.update scope=self actorUserId=${aliceId} targetUserId=${aliceId} fields=displayName code=duplicate_field`,
      );
      expect(text).not.toContain("Second");
    });

    it("answers 401 without a session", async () => {
      await http().patch(`/users/${aliceId}`).send({ displayName: "A" }).expect(401);
    });
  });

  it(`allows ${PROFILE_UPDATE_LIMIT} changes an hour and answers 429 to the next one`, async () => {
    for (let i = 0; i < PROFILE_UPDATE_LIMIT; i++) {
      await patch(aliceId, aliceId, { displayName: `Alice ${i}` }).expect(200);
    }

    const response = await patch(aliceId, aliceId, { displayName: "One more" }).expect(429);

    expect(response.body).toMatchObject({ statusCode: 429, code: "rate_limited" });
    expect(response.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(logs().join("\n")).toContain(
      `User update result=rate_limited operation=users.update scope=self actorUserId=${aliceId} targetUserId=${aliceId} fields=displayName code=rate_limited`,
    );
  });
});
