import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import * as jwt from "jsonwebtoken";
import type { UserStatus } from "../src/auth/entities/user.entity";
import { createTestApp } from "./helpers/create-test-app";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";

describe("Login (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let passwordHash: string;

  // своё приложение на каждый блок: лимиты частоты хранятся в памяти
  async function createApp() {
    const { app: created } = await createTestApp({
      mail: {
        sendOtp: jest.fn(),
        sendMagicLink: jest.fn(),
        sendLoginOtp: jest.fn(),
        sendLoginMagicLink: jest.fn(),
      },
    });
    return created;
  }

  const login = (body: object = { email, password }) =>
    request(app.getHttpServer()).post("/auth/login").send(body);

  async function createUser(status: UserStatus = "active", address = email) {
    const [{ id }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [address, status, passwordHash],
    );
    return id as string;
  }

  function cookiesOf(response: request.Response) {
    const header = (response.headers["set-cookie"] ?? []) as unknown as string[];
    return Object.fromEntries(
      header.map((cookie) => [cookie.split("=")[0], cookie]),
    ) as Record<string, string>;
  }

  const tokenFrom = (cookie: string) => cookie.split(";")[0].split("=")[1];
  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  beforeAll(async () => {
    passwordHash = await argon2.hash(password);
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    app = await createApp();
    db = app.get(DataSource);
    await db.query(`TRUNCATE users CASCADE`);
    logged.forEach((spy) => spy.mockClear());
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
  });

  afterEach(() => app.close());

  describe("success", () => {
    it("returns 204 without a body and sets both cookies", async () => {
      await createUser();

      const response = await login().expect(204);

      expect(response.text).toBe("");
      const cookies = cookiesOf(response);
      expect(cookies.access_token).toMatch(
        /Max-Age=900; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Strict$/,
      );
      expect(cookies.refresh_token).toMatch(
        /Max-Age=2592000; Path=\/auth\/refresh; Expires=.*; HttpOnly; Secure; SameSite=Strict$/,
      );
    });

    it("issues tokens for this user signed with the configured keys", async () => {
      const userId = await createUser();

      const cookies = cookiesOf(await login().expect(204));

      const access = jwt.verify(
        tokenFrom(cookies.access_token),
        process.env.JWT_ACCESS_SECRET!,
        { algorithms: ["HS256"] },
      ) as jwt.JwtPayload;
      const refresh = jwt.verify(
        tokenFrom(cookies.refresh_token),
        process.env.JWT_REFRESH_SECRET!,
        { algorithms: ["HS256"] },
      ) as jwt.JwtPayload;
      expect(access).toMatchObject({ sub: userId, token_use: "access" });
      expect(refresh).toMatchObject({ sub: userId, token_use: "refresh" });
    });

    it("normalizes the email but not the password", async () => {
      await createUser();

      await login({ email: "  ABC@Gmail.COM ", password }).expect(204);
      await login({ email, password: ` ${password}` }).expect(401);
    });
  });

  describe("rejection", () => {
    async function rejected(body: object) {
      const response = await login(body).expect(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      return response.body;
    }

    it("returns the same 401 for an unknown email, a wrong password and inactive users", async () => {
      await createUser("active", email);
      const statuses = ["pending", "blocked", "deleting", "deleted"] as const;
      for (const status of statuses) {
        await createUser(status, `${status}@gmail.com`);
      }

      const bodies = [
        await rejected({ email: "nobody@gmail.com", password }),
        await rejected({ email, password: "Wr0ng-password" }),
        ...(await Promise.all(
          statuses.map((status) =>
            rejected({ email: `${status}@gmail.com`, password }),
          ),
        )),
      ];

      for (const body of bodies) {
        expect(body).toEqual({
          statusCode: 401,
          code: "invalid_credentials",
          message: "Invalid email or password",
        });
      }
    });

    it.each([
      ["an invalid email", { email: "not-an-email", password }],
      ["a missing password", { email }],
      ["an empty password", { email, password: "" }],
      ["a too long password", { email, password: "a".repeat(129) }],
      ["a non-string password", { email, password: 12345678 }],
    ])("returns 400 for %s", async (_case, body) => {
      await login(body).expect(400);
    });
  });

  describe("failed login limit", () => {
    it("blocks the email and IP pair after five failures, even with the right password", async () => {
      await createUser();
      for (let i = 0; i < 5; i++) {
        await login({ email, password: "Wr0ng-password" }).expect(401);
      }

      const response = await login().expect(429);

      expect(response.body).toMatchObject({ code: "too_many_attempts" });
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("limits unknown emails the same way", async () => {
      for (let i = 0; i < 5; i++) {
        await login({ email: "nobody@gmail.com", password }).expect(401);
      }

      await login({ email: "nobody@gmail.com", password }).expect(429);
    });

    it("does not block another email from the same IP", async () => {
      await createUser();
      for (let i = 0; i < 5; i++) {
        await login({ email: "nobody@gmail.com", password }).expect(401);
      }

      await login().expect(204);
    });
  });

  describe("request rate limit", () => {
    it("allows 30 requests per minute from one IP", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        const { status } = await login({ email: `user${i}@gmail.com`, password });
        statuses.push(status);
      }

      expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect(logs().join("\n")).toContain("reason=rate_limit route=POST /auth/login");
    });

    it("does not share the counter with registration", async () => {
      await createUser();
      for (let i = 0; i < 6; i++) {
        await request(app.getHttpServer())
          .post("/auth/register")
          .send({ email: `reg${i}@gmail.com`, password });
      }

      await login().expect(204);
    });
  });

  describe("audit log", () => {
    it("records success and each failure reason without the email or password", async () => {
      const userId = await createUser();
      await createUser("blocked", "blocked@gmail.com");

      await login().expect(204);
      await login({ email, password: "Wr0ng-password" }).expect(401);
      await login({ email: "blocked@gmail.com", password }).expect(401);
      await login({ email: "nobody@gmail.com", password }).expect(401);

      const text = logs().join("\n");
      expect(text).toContain(`Login succeeded userId=${userId}`);
      expect(text).toContain(`reason=wrong_password userId=${userId}`);
      expect(text).toContain("reason=user_inactive status=blocked");
      expect(text).toMatch(/reason=unknown_email emailRef=[0-9a-f]{16}/);
      expect(text).not.toContain(email);
      expect(text).not.toContain("nobody@gmail.com");
      expect(text).not.toContain(password);
    });
  });
});
