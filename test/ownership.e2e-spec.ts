import {
  Controller,
  Get,
  INestApplication,
  Logger,
  NotFoundException,
  Param,
  Patch,
} from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import { AccessControlService } from "../src/access-control/authorization/services/access-control.service";
import { AuthorizationModule } from "../src/access-control/authorization/authorization.module";
import { CurrentUserId } from "../src/access-control/authorization/decorators/current-user-id.decorator";
import { RequirePermission } from "../src/access-control/authorization/decorators/require-permission.decorator";
import { createTestApp } from "./helpers/create-test-app";
import { grantPermission, resetRbac } from "./helpers/rbac";

const password = "Passw0rd-secret";
const handler = jest.fn();
const notes = new Map<string, { id: string; ownerId: string }>();

@Controller("test-profiles")
class ProfilesController {
  constructor(
    private readonly access: AccessControlService,
    private readonly db: DataSource,
  ) {}

  @Get(":id")
  @RequirePermission("users", "read")
  public async read(@Param("id") id: string, @CurrentUserId() userId: string) {
    if (id !== userId) {
      await this.access.requirePermission(userId, "users", "read_any");
    }
    handler(id);
    const [user] = await this.db.query(`SELECT id, email FROM users WHERE id::text = $1`, [id]);
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }
}

@Controller("test-notes")
class NotesController {
  constructor(private readonly access: AccessControlService) {}

  @Patch(":id")
  @RequirePermission("notes", "update")
  public async update(@Param("id") id: string, @CurrentUserId() userId: string) {
    const note = notes.get(id);
    if (!note) {
      throw new NotFoundException();
    }
    await this.access.requireOwner(userId, note, { permission: "notes", action: "update_any" });
    handler(id);
    return { updated: id };
  }
}

describe("Ownership and *_any actions (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let aliceId: string;
  let bobId: string;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp({
      imports: [AuthorizationModule],
      controllers: [ProfilesController, NotesController],
    }));
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    await resetRbac(db);
    handler.mockClear();
    logged.forEach((spy) => spy.mockClear());
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
    const hash = await argon2.hash(password);
    [{ id: aliceId }, { id: bobId }] = await db.query(
      `INSERT INTO users (email, status, password_hash)
       VALUES ('alice@gmail.com', 'active', $1), ('bob@gmail.com', 'active', $1)
       RETURNING id`,
      [hash],
    );
    notes.clear();
    notes.set("alice-note", { id: "alice-note", ownerId: aliceId });
    notes.set("bob-note", { id: "bob-note", ownerId: bobId });
  });

  const http = () => request(app.getHttpServer());

  async function signIn(email: string) {
    const response = await http().post("/auth/login").send({ email, password }).expect(204);
    const header = response.headers["set-cookie"] as unknown as string[];
    return header.find((cookie) => cookie.startsWith("access_token="))!.split(";")[0];
  }

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  describe("profile with users@read_any", () => {
    it("lets a user read the own profile with the base permission", async () => {
      await grantPermission(db, aliceId, "users", ["read"]);
      const cookie = await signIn("alice@gmail.com");

      const response = await http().get(`/test-profiles/${aliceId}`).set("Cookie", cookie);

      expect(response.status).toBe(200);
      expect(response.body.email).toBe("alice@gmail.com");
    });

    it("requires the base permission even for the own profile", async () => {
      const cookie = await signIn("alice@gmail.com");

      const response = await http().get(`/test-profiles/${aliceId}`).set("Cookie", cookie);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("permission_denied");
    });

    it.each(["bob", "missing"])(
      "returns the same 403 for a %s profile without read_any and does not look it up",
      async (target) => {
        await grantPermission(db, aliceId, "users", ["read"]);
        const cookie = await signIn("alice@gmail.com");
        const id = target === "bob" ? bobId : "00000000-0000-4000-8000-000000000000";

        const response = await http().get(`/test-profiles/${id}`).set("Cookie", cookie);

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
          statusCode: 403,
          code: "permission_denied",
          message: "Permission denied",
        });
        expect(handler).not.toHaveBeenCalled();
        expect(logs().join("\n")).toContain(
          `reason=permission_denied actorUserId=${aliceId} required=users@read_any`,
        );
      },
    );

    it("reads another profile with read_any and returns 404 for a missing one", async () => {
      await grantPermission(db, aliceId, "users", ["read", "read_any"]);
      const cookie = await signIn("alice@gmail.com");

      await http().get(`/test-profiles/${bobId}`).set("Cookie", cookie).expect(200);
      await http()
        .get("/test-profiles/00000000-0000-4000-8000-000000000000")
        .set("Cookie", cookie)
        .expect(404);
    });
  });

  describe("note owned by a user", () => {
    it("lets the owner update the note", async () => {
      await grantPermission(db, aliceId, "notes", ["update"]);
      const cookie = await signIn("alice@gmail.com");

      await http()
        .patch("/test-notes/alice-note")
        .set("Cookie", cookie)
        .expect(200, { updated: "alice-note" });
    });

    it("returns ownership_denied for someone else's note", async () => {
      await grantPermission(db, aliceId, "notes", ["update"]);
      const cookie = await signIn("alice@gmail.com");

      const response = await http().patch("/test-notes/bob-note").set("Cookie", cookie);

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        statusCode: 403,
        code: "ownership_denied",
        message: "Access to this resource is denied",
      });
      expect(handler).not.toHaveBeenCalled();
      expect(logs().join("\n")).toContain(
        `reason=ownership_denied actorUserId=${aliceId} resourceId=bob-note`,
      );
    });

    it("returns 404 for a missing note once the base permission is granted", async () => {
      await grantPermission(db, aliceId, "notes", ["update"]);
      const cookie = await signIn("alice@gmail.com");

      await http().patch("/test-notes/missing").set("Cookie", cookie).expect(404);
    });

    it("returns permission_denied before the lookup without the base permission", async () => {
      const cookie = await signIn("alice@gmail.com");

      const response = await http().patch("/test-notes/missing").set("Cookie", cookie);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("permission_denied");
    });

    it("lets update_any change someone else's note", async () => {
      await grantPermission(db, aliceId, "notes", ["update", "update_any"]);
      const cookie = await signIn("alice@gmail.com");

      await http().patch("/test-notes/bob-note").set("Cookie", cookie).expect(200);
    });
  });
});
