import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import * as jwt from "jsonwebtoken";
import type { UserStatus } from "../src/auth/entities/user.entity";
import { createTestApp } from "./helpers/create-test-app";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";

describe("Login confirmation (e2e)", () => {
  const mail = {
    sendOtp: jest.fn(),
    sendMagicLink: jest.fn(),
    sendLoginOtp: jest.fn(),
    sendLoginMagicLink: jest.fn(),
  };
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let userId: string;

  beforeAll(() => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
  });

  afterAll(() => jest.restoreAllMocks());

  // своё приложение на каждый тест: лимит 30 входов в минуту хранится в памяти
  beforeEach(async () => {
    ({ app, db } = await createTestApp({ mail }));

    await db.query(`TRUNCATE users CASCADE`);
    Object.values(mail).forEach((fn) => fn.mockReset());
    logged.forEach((spy) => spy.mockClear());
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "true";
    process.env.LOGIN_EMAIL_CONFIRMATION_METHOD = "otp";
    userId = await createUser();
  });

  afterEach(async () => {
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
    process.env.LOGIN_EMAIL_CONFIRMATION_METHOD = "otp";
    await app.close();
  });

  async function createUser(status: UserStatus = "active", address = email) {
    const [{ id }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [address, status, await argon2.hash(password)],
    );
    return id as string;
  }

  const http = () => request(app.getHttpServer());
  const login = () => http().post("/auth/login").send({ email, password });
  const confirm = (body: object) => http().post("/auth/login/confirm").send(body);
  const resend = (attemptId: string) =>
    http().post("/auth/login/resend").send({ attemptId });

  const lastCode = (): string => mail.sendLoginOtp.mock.lastCall[1];
  const lastLink = (): string => mail.sendLoginMagicLink.mock.lastCall[1];
  const lastToken = () => new URLSearchParams(new URL(lastLink()).hash.slice(1)).get("token")!;
  const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

  const findAttempt = async (id: string) =>
    (await db.query(`SELECT * FROM login_challenges WHERE id = $1`, [id]))[0];
  const ageAttempts = (seconds: number) =>
    db.query(
      `UPDATE login_challenges SET last_sent_at = last_sent_at - make_interval(secs => $1)`,
      [seconds],
    );

  function cookiesOf(response: request.Response) {
    const header = (response.headers["set-cookie"] ?? []) as unknown as string[];
    return Object.fromEntries(header.map((cookie) => [cookie.split("=")[0], cookie]));
  }

  function expectSession(response: request.Response) {
    const cookies = cookiesOf(response);
    const access = cookies.access_token.split(";")[0].split("=")[1];
    const payload = jwt.verify(access, process.env.JWT_ACCESS_SECRET!, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    expect(payload).toMatchObject({ sub: userId, token_use: "access" });
    expect(cookies.refresh_token).toContain("Path=/auth/refresh");
  }

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  describe("login with a code", () => {
    it("returns 202 with the attempt, sends the code and sets no cookies", async () => {
      const response = await login().expect(202);

      expect(response.body).toEqual({
        confirmationRequired: true,
        method: "otp",
        attemptId: expect.any(String),
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(mail.sendLoginOtp).toHaveBeenCalledWith(email, expect.stringMatching(/^\d{6}$/));
      expect(JSON.stringify(response.body)).not.toContain(lastCode());
      const attempt = await findAttempt(response.body.attemptId);
      expect(attempt).toMatchObject({ user_id: userId, method: "otp", attempts: 0 });
      expect(attempt.secret_hash).not.toContain(lastCode());
    });

    it("signs in with the right code exactly once", async () => {
      const { body } = await login().expect(202);
      const payload = { attemptId: body.attemptId, code: lastCode() };

      const response = await confirm(payload).expect(204);

      expectSession(response);
      expect(await findAttempt(body.attemptId)).toMatchObject({
        consumed_reason: "confirmed",
      });
      await confirm(payload).expect(400);
    });

    it("accepts the right code on the fifth try", async () => {
      const { body } = await login().expect(202);
      const code = lastCode();
      for (let i = 0; i < 4; i++) {
        await confirm({ attemptId: body.attemptId, code: wrong(code) }).expect(400);
      }

      await confirm({ attemptId: body.attemptId, code }).expect(204);
    });

    it("burns the attempt on the fifth wrong code and answers 429 afterwards", async () => {
      const { body } = await login().expect(202);
      const code = lastCode();
      for (let i = 0; i < 5; i++) {
        await confirm({ attemptId: body.attemptId, code: wrong(code) }).expect(400);
      }

      expect(await findAttempt(body.attemptId)).toMatchObject({
        attempts: 5,
        consumed_reason: "attempts_exhausted",
      });
      await confirm({ attemptId: body.attemptId, code }).expect(429);
      await resend(body.attemptId).expect(429);
    });

    it("rejects an expired code without counting it", async () => {
      const { body } = await login().expect(202);
      await ageAttempts(601);

      await confirm({ attemptId: body.attemptId, code: lastCode() }).expect(400);

      expect(await findAttempt(body.attemptId)).toMatchObject({ attempts: 0 });
    });

    it("signs in only once for parallel right codes", async () => {
      const { body } = await login().expect(202);
      const payload = { attemptId: body.attemptId, code: lastCode() };

      const statuses = (await Promise.all([confirm(payload), confirm(payload)]))
        .map((r) => r.status)
        .sort();

      expect(statuses).toEqual([204, 400]);
    });

    it("does not lose wrong codes sent in parallel", async () => {
      const { body } = await login().expect(202);
      const payload = { attemptId: body.attemptId, code: wrong(lastCode()) };

      const statuses = (
        await Promise.all(Array.from({ length: 7 }, () => confirm(payload)))
      )
        .map((r) => r.status)
        .sort();

      expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429]);
      expect(await findAttempt(body.attemptId)).toMatchObject({ attempts: 5 });
    });

    it("returns 400 for an unknown attempt", async () => {
      await confirm({
        attemptId: "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c",
        code: "123456",
      }).expect(400);
    });
  });

  describe("repeated login", () => {
    it("answers 429 with the remaining time within 60 seconds and sends nothing", async () => {
      await login().expect(202);
      mail.sendLoginOtp.mockClear();

      const response = await login().expect(429);

      expect(response.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(response.body.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(mail.sendLoginOtp).not.toHaveBeenCalled();
      const [{ count }] = await db.query(`SELECT count(*) FROM login_challenges`);
      expect(count).toBe("1");
    });

    it("replaces the previous attempt after the pause", async () => {
      const first = await login().expect(202);
      const oldCode = lastCode();
      await ageAttempts(61);

      const second = await login().expect(202);

      expect(second.body.attemptId).not.toBe(first.body.attemptId);
      expect(await findAttempt(first.body.attemptId)).toMatchObject({
        consumed_reason: "replaced",
      });
      await confirm({ attemptId: first.body.attemptId, code: oldCode }).expect(400);
      await confirm({ attemptId: second.body.attemptId, code: lastCode() }).expect(204);
    });

    it("still requires the right password", async () => {
      await http()
        .post("/auth/login")
        .send({ email, password: "Wr0ng-password" })
        .expect(401);

      expect(mail.sendLoginOtp).not.toHaveBeenCalled();
    });
  });

  describe("resend", () => {
    it("answers 429 within 60 seconds", async () => {
      const { body } = await login().expect(202);

      const response = await resend(body.attemptId).expect(429);

      expect(response.body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("replaces the code, resets the counter and restarts the TTL", async () => {
      const { body } = await login().expect(202);
      const oldCode = lastCode();
      await confirm({ attemptId: body.attemptId, code: wrong(oldCode) }).expect(400);
      await ageAttempts(700);
      mail.sendLoginOtp.mockClear();

      const response = await resend(body.attemptId).expect(202);

      expect(response.body).toEqual({
        method: "otp",
        attemptId: body.attemptId,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(mail.sendLoginOtp).toHaveBeenCalledTimes(1);
      expect(await findAttempt(body.attemptId)).toMatchObject({ attempts: 0 });
      if (lastCode() !== oldCode) {
        await confirm({ attemptId: body.attemptId, code: oldCode }).expect(400);
      }
      await confirm({ attemptId: body.attemptId, code: lastCode() }).expect(204);
    });

    it("keeps the method of the attempt after the setting changes", async () => {
      const { body } = await login().expect(202);
      process.env.LOGIN_EMAIL_CONFIRMATION_METHOD = "magic_link";
      await ageAttempts(61);

      await resend(body.attemptId).expect(202);

      expect(mail.sendLoginOtp).toHaveBeenCalledTimes(2);
      expect(mail.sendLoginMagicLink).not.toHaveBeenCalled();
    });

    it("can be confirmed after the flag is turned off", async () => {
      const { body } = await login().expect(202);
      process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";

      await confirm({ attemptId: body.attemptId, code: lastCode() }).expect(204);
    });

    it("returns 400 for a confirmed or unknown attempt", async () => {
      const { body } = await login().expect(202);
      await confirm({ attemptId: body.attemptId, code: lastCode() }).expect(204);
      await ageAttempts(61);

      await resend(body.attemptId).expect(400);
      await resend("3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c").expect(400);
    });
  });

  describe("email delivery failure", () => {
    it("keeps the attempt and returns 503 with its id but no secret", async () => {
      mail.sendLoginOtp.mockRejectedValueOnce(new Error("smtp down"));

      const response = await login().expect(503);

      expect(response.body).toMatchObject({
        confirmationRequired: true,
        method: "otp",
        attemptId: expect.any(String),
        retryAfterSeconds: 60,
      });
      const code = mail.sendLoginOtp.mock.lastCall[1];
      expect(JSON.stringify(response.body)).not.toContain(code);
      expect(await findAttempt(response.body.attemptId)).toMatchObject({
        consumed_at: null,
      });

      await resend(response.body.attemptId).expect(429);
      await ageAttempts(61);
      await resend(response.body.attemptId).expect(202);
      await confirm({ attemptId: response.body.attemptId, code: lastCode() }).expect(204);
    });

    it("keeps the new secret when resend fails", async () => {
      const { body } = await login().expect(202);
      const oldCode = lastCode();
      await ageAttempts(61);
      mail.sendLoginOtp.mockRejectedValueOnce(new Error("smtp down"));

      await resend(body.attemptId).expect(503);

      if (lastCode() !== oldCode) {
        await confirm({ attemptId: body.attemptId, code: oldCode }).expect(400);
      }
      await resend(body.attemptId).expect(429);
    });
  });

  describe("user no longer active", () => {
    it.each(["blocked", "deleting", "deleted", "pending"] as const)(
      "burns the attempt and returns 401 when the user became %s",
      async (status) => {
        const { body } = await login().expect(202);
        await db.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);

        const response = await confirm({
          attemptId: body.attemptId,
          code: lastCode(),
        }).expect(401);

        expect(response.body).toMatchObject({ code: "invalid_credentials" });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await findAttempt(body.attemptId)).toMatchObject({
          consumed_reason: "user_inactive",
        });
        await confirm({ attemptId: body.attemptId, code: lastCode() }).expect(400);
      },
    );

    it("refuses resend for a blocked user", async () => {
      const { body } = await login().expect(202);
      await db.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [userId]);
      await ageAttempts(61);

      await resend(body.attemptId).expect(401);

      expect(await findAttempt(body.attemptId)).toMatchObject({
        consumed_reason: "user_inactive",
      });
    });
  });

  describe("login with a link", () => {
    beforeEach(() => {
      process.env.LOGIN_EMAIL_CONFIRMATION_METHOD = "magic_link";
    });

    it("sends a link with the token in the URL fragment", async () => {
      const { body } = await login().expect(202);

      expect(body.method).toBe("magic_link");
      const link = new URL(lastLink());
      expect(`${link.origin}${link.pathname}`).toBe(
        `${process.env.FRONTEND_ORIGIN}/auth/login/confirm`,
      );
      expect(link.search).toBe("");
      const [attemptId, secret] = lastToken().split(".");
      expect(attemptId).toBe(body.attemptId);
      expect(Buffer.from(secret, "base64url")).toHaveLength(32);
      expect(JSON.stringify(body)).not.toContain(secret);
    });

    it("serves a page that does not sign in by itself", async () => {
      await login().expect(202);

      const page = await http()
        .get("/auth/login/confirm")
        .expect(200)
        .expect("Content-Type", /text\/html/)
        .expect("Cache-Control", "no-store")
        .expect("Referrer-Policy", "no-referrer");

      expect(page.headers["set-cookie"]).toBeUndefined();
      expect(page.text).toContain("location.hash");
      await confirm({ token: lastToken() }).expect(204);
    });

    it("signs in by the token exactly once", async () => {
      await login().expect(202);

      expectSession(await confirm({ token: lastToken() }).expect(204));
      await confirm({ token: lastToken() }).expect(400);
    });

    it("rejects a wrong secret without counting it", async () => {
      const { body } = await login().expect(202);
      const [attemptId] = lastToken().split(".");

      for (let i = 0; i < 6; i++) {
        await confirm({ token: `${attemptId}.${"A".repeat(43)}` }).expect(400);
      }

      expect(await findAttempt(body.attemptId)).toMatchObject({
        attempts: 0,
        consumed_at: null,
      });
      await confirm({ token: lastToken() }).expect(204);
    });

    it("cannot be confirmed through the code form", async () => {
      const { body } = await login().expect(202);

      await confirm({ attemptId: body.attemptId, code: "123456" }).expect(400);
    });

    it("cancels the old link after resend", async () => {
      await login().expect(202);
      const oldToken = lastToken();
      await ageAttempts(61);

      await resend(oldToken.split(".")[0]).expect(202);

      await confirm({ token: oldToken }).expect(400);
      await confirm({ token: lastToken() }).expect(204);
    });

    it("rejects an expired link", async () => {
      await login().expect(202);
      await ageAttempts(601);

      await confirm({ token: lastToken() }).expect(400);
    });
  });

  describe("audit log", () => {
    it.each(["otp", "magic_link"] as const)(
      "records each step for %s without secrets or the email",
      async (method) => {
        process.env.LOGIN_EMAIL_CONFIRMATION_METHOD = method;
        const { body } = await login().expect(202);
        const secret = method === "otp" ? lastCode() : lastToken();
        if (method === "otp") {
          await confirm({ attemptId: body.attemptId, code: wrong(secret) }).expect(400);
          await confirm({ attemptId: body.attemptId, code: secret }).expect(204);
        } else {
          await confirm({ token: secret }).expect(204);
        }

        const text = logs().join("\n");
        expect(text).toContain(`Login challenge created userId=${userId}`);
        expect(text).toContain(`Login challenge sent attemptId=${body.attemptId}`);
        expect(text).toContain(`Login confirmation succeeded method=${method}`);
        if (method === "otp") {
          expect(text).toContain("reason=wrong_secret");
        }
        expect(text).not.toContain(secret);
        expect(text).not.toContain(email);
        expect(text).not.toContain(password);
      },
    );
  });
});
