import { INestApplication, Logger } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import { DataSource, Repository } from "typeorm";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { User } from "../src/users/entities/user.entity";
import { RbacBootstrapService } from "../src/access-control/rbac/services/rbac-bootstrap.service";
import { TokenService } from "../src/identity/authentication/services/token.service";
import { PROFILE_READ_LIMITS } from "../src/users/services/profile-read-limiter.service";
import { createTestApp } from "./helpers/create-test-app";
import { resetRbac } from "./helpers/rbac";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const PHOTO_BYTES = Buffer.from("RIFF0000WEBPVP8 fake-photo-bytes");
const PROFILE_FIELDS = ["createdAt", "displayName", "email", "id", "photoUrl", "status", "updatedAt"];

describe("User profile and photo (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  const serviceSpies: jest.SpyInstance[] = [];
  const photoDir = process.env.PHOTO_STORAGE_DIR!;
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
    await rm(photoDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    await resetRbac(db);
    await rm(photoDir, { recursive: true, force: true });
    await mkdir(photoDir, { recursive: true });
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
    logged.forEach((spy) => spy.mockClear());
  });

  afterEach(() => {
    serviceSpies.splice(0).forEach((spy) => spy.mockRestore());
  });

  const http = () => request(app.getHttpServer());
  const cookie = (userId: string) =>
    `access_token=${app.get(TokenService).signPair(userId).accessToken}`;
  const profile = (actor: string, target: string) =>
    http().get(`/users/${target}`).set("Cookie", cookie(actor));
  const photo = (actor: string, target: string) =>
    http().get(`/users/${target}/photo`).set("Cookie", cookie(actor));

  async function storePhoto(userId: string, key = `${userId}/photo.webp`) {
    await mkdir(join(photoDir, userId), { recursive: true });
    await writeFile(join(photoDir, key), PHOTO_BYTES);
    await db.query(`UPDATE users SET photo_key = $1 WHERE id = $2`, [key, userId]);
  }

  const setStatus = (userId: string, status: string) =>
    db.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  const connectionRefused = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

  describe("profile", () => {
    it("returns exactly the seven profile fields of the own profile", async () => {
      const response = await profile(aliceId, aliceId).expect(200);

      expect(Object.keys(response.body).sort()).toEqual(PROFILE_FIELDS);
      expect(response.body).toMatchObject({
        id: aliceId,
        email: "alice@gmail.com",
        displayName: "Alice",
        photoUrl: null,
        status: "active",
      });
      expect(JSON.stringify(response.body)).not.toContain("hash");
    });

    it("builds photoUrl from PUBLIC_API_BASE_URL without the storage key", async () => {
      await storePhoto(aliceId);

      const response = await profile(aliceId, aliceId).expect(200);

      expect(response.body.photoUrl).toBe(`http://localhost:3200/users/${aliceId}/photo`);
      expect(JSON.stringify(response.body)).not.toContain("photo.webp");
    });

    it("does not log reading the own profile", async () => {
      await profile(aliceId, aliceId).expect(200);

      expect(logs().join("\n")).not.toContain("User read result=success");
    });

    it("requires users@read even for the own profile", async () => {
      await db.query(`DELETE FROM user_roles WHERE user_id = $1`, [aliceId]);

      const response = await profile(aliceId, aliceId).expect(403);

      expect(response.body.code).toBe("permission_denied");
    });

    it.each(["existing", "missing"])(
      "answers the same 403 to a %s foreign id without users@read_any",
      async (kind) => {
        const target = kind === "existing" ? bobId : MISSING_ID;

        const response = await profile(aliceId, target).expect(403);

        expect(response.body).toEqual({
          statusCode: 403,
          code: "permission_denied",
          message: "Permission denied",
        });
        const text = logs().join("\n");
        expect(text).toContain(
          `User read result=forbidden operation=users.profile scope=foreign actorUserId=${aliceId} code=permission_denied`,
        );
        expect(text).not.toContain(`targetUserId=${target}`);
      },
    );

    it("lets users@read_any read a foreign profile and logs it with the duration", async () => {
      const response = await profile(adminId, aliceId).expect(200);

      expect(response.body).toMatchObject({ id: aliceId, email: "alice@gmail.com" });
      const text = logs().join("\n");
      expect(text).toMatch(
        new RegExp(
          `User read result=success operation=users.profile scope=foreign actorUserId=${adminId} targetUserId=${aliceId} durationMs=\\d+`,
        ),
      );
      expect(text).not.toContain("alice@gmail.com");
      expect(text).not.toContain("Alice");
    });

    it("answers 404 only after the permission checks", async () => {
      const response = await profile(adminId, MISSING_ID).expect(404);

      expect(response.body).toEqual({
        statusCode: 404,
        code: "user_not_found",
        message: "User not found",
      });
      expect(logs().join("\n")).toContain(
        `User read result=not_found operation=users.profile scope=foreign actorUserId=${adminId} targetUserId=${MISSING_ID} code=user_not_found`,
      );
    });

    it.each(["pending", "active", "blocked", "deleting", "deleted"])(
      "shows a %s target to a user with users@read_any",
      async (status) => {
        await storePhoto(bobId);
        await setStatus(bobId, status);

        const response = await profile(adminId, bobId).expect(200);

        expect(response.body.status).toBe(status);
        expect(response.body.photoUrl).toBe(
          ["deleting", "deleted"].includes(status)
            ? null
            : `http://localhost:3200/users/${bobId}/photo`,
        );
      },
    );

    it("answers 400 to an invalid id and 401 without a session", async () => {
      await profile(aliceId, "not-a-uuid").expect(400);
      await http().get(`/users/${aliceId}`).expect(401);
    });

    it("answers 503 when the database is unavailable", async () => {
      const repository = app.get<Repository<User>>(getRepositoryToken(User));
      const findOne = repository.findOne.bind(repository);
      serviceSpies.push(
        jest
          .spyOn(repository, "findOne")
          .mockImplementationOnce(findOne)
          .mockRejectedValueOnce(connectionRefused()),
      );

      const response = await profile(adminId, aliceId).expect(503);

      expect(response.body.code).toBe("users_unavailable");
      expect(logs().join("\n")).toContain(
        `User read result=unavailable operation=users.profile scope=foreign actorUserId=${adminId} targetUserId=${aliceId} code=users_unavailable`,
      );
    });
  });

  describe("photo", () => {
    it("streams the WebP with the protective headers", async () => {
      await storePhoto(aliceId);

      const response = await photo(aliceId, aliceId)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers["content-type"]).toBe("image/webp");
      expect(response.headers["content-length"]).toBe(String(PHOTO_BYTES.length));
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("private, max-age=300");
      expect((response.body as Buffer).equals(PHOTO_BYTES)).toBe(true);
    });

    it("lets users@read_any read a foreign photo and logs it", async () => {
      await storePhoto(bobId);

      await photo(adminId, bobId).expect(200);

      expect(logs().join("\n")).toContain(
        `User read result=success operation=users.photo scope=foreign actorUserId=${adminId} targetUserId=${bobId}`,
      );
    });

    it("answers 403 to a foreign photo without users@read_any", async () => {
      await storePhoto(bobId);

      await photo(aliceId, bobId).expect(403);
    });

    it.each([
      { name: "a user without a photo", target: "bob", photo: false, status: "active" },
      { name: "a missing user", target: "missing", photo: false, status: "active" },
      { name: "a deleting user", target: "bob", photo: true, status: "deleting" },
      { name: "a deleted user", target: "bob", photo: true, status: "deleted" },
    ])("answers 404 for $name without touching the storage", async ({ target, photo: withPhoto, status }) => {
      if (withPhoto) {
        await storePhoto(bobId);
      }
      await setStatus(bobId, status);

      const response = await photo(adminId, target === "bob" ? bobId : MISSING_ID).expect(404);

      expect(response.body).toEqual({
        statusCode: 404,
        code: "photo_not_found",
        message: "Photo not found",
      });
      expect(response.headers["cache-control"]).toBeUndefined();
    });

    it("answers 503 when the stored object is missing and logs the inconsistency", async () => {
      await db.query(`UPDATE users SET photo_key = 'gone/photo.webp' WHERE id = $1`, [aliceId]);

      const response = await photo(aliceId, aliceId).expect(503);

      expect(response.body.code).toBe("photo_unavailable");
      expect(response.headers["cache-control"]).toBeUndefined();
      const text = logs().join("\n");
      expect(text).toContain(`Photo inconsistent reason=object_missing userId=${aliceId}`);
      expect(text).not.toContain("gone/photo.webp");
    });
  });

  describe("rate limit", () => {
    it(`allows ${PROFILE_READ_LIMITS.self} own reads a minute across profile and photo`, async () => {
      await storePhoto(aliceId);
      for (let i = 0; i < PROFILE_READ_LIMITS.self; i++) {
        await (i % 2 === 0 ? profile(aliceId, aliceId) : photo(aliceId, aliceId)).expect(200);
      }

      const response = await profile(aliceId, aliceId).expect(429);

      expect(response.body).toMatchObject({ statusCode: 429, code: "rate_limited" });
      expect(response.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(logs().join("\n")).toContain(
        `User read result=rate_limited operation=users.profile scope=self actorUserId=${aliceId} code=rate_limited`,
      );
    });

    it(`counts foreign reads without users@read_any against the ${PROFILE_READ_LIMITS.foreign} limit`, async () => {
      for (let i = 0; i < PROFILE_READ_LIMITS.foreign; i++) {
        await profile(aliceId, MISSING_ID).expect(403);
      }

      await profile(aliceId, MISSING_ID).expect(429);
      await profile(aliceId, aliceId).expect(200);
    });
  });
});
