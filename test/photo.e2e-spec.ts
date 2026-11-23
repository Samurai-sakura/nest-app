import { INestApplication, Logger } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { mkdir, readdir, rm, utimes, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import request from "supertest";
import { DataSource } from "typeorm";
import { RbacBootstrapService } from "../src/access-control/rbac/services/rbac-bootstrap.service";
import { TokenService } from "../src/identity/authentication/services/token.service";
import { StorageCleanupWorker } from "../src/storage/storage-cleanup.worker";
import {
  PROFILE_UPDATE_LIMIT,
  ProfileUpdateLimiter,
} from "../src/users/services/profile-update-limiter.service";
import { createTestApp } from "./helpers/create-test-app";
import { resetRbac } from "./helpers/rbac";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const PHOTO_DIR = process.env.PHOTO_STORAGE_DIR!;

function image(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 128, b: 255 } } });
}

function binary(res: request.Response, callback: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}

describe("Profile photo (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let adminId: string;
  let aliceId: string;
  let bobId: string;
  let png: Buffer;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp());
    const scheduler = app.get(SchedulerRegistry);
    scheduler.deleteInterval("storage-cleanup");
    scheduler.deleteInterval("storage-reconcile");
    png = await image(300, 200).png().toBuffer();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users, storage_cleanup_jobs CASCADE`);
    await resetRbac(db);
    [{ id: adminId }, { id: aliceId }, { id: bobId }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES
         ('admin@gmail.com', 'active', 'hash'),
         ('alice@gmail.com', 'active', 'hash'),
         ('bob@gmail.com', 'active', 'hash')
       RETURNING id`,
    );
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = adminId;
    await app.get(RbacBootstrapService).bootstrap();
    process.env.RBAC_BOOTSTRAP_ADMIN_USER_ID = "";
    (app.get(ProfileUpdateLimiter) as unknown as { requests: Map<string, number[]> }).requests.clear();
    await rm(PHOTO_DIR, { recursive: true, force: true });
    await mkdir(PHOTO_DIR, { recursive: true });
    logged.forEach((spy) => spy.mockClear());
  });

  const http = () => request(app.getHttpServer());
  const cookie = (userId: string) =>
    `access_token=${app.get(TokenService).signPair(userId).accessToken}`;
  const upload = (
    actor: string,
    target: string,
    file: Buffer = png,
    contentType = "image/png",
  ) =>
    http()
      .put(`/users/${target}/photo`)
      .set("Cookie", cookie(actor))
      .attach("file", file, { filename: "holiday-at-the-sea.png", contentType });
  const remove = (actor: string, target: string) =>
    http().delete(`/users/${target}/photo`).set("Cookie", cookie(actor));
  const getPhoto = (actor: string, target: string) =>
    http().get(`/users/${target}/photo`).set("Cookie", cookie(actor)).buffer(true).parse(binary);

  const row = async (userId: string) =>
    (await db.query(`SELECT photo_key, updated_at FROM users WHERE id = $1`, [userId]))[0];
  const jobs = () =>
    db.query(`SELECT object_key, reason, status, attempts FROM storage_cleanup_jobs ORDER BY created_at`);
  const stored = () => readdir(PHOTO_DIR);
  const setStatus = (userId: string, status: string) =>
    db.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);
  const logs = () => logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
  const worker = () => app.get(StorageCleanupWorker);

  describe("upload", () => {
    it("stores a normalized WebP under an opaque key and returns the profile", async () => {
      const response = await upload(aliceId, aliceId).expect(200);

      expect(response.body).toMatchObject({
        id: aliceId,
        photoUrl: `http://localhost:3200/users/${aliceId}/photo`,
        status: "active",
      });
      const { photo_key: key } = await row(aliceId);
      expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(key).not.toContain(aliceId);
      expect(await stored()).toEqual([key]);
      expect(JSON.stringify(response.body)).not.toContain(key);

      const photo = await getPhoto(aliceId, aliceId).expect(200);
      expect(photo.headers["content-type"]).toBe("image/webp");
      expect(await sharp(photo.body as Buffer).metadata()).toMatchObject({
        format: "webp",
        width: 300,
        height: 200,
      });
    });

    it("applies EXIF orientation, drops metadata and shrinks into 1024×1024", async () => {
      const jpeg = await image(2400, 1200).jpeg().withMetadata({ orientation: 6 }).toBuffer();

      await upload(aliceId, aliceId, jpeg, "image/jpeg").expect(200);

      const photo = await getPhoto(aliceId, aliceId).expect(200);
      const metadata = await sharp(photo.body as Buffer).metadata();
      expect(metadata).toMatchObject({ width: 512, height: 1024 });
      expect(metadata.exif).toBeUndefined();
    });

    it("queues the previous object for cleanup and the worker removes it", async () => {
      await upload(aliceId, aliceId).expect(200);
      const { photo_key: oldKey } = await row(aliceId);

      await upload(aliceId, aliceId).expect(200);

      const { photo_key: newKey } = await row(aliceId);
      expect(newKey).not.toBe(oldKey);
      expect(await jobs()).toEqual([
        { object_key: oldKey, reason: "photo_replaced", status: "queued", attempts: 0 },
      ]);
      expect((await stored()).sort()).toEqual([newKey, oldKey].sort());

      await expect(worker().processNext()).resolves.toBe(true);

      expect(await stored()).toEqual([newKey]);
      expect(await jobs()).toMatchObject([{ status: "done", attempts: 1 }]);
      await expect(worker().processNext()).resolves.toBe(false);
    });

    it("logs the upload without the original name or the object key", async () => {
      await upload(aliceId, aliceId).expect(200);
      await upload(aliceId, aliceId).expect(200);
      const { photo_key: key } = await row(aliceId);

      const text = logs().join("\n");
      expect(text).toContain(
        `User update result=success operation=users.photo.update scope=self actorUserId=${aliceId} targetUserId=${aliceId} fields=photo`,
      );
      expect(text).toMatch(/Storage cleanup queued jobId=[0-9a-f-]{36} reason=photo_replaced/);
      expect(text).not.toContain(key);
      expect(text).not.toContain("holiday-at-the-sea");
    });

    it("answers the same 403 for a foreign and a missing user without users@update_any", async () => {
      const foreign = await upload(aliceId, bobId).expect(403);
      const missing = await upload(aliceId, MISSING_ID).expect(403);

      expect(foreign.body).toEqual(missing.body);
      expect(foreign.body.code).toBe("permission_denied");
      expect(await stored()).toEqual([]);
    });

    it("lets an admin replace someone else's photo", async () => {
      const response = await upload(adminId, bobId).expect(200);

      expect(response.body).toMatchObject({ id: bobId, photoUrl: expect.stringContaining(bobId) });
    });

    it("answers 404 only after users@update_any and keeps no object", async () => {
      const response = await upload(adminId, MISSING_ID).expect(404);

      expect(response.body.code).toBe("user_not_found");
      expect(await stored()).toEqual([]);
    });

    it.each(["pending", "deleting", "deleted"])(
      "answers 409 for a %s target and keeps no object",
      async (status) => {
        await setStatus(bobId, status);

        const response = await upload(adminId, bobId).expect(409);

        expect(response.body.code).toBe("user_state_conflict");
        expect(await stored()).toEqual([]);
      },
    );

    it("accepts a photo for a blocked user from an admin", async () => {
      await setStatus(bobId, "blocked");

      await upload(adminId, bobId).expect(200);
    });

    it("answers 400 photo_required without a file", async () => {
      const response = await http()
        .put(`/users/${aliceId}/photo`)
        .set("Cookie", cookie(aliceId))
        .expect(400);

      expect(response.body.code).toBe("photo_required");
    });

    it.each([
      [
        "a file in another field",
        (r: request.Test) => r.attach("avatar", png, { filename: "a.png", contentType: "image/png" }),
      ],
      [
        "two files",
        (r: request.Test) =>
          r
            .attach("file", png, { filename: "a.png", contentType: "image/png" })
            .attach("file", png, { filename: "b.png", contentType: "image/png" }),
      ],
      [
        "an extra text field",
        (r: request.Test) =>
          r.field("note", "x").attach("file", png, { filename: "a.png", contentType: "image/png" }),
      ],
    ])("answers 400 to %s", async (_case, build) => {
      await build(http().put(`/users/${aliceId}/photo`).set("Cookie", cookie(aliceId))).expect(400);

      expect((await row(aliceId)).photo_key).toBeNull();
      expect(await stored()).toEqual([]);
    });

    it("answers 413 to a file over 5 MiB", async () => {
      const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);

      const response = await upload(aliceId, aliceId, big).expect(413);

      expect(response.body.code).toBe("payload_too_large");
      expect(await stored()).toEqual([]);
    });

    it.each([
      ["a GIF", async () => image(100, 100).gif().toBuffer(), "image/gif"],
      ["a JPEG declared as PNG", async () => image(100, 100).jpeg().toBuffer(), "image/png"],
      ["a text file", async () => Buffer.from("not an image"), "image/png"],
    ])("answers 415 to %s", async (_case, build, contentType) => {
      const response = await upload(aliceId, aliceId, await build(), contentType).expect(415);

      expect(response.body.code).toBe("unsupported_media_type");
      expect(await stored()).toEqual([]);
    });

    it.each([
      ["a too small image", async () => image(63, 63).png().toBuffer()],
      ["a truncated image", async () => (await image(300, 300).png().toBuffer()).subarray(0, 100)],
    ])("answers 400 invalid_photo to %s", async (_case, build) => {
      const response = await upload(aliceId, aliceId, await build()).expect(400);

      expect(response.body.code).toBe("invalid_photo");
      expect(await stored()).toEqual([]);
    });

    it("answers 401 without a session", async () => {
      await http()
        .put(`/users/${aliceId}/photo`)
        .attach("file", png, { filename: "a.png", contentType: "image/png" })
        .expect(401);
    });
  });

  describe("removal", () => {
    it("clears the link at once and the worker removes the object", async () => {
      await upload(aliceId, aliceId).expect(200);
      const { photo_key: key } = await row(aliceId);

      const response = await remove(aliceId, aliceId).expect(204);

      expect(response.text).toBe("");
      expect((await row(aliceId)).photo_key).toBeNull();
      expect(await jobs()).toEqual([
        { object_key: key, reason: "photo_cleared", status: "queued", attempts: 0 },
      ]);
      await getPhoto(aliceId, aliceId).expect(404);
      const profile = await http().get(`/users/${aliceId}`).set("Cookie", cookie(aliceId)).expect(200);
      expect(profile.body.photoUrl).toBeNull();

      await worker().processNext();

      expect(await stored()).toEqual([]);
      expect(logs().join("\n")).toContain(
        `User update result=success operation=users.photo.clear scope=self actorUserId=${aliceId}`,
      );
    });

    it("answers 204 without changes when there is no photo", async () => {
      const before = await row(aliceId);

      await remove(aliceId, aliceId).expect(204);

      expect((await row(aliceId)).updated_at.getTime()).toBe(before.updated_at.getTime());
      expect(await jobs()).toEqual([]);
    });

    it("answers 403 for a foreign user without users@update_any", async () => {
      await upload(adminId, bobId).expect(200);

      const response = await remove(aliceId, bobId).expect(403);

      expect(response.body.code).toBe("permission_denied");
      expect((await row(bobId)).photo_key).not.toBeNull();
    });

    it("lets an admin clear someone else's photo", async () => {
      await upload(adminId, bobId).expect(200);

      await remove(adminId, bobId).expect(204);

      expect((await row(bobId)).photo_key).toBeNull();
    });

    it("answers 409 for a deleting target", async () => {
      await setStatus(bobId, "deleting");

      const response = await remove(adminId, bobId).expect(409);

      expect(response.body.code).toBe("user_state_conflict");
    });
  });

  it(`shares the limit of ${PROFILE_UPDATE_LIMIT} changes an hour between PATCH and photo operations`, async () => {
    for (let i = 0; i < PROFILE_UPDATE_LIMIT - 2; i++) {
      await http()
        .patch(`/users/${aliceId}`)
        .set("Cookie", cookie(aliceId))
        .send({ displayName: `Alice ${i}` })
        .expect(200);
    }
    await upload(aliceId, aliceId).expect(200);
    await remove(aliceId, aliceId).expect(204);

    const response = await upload(aliceId, aliceId).expect(429);

    expect(response.body.code).toBe("rate_limited");
    await remove(aliceId, aliceId).expect(429);
  });

  describe("cleanup worker", () => {
    it("leaves a job whose retry time has not come yet", async () => {
      await db.query(
        `INSERT INTO storage_cleanup_jobs (object_key, reason, next_attempt_at)
         VALUES ('later-key', 'photo_cleared', now() + interval '1 minute')`,
      );

      await expect(worker().processNext()).resolves.toBe(false);
      expect(await jobs()).toMatchObject([{ status: "queued", attempts: 0 }]);
    });

    it("treats an already missing object as done", async () => {
      await db.query(
        `INSERT INTO storage_cleanup_jobs (object_key, reason) VALUES ('gone-key', 'photo_cleared')`,
      );

      await worker().processNext();

      expect(await jobs()).toMatchObject([{ status: "done", attempts: 1 }]);
    });

    it("removes only old objects without a profile link or a queued job", async () => {
      await upload(aliceId, aliceId).expect(200);
      const { photo_key: profileKey } = await row(aliceId);
      for (const key of ["orphan-old", "queued-old", "orphan-fresh"]) {
        await writeFile(join(PHOTO_DIR, key), "x");
      }
      await db.query(
        `INSERT INTO storage_cleanup_jobs (object_key, reason, next_attempt_at)
         VALUES ('queued-old', 'photo_cleared', now() + interval '1 minute')`,
      );
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
      for (const key of [profileKey, "orphan-old", "queued-old"]) {
        await utimes(join(PHOTO_DIR, key), twoHoursAgo, twoHoursAgo);
      }

      await worker().reconcile();

      expect((await stored()).sort()).toEqual([profileKey, "orphan-fresh", "queued-old"].sort());
      expect(logs().join("\n")).toContain("Storage reconcile completed checked=3 deleted=1 failed=0");
    });
  });
});
