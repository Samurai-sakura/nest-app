import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import { createTestApp } from "./helpers/create-test-app";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";
const appOrigin = "http://localhost:3200";
const frontend = "https://app.example.com";
const evil = "https://evil.example";

describe("CORS and CSRF (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;

  beforeAll(() => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
  });

  afterAll(() => {
    process.env.FRONTEND_ORIGIN = appOrigin;
    delete process.env.AUTH_COOKIE_SAME_SITE;
    jest.restoreAllMocks();
  });

  // CORS настраивается при старте, поэтому FRONTEND_ORIGIN задаётся до создания приложения
  async function start(env: Record<string, string> = {}) {
    process.env.FRONTEND_ORIGIN = frontend;
    delete process.env.AUTH_COOKIE_SAME_SITE;
    Object.assign(process.env, env);
    ({ app, db } = await createTestApp({
      mail: { sendOtp: jest.fn(), sendMagicLink: jest.fn() },
    }));
    await db.query(`TRUNCATE users CASCADE`);
    await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, 'active', $2)`,
      [email, await argon2.hash(password)],
    );
    logged.forEach((spy) => spy.mockClear());
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
    process.env.REGISTRATION_CONFIRM_ENABLED = "false";
  }

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer());
  const login = (headers: Record<string, string>) =>
    http().post("/auth/login").set(headers).send({ email, password });

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  function expectRejected(response: request.Response) {
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "csrf_rejected",
      message: "Cross-origin request rejected",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
  }

  describe("state-changing requests", () => {
    beforeEach(() => start());

    it("accepts a same-origin login without the header", async () => {
      await login({ Origin: appOrigin }).expect(204);
    });

    it("accepts a request without Origin", async () => {
      await login({}).expect(204);
    });

    it("accepts the trusted frontend with X-CSRF-Protection: 1", async () => {
      const response = await login({ Origin: frontend, "X-CSRF-Protection": "1" }).expect(204);

      expect(response.headers["access-control-allow-origin"]).toBe(frontend);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("rejects the trusted frontend without the header and logs it", async () => {
      expectRejected(await login({ Origin: frontend }));
      expect(logs().join("\n")).toContain(
        "reason=csrf_rejected route=POST /auth/login trustedOrigin=true",
      );
    });

    it("rejects another origin even with the header", async () => {
      expectRejected(await login({ Origin: evil, "X-CSRF-Protection": "1" }));
    });

    it.each([
      ["/auth/register", { email: "new@gmail.com", password }],
      ["/auth/register/confirm", { token: "some-token" }],
      ["/auth/register/resend", { email }],
      ["/auth/login/confirm", { attemptId: "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c", code: "123456" }],
      ["/auth/login/resend", { attemptId: "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c" }],
      ["/auth/refresh", {}],
      ["/auth/logout", {}],
    ])("checks POST %s as well", async (path, body) => {
      const response = await http().post(path).set("Origin", evil).send(body);

      expectRejected(response);
    });

    it("does not register a user from another origin", async () => {
      await http()
        .post("/auth/register")
        .set("Origin", frontend)
        .send({ email: "new@gmail.com", password })
        .expect(403);

      const [{ count }] = await db.query(`SELECT count(*) FROM users WHERE email = 'new@gmail.com'`);
      expect(count).toBe("0");
    });

    it("lets GET pages load from any origin", async () => {
      await http().get("/auth/login/confirm").set("Origin", evil).expect(200);
    });
  });

  describe("CORS preflight", () => {
    beforeEach(() => start());

    const preflight = (origin: string) =>
      http()
        .options("/auth/login")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type,x-csrf-protection");

    it("allows the trusted frontend with credentials and the CSRF header", async () => {
      const response = await preflight(frontend).expect(204);

      expect(response.headers["access-control-allow-origin"]).toBe(frontend);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-headers"].toLowerCase()).toContain(
        "x-csrf-protection",
      );
      expect(response.headers["access-control-allow-methods"]).toContain("POST");
    });

    it("does not allow another origin and never answers with *", async () => {
      const response = await preflight(evil);

      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    });
  });

  describe("cookies for a cross-site frontend", () => {
    function sameSiteOf(response: request.Response) {
      const header = response.headers["set-cookie"] as unknown as string[];
      return header.map((cookie) => /SameSite=(\w+)/.exec(cookie)![1]);
    }

    it("uses SameSite=Strict by default", async () => {
      await start();

      expect(sameSiteOf(await login({}).expect(204))).toEqual(["Strict", "Strict"]);
    });

    it("uses SameSite=None; Secure when configured and clears cookies the same way", async () => {
      await start({ AUTH_COOKIE_SAME_SITE: "none" });

      const signedIn = await login({ Origin: frontend, "X-CSRF-Protection": "1" }).expect(204);
      expect(sameSiteOf(signedIn)).toEqual(["None", "None"]);
      for (const cookie of signedIn.headers["set-cookie"] as unknown as string[]) {
        expect(cookie).toContain("Secure");
      }

      const loggedOut = await http()
        .post("/auth/logout")
        .set("Origin", frontend)
        .set("X-CSRF-Protection", "1")
        .expect(204);
      expect(sameSiteOf(loggedOut)).toEqual(["None", "None"]);
    });
  });
});
