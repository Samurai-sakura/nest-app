import {
  Controller,
  Delete,
  Get,
  Headers,
  INestApplication,
  Logger,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import request from "supertest";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import * as argon2 from "argon2";
import { User } from "../src/auth/entities/user.entity";
import { authorizationUnavailable } from "../src/auth/helpers/auth-errors";
import { CurrentUserId } from "../src/authorization/decorators/current-user-id.decorator";
import { Public } from "../src/authorization/decorators/public.decorator";
import { Receipt } from "../src/authorization/decorators/receipt.decorator";
import { RequirePermission } from "../src/authorization/decorators/require-permission.decorator";
import { RouteConfigurationService } from "../src/authorization/route-configuration.service";
import { RbacPolicyService } from "../src/rbac/services/rbac-policy.service";
import { createTestApp } from "./helpers/create-test-app";
import { grantPermission, resetRbac } from "./helpers/rbac";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";
const evil = "https://evil.example";
const handler = jest.fn();

// защищённых бизнес-операций в задании нет: маршруты существуют только в тесте
@Controller("test-reports")
class ReportsController {
  @Get(":id")
  @RequirePermission("reports", "read")
  public read(@Param("id") id: string, @CurrentUserId() userId: string) {
    handler(userId);
    // ресурс ищется только после допуска
    if (id !== "42") {
      throw new NotFoundException();
    }
    return { id };
  }

  @Post()
  @RequirePermission("reports", "create")
  public create(@CurrentUserId() userId: string) {
    handler(userId);
    return { created: true };
  }

  @Delete(":id")
  @RequirePermission("reports", "delete", { audit: true })
  public remove(@Param("id") id: string) {
    handler(id);
    return { deleted: id };
  }
}

@Public()
@Controller("test-ping")
class PingController {
  @Get()
  public ping() {
    handler();
    return { ok: true };
  }
}

@Controller("test-deletion")
class DeletionController {
  @Get("status")
  @Receipt("Deletion-Receipt")
  @RequirePermission("users", "delete")
  public status(@Headers("deletion-receipt") receipt?: string) {
    handler();
    return { byReceipt: receipt !== undefined };
  }
}

@Controller("test-forgotten")
class ForgottenController {
  @Get()
  public forgotten() {
    handler();
    return {};
  }
}

describe("Authorization chain (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  // шпионы на сервисы снимаются после каждого теста, иначе следующий видит чужие вызовы
  const serviceSpies: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let userId: string;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp({
      controllers: [ReportsController, PingController, DeletionController, ForgottenController],
    }));
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
    handler.mockClear();
    logged.forEach((spy) => spy.mockClear());
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
    [{ id: userId }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, 'active', $2) RETURNING id`,
      [email, await argon2.hash(password)],
    );
  });

  const http = () => request(app.getHttpServer());

  async function signIn() {
    const response = await http().post("/auth/login").send({ email, password }).expect(204);
    const header = response.headers["set-cookie"] as unknown as string[];
    const access = header.find((cookie) => cookie.startsWith("access_token="))!;
    return access.split(";")[0];
  }

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  const permissionDenied = {
    statusCode: 403,
    code: "permission_denied",
    message: "Permission denied",
  };

  describe("RBAC", () => {
    it("lets a user with the permission reach the handler", async () => {
      await grantPermission(db, userId, "reports", ["read"]);
      const cookie = await signIn();

      await http().get("/test-reports/42").set("Cookie", cookie).expect(200, { id: "42" });
      expect(handler).toHaveBeenCalledWith(userId);
    });

    it.each(["42", "does-not-exist"])(
      "returns the same 403 for report %s without the permission",
      async (id) => {
        const cookie = await signIn();

        const response = await http().get(`/test-reports/${id}`).set("Cookie", cookie);

        expect(response.status).toBe(403);
        expect(response.body).toEqual(permissionDenied);
        expect(handler).not.toHaveBeenCalled();
        expect(logs().join("\n")).toContain(
          `reason=permission_denied actorUserId=${userId} operation=ReportsController.read route=GET /test-reports/${id} required=reports@read`,
        );
      },
    );

    it("returns 404 only after the permission check", async () => {
      await grantPermission(db, userId, "reports", ["read"]);
      const cookie = await signIn();

      await http().get("/test-reports/does-not-exist").set("Cookie", cookie).expect(404);
    });

    it("does not treat another action of the same permission as enough", async () => {
      await grantPermission(db, userId, "reports", ["read"]);
      const cookie = await signIn();

      await http().post("/test-reports").set("Cookie", cookie).expect(403);
    });

    it("applies a granted and a revoked role without a new token", async () => {
      const cookie = await signIn();
      await http().get("/test-reports/42").set("Cookie", cookie).expect(403);

      const { roleId } = await grantPermission(db, userId, "reports", ["read"]);
      await http().get("/test-reports/42").set("Cookie", cookie).expect(200);

      await db.query(`DELETE FROM user_roles WHERE role_id = $1`, [roleId]);
      await http().get("/test-reports/42").set("Cookie", cookie).expect(403);
    });

    it("returns 503 when the policy is unavailable", async () => {
      await grantPermission(db, userId, "reports", ["read"]);
      const cookie = await signIn();
      serviceSpies.push(
        jest
          .spyOn(app.get(RbacPolicyService), "authorize")
          .mockRejectedValueOnce(authorizationUnavailable()),
      );

      const response = await http().get("/test-reports/42").set("Cookie", cookie);

      expect(response.status).toBe(503);
      expect(response.body.code).toBe("authorization_unavailable");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("returns 503, not 401, when users cannot be read", async () => {
    await grantPermission(db, userId, "reports", ["read"]);
    const cookie = await signIn();
    const rbac = jest.spyOn(app.get(RbacPolicyService), "authorize");
    serviceSpies.push(
      rbac,
      jest
        .spyOn(app.get<Repository<User>>(getRepositoryToken(User)), "findOne")
        .mockRejectedValueOnce(new Error("connection refused")),
    );

    const response = await http().get("/test-reports/42").set("Cookie", cookie);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      statusCode: 503,
      code: "authorization_unavailable",
      message: "Authorization is temporarily unavailable",
    });
    expect(rbac).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(logs().join("\n")).toContain("Authorization unavailable reason=users");
  });

  describe("audit", () => {
    it("logs a granted critical operation without the token", async () => {
      await grantPermission(db, userId, "reports", ["delete"]);
      const cookie = await signIn();

      const response = await http()
        .delete("/test-reports/42")
        .set("Cookie", cookie)
        .expect(200);

      expect(response.body).toEqual({ deleted: "42" });
      const text = logs().join("\n");
      expect(text).toMatch(
        new RegExp(
          `Access granted actorUserId=${userId} operation=ReportsController.remove route=DELETE /test-reports/42 required=reports@delete policyVersion=\\d+`,
        ),
      );
      expect(text).not.toContain(cookie.split("=")[1]);
    });

    it("does not log a granted ordinary operation", async () => {
      await grantPermission(db, userId, "reports", ["read"]);
      const cookie = await signIn();

      await http().get("/test-reports/42").set("Cookie", cookie).expect(200);

      expect(logs().join("\n")).not.toContain("Access granted");
    });
  });

  describe("order of checks", () => {
    it("answers 401, not 403, to a cross-origin change without a session", async () => {
      const response = await http().post("/test-reports").set("Origin", evil);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe("invalid_session");
    });

    it("rejects a cross-origin change of an authenticated user with csrf_rejected", async () => {
      await grantPermission(db, userId, "reports", ["create"]);
      const cookie = await signIn();

      const response = await http()
        .post("/test-reports")
        .set("Cookie", cookie)
        .set("Origin", evil)
        .set("X-CSRF-Protection", "1");

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("csrf_rejected");
      expect(handler).not.toHaveBeenCalled();
    });

    it("checks CSRF before RBAC", async () => {
      const cookie = await signIn();

      const response = await http().post("/test-reports").set("Cookie", cookie).set("Origin", evil);

      expect(response.body.code).toBe("csrf_rejected");
    });
  });

  describe("declarations", () => {
    it("lets a public route through with a broken access cookie", async () => {
      await http()
        .get("/test-ping")
        .set("Cookie", "access_token=garbage")
        .expect(200, { ok: true });
    });

    it("keeps public auth routes open", async () => {
      await signIn();
    });

    it("finds a route without a declaration at startup", () => {
      const routes = app.get(RouteConfigurationService);

      expect(routes.ready).toBe(false);
      expect(routes.invalidRoutes).toEqual([
        { route: "GET /test-forgotten", reason: "route has no authorization declaration" },
      ]);
    });

    it("takes readiness away while a route has no declaration", async () => {
      const response = await http().get("/health/ready").expect(503);

      expect(response.body.code).toBe("not_ready");
      expect(logs().join("\n")).toContain("Readiness failed checks=route_configuration");
    });

    it("closes a route without a declaration with 503", async () => {
      const cookie = await signIn();

      const response = await http().get("/test-forgotten").set("Cookie", cookie);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        statusCode: 503,
        code: "authorization_unavailable",
        message: "Authorization is temporarily unavailable",
      });
      expect(handler).not.toHaveBeenCalled();
      expect(logs().join("\n")).toContain(
        "reason=route_configuration route=GET /test-forgotten: route has no authorization declaration",
      );
    });

    it("hands a receipt request to the handler without a session", async () => {
      await http()
        .get("/test-deletion/status")
        .set("Deletion-Receipt", "receipt-value")
        .expect(200, { byReceipt: true });
    });

    it("uses the declared pair when the receipt header is missing", async () => {
      await http().get("/test-deletion/status").expect(401);

      await grantPermission(db, userId, "users", ["delete"]);
      const cookie = await signIn();
      await http()
        .get("/test-deletion/status")
        .set("Cookie", cookie)
        .expect(200, { byReceipt: false });
    });
  });
});
