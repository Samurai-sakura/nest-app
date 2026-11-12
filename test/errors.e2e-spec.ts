import { ConsoleLogger, Controller, Get, INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import { createTestApp } from "./helpers/create-test-app";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";
const attemptId = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";

// маршрут существует только в тесте: проверяет ответ на непредвиденную ошибку
@Controller("test-crash")
class CrashController {
  @Get()
  public crash() {
    throw new Error("relation users_secret does not exist");
  }
}

describe("Error format and request id (e2e)", () => {
  const mail = {
    sendOtp: jest.fn(),
    sendMagicLink: jest.fn(),
    sendLoginOtp: jest.fn(),
    sendLoginMagicLink: jest.fn(),
  };
  const written: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;

  // Logger не подменяется: строки проходят через RequestAwareLogger и перехватываются на выходе
  beforeAll(() => {
    for (const level of ["log", "warn", "error"] as const) {
      written.push(jest.spyOn(ConsoleLogger.prototype, level).mockImplementation());
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    ({ app, db } = await createTestApp({ mail, controllers: [CrashController] }));
    await db.query(`TRUNCATE users CASCADE`);
    await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, 'active', $2)`,
      [email, await argon2.hash(password)],
    );
    Object.values(mail).forEach((fn) => fn.mockReset());
    written.forEach((spy) => spy.mockClear());
    process.env.REGISTRATION_CONFIRM_ENABLED = "false";
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
  });

  afterEach(async () => {
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const logs = () =>
    written.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  describe("every error has statusCode, code and message", () => {
    it.each([
      ["invalid input", () => http().post("/auth/login").send({ email: "x" }), 400, "validation_failed"],
      ["an unknown route", () => http().get("/nowhere"), 404, "not_found"],
      ["a taken email", () => http().post("/auth/register").send({ email, password }), 409, "email_taken"],
      ["wrong credentials", () => http().post("/auth/login").send({ email, password: "Wr0ng-pass" }), 401, "invalid_credentials"],
      ["no session", () => http().post("/auth/refresh"), 401, "invalid_session"],
      ["an unknown registration attempt", () => http().post("/auth/register/confirm").send({ attemptId, code: "123456" }), 400, "invalid_confirmation"],
      ["an unknown login attempt", () => http().post("/auth/login/confirm").send({ attemptId, code: "123456" }), 400, "invalid_confirmation"],
      ["nothing to resend", () => http().post("/auth/register/resend").send({ email }), 400, "no_pending_confirmation"],
      ["a foreign origin", () => http().post("/auth/logout").set("Origin", "https://evil.example"), 403, "csrf_rejected"],
    ])("%s", async (_case, send, status, code) => {
      const response = await send();

      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({ statusCode: status, code });
      expect(response.body.message).toBeDefined();
      expect(response.body).not.toHaveProperty("error");
    });

    it("a repeated login email within 60 seconds", async () => {
      process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "true";
      await http().post("/auth/login").send({ email, password }).expect(202);

      const response = await http().post("/auth/login").send({ email, password }).expect(429);

      expect(response.body).toMatchObject({ code: "resend_too_early", retryAfterSeconds: expect.any(Number) });
    });

    it("a failed login email", async () => {
      process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "true";
      mail.sendLoginOtp.mockRejectedValueOnce(new Error("smtp down"));

      const response = await http().post("/auth/login").send({ email, password }).expect(503);

      expect(response.body).toMatchObject({ code: "email_delivery_failed", attemptId: expect.any(String) });
    });

    it("a malformed JSON body", async () => {
      const response = await http()
        .post("/auth/login")
        .set("Content-Type", "application/json")
        .send('{"email": "abc@gmail.com", "password": "Passw0rd-secret"');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ statusCode: 400, code: "bad_request" });
      expect(logs().join("\n")).not.toContain("Passw0rd-secret");
    });

    it("an unexpected error without leaking details", async () => {
      const response = await http().get("/test-crash").expect(500);

      expect(response.body).toEqual({
        statusCode: 500,
        code: "internal_error",
        message: "Internal server error",
      });
      expect(JSON.stringify(response.body)).not.toContain("users_secret");
      expect(logs().join("\n")).toContain("users_secret");
    });
  });

  describe("X-Request-Id", () => {
    it("is returned for successful and failed requests", async () => {
      const ok = await http().post("/auth/logout").expect(204);
      const failed = await http().post("/auth/refresh").expect(401);

      expect(ok.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(failed.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(ok.headers["x-request-id"]).not.toBe(failed.headers["x-request-id"]);
    });

    it("keeps a well-formed id from the client and replaces a broken one", async () => {
      const kept = await http().post("/auth/logout").set("X-Request-Id", "trace-42");
      const replaced = await http()
        .post("/auth/logout")
        .set("X-Request-Id", "bad id with spaces");

      expect(kept.headers["x-request-id"]).toBe("trace-42");
      expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("is written into every log line of the request", async () => {
      const response = await http()
        .post("/auth/login")
        .set("X-Request-Id", "trace-login")
        .send({ email, password: "Wr0ng-pass" })
        .expect(401);

      const lines = logs().filter((line) => line.includes("Login failed"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(
        `Login failed reason=wrong_password userId=${(await db.query(`SELECT id FROM users`))[0].id} requestId=trace-login`,
      );
      expect(response.headers["x-request-id"]).toBe("trace-login");
    });

    it("tags filter logs too", async () => {
      await http()
        .post("/auth/login")
        .set("X-Request-Id", "trace-validation")
        .send({ email: "x", password })
        .expect(400);

      expect(logs().join("\n")).toContain(
        "Request rejected reason=validation route=POST /auth/login details=email must be an email requestId=trace-validation",
      );
    });
  });
});
