import { INestApplication, Logger, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import { AppModule } from "../src/app.module";
import { MailService } from "../src/mail/mail.service";
import { TEST_DB } from "./setup-env";

const password = "Passw0rd-secret";
const email = "abc@gmail.com";

describe("Registration (e2e)", () => {
  const mail = { sendOtp: jest.fn(), sendMagicLink: jest.fn() };
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;

  async function createApp() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue(mail)
      .compile();

    const created = moduleRef.createNestApplication();
    created.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await created.init();

    const dataSource = created.get(DataSource);
    if (dataSource.options.database !== TEST_DB) {
      throw new Error(`e2e tests must not run on ${dataSource.options.database}`);
    }
    return created;
  }

  const http = () => request(app.getHttpServer());
  const register = (body: object = { email, password }) =>
    http().post("/auth/register").send(body);
  const confirm = (body: object) =>
    http().post("/auth/register/confirm").send(body);
  const resend = (to = email) =>
    http().post("/auth/register/resend").send({ email: to });

  const lastOtp = (): string => mail.sendOtp.mock.lastCall[1];
  const lastToken = () =>
    new URL(mail.sendMagicLink.mock.lastCall[1]).searchParams.get("token")!;

  const findUser = async (address = email) =>
    (await db.query(`SELECT * FROM users WHERE email = $1`, [address]))[0];
  const findAttempt = async (id: string) =>
    (
      await db.query(`SELECT * FROM registration_confirmations WHERE id = $1`, [
        id,
      ])
    )[0];
  const allowResend = () =>
    db.query(
      `UPDATE registration_confirmations SET last_sent_at = now() - interval '2 minutes'`,
    );

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  function useConfirmation(method: "otp" | "magic_link") {
    process.env.REGISTRATION_CONFIRM_ENABLED = "true";
    process.env.REGISTRATION_CONFIRM_METHOD = method;
  }

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    app = await createApp();
    db = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    mail.sendOtp.mockReset();
    mail.sendMagicLink.mockReset();
    logged.forEach((spy) => spy.mockClear());
    process.env.REGISTRATION_CONFIRM_ENABLED = "false";
    process.env.REGISTRATION_CONFIRM_METHOD = "otp";
  });

  describe("without confirmation", () => {
    it("returns 201 with the normalized email and no secrets", async () => {
      const { body } = await register({
        email: "  ABC@Gmail.COM ",
        password,
      }).expect(201);

      expect(body).toMatchObject({ email, status: "active" });
      expect(JSON.stringify(body)).not.toContain(password);
      expect(JSON.stringify(body)).not.toContain("argon2");
      expect(mail.sendOtp).not.toHaveBeenCalled();
    });

    it("stores a salted slow hash and keeps spaces in the password", async () => {
      await register({ email, password: "  Passw0rd  " }).expect(201);
      await register({
        email: "other@gmail.com",
        password: "  Passw0rd  ",
      }).expect(201);

      const first = await findUser();
      const second = await findUser("other@gmail.com");
      expect(first.password_hash).toMatch(/^\$argon2id\$/);
      expect(first.password_hash).not.toBe(second.password_hash);
      expect(await argon2.verify(first.password_hash, "  Passw0rd  ")).toBe(true);
      expect(await argon2.verify(first.password_hash, "Passw0rd")).toBe(false);
    });

    it("returns 409 for the same email in any case", async () => {
      await register().expect(201);
      await register({ email: "ABC@GMAIL.COM", password }).expect(409);
    });

    it("treats a plus-tag as a separate address", async () => {
      await register({ email: "user@example.com", password }).expect(201);
      await register({ email: "user+tag@example.com", password }).expect(201);
    });

    it("creates one user for parallel requests, the rest get 409", async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => register()),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409, 409, 409, 409,
      ]);
      const [{ count }] = await db.query(`SELECT count(*) FROM users`);
      expect(count).toBe("1");
    });

    it.each([
      ["invalid email", { email: "not-an-email", password }],
      ["missing email", { password }],
      ["missing password", { email }],
      ["short password", { email, password: "Pass0rd" }],
      ["password without a digit", { email, password: "Password" }],
      ["password without a letter", { email, password: "12345678" }],
      ["too long password", { email, password: "a1".repeat(65) }],
    ])("returns 400 for %s", async (_case, body) => {
      await register(body).expect(400);

      expect(await findUser()).toBeUndefined();
    });
  });

  describe("confirmation by code", () => {
    beforeEach(() => useConfirmation("otp"));

    it("returns 202 without the code and keeps the user pending", async () => {
      const { body } = await register().expect(202);

      expect(body).toEqual({
        confirmationRequired: true,
        method: "otp",
        attemptId: expect.any(String),
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(lastOtp()).toMatch(/^\d{6}$/);
      expect(JSON.stringify(body)).not.toContain(lastOtp());
      expect((await findUser()).status).toBe("pending");
      expect((await findAttempt(body.attemptId)).secret_hash).not.toContain(
        lastOtp(),
      );
    });

    it("returns 409 while the email waits for confirmation", async () => {
      await register().expect(202);
      await register().expect(409);
    });

    it("activates by the correct code exactly once", async () => {
      const { body } = await register().expect(202);
      const payload = { attemptId: body.attemptId, code: lastOtp() };

      const confirmed = await confirm(payload).expect(200);

      expect(confirmed.body).toEqual({
        id: expect.any(String),
        email,
        status: "active",
      });
      expect((await findUser()).status).toBe("active");
      await confirm(payload).expect(400);
    });

    function wrongCode(code: string) {
      return code === "000000" ? "000001" : "000000";
    }

    it("accepts the correct code on the fifth try", async () => {
      const { body } = await register().expect(202);
      const { attemptId } = body;
      const code = lastOtp();

      for (let i = 0; i < 4; i++) {
        await confirm({ attemptId, code: wrongCode(code) }).expect(400);
      }

      await confirm({ attemptId, code }).expect(200);
    });

    it("returns 429 after five wrong codes, even for the correct one", async () => {
      const { body } = await register().expect(202);
      const { attemptId } = body;
      const code = lastOtp();

      for (let i = 0; i < 5; i++) {
        await confirm({ attemptId, code: wrongCode(code) }).expect(400);
      }

      await confirm({ attemptId, code }).expect(429);
      expect((await findUser()).status).toBe("pending");
    });

    it("does not lose wrong tries sent in parallel", async () => {
      const { body } = await register().expect(202);
      const { attemptId } = body;
      const code = wrongCode(lastOtp());

      const responses = await Promise.all(
        Array.from({ length: 7 }, () => confirm({ attemptId, code })),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        400, 400, 400, 400, 400, 429, 429,
      ]);
      expect((await findAttempt(attemptId)).failed_attempts).toBe(5);
    });

    it("activates only once for parallel correct codes", async () => {
      const { body } = await register().expect(202);
      const payload = { attemptId: body.attemptId, code: lastOtp() };

      const responses = await Promise.all([confirm(payload), confirm(payload)]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    });

    it("rejects an expired code without touching the counter", async () => {
      const { body } = await register().expect(202);
      await db.query(
        `UPDATE registration_confirmations SET expires_at = now() - interval '1 second'`,
      );

      await confirm({ attemptId: body.attemptId, code: lastOtp() }).expect(400);

      expect((await findAttempt(body.attemptId)).failed_attempts).toBe(0);
    });

    it("returns 400 for an unknown attempt", async () => {
      await confirm({
        attemptId: "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c",
        code: "123456",
      }).expect(400);
    });

    it("still confirms and resends after the flag is turned off", async () => {
      const { body } = await register().expect(202);
      process.env.REGISTRATION_CONFIRM_ENABLED = "false";
      await allowResend();

      await resend().expect(202);

      await confirm({ attemptId: body.attemptId, code: lastOtp() }).expect(200);
    });
  });

  describe("confirmation by link", () => {
    beforeEach(() => useConfirmation("magic_link"));

    it("sends a link to the confirmation page", async () => {
      const { body } = await register().expect(202);

      expect(body.method).toBe("magic_link");
      expect(mail.sendMagicLink.mock.lastCall[1]).toContain(
        "http://localhost:3200/auth/register/confirm?token=",
      );
      expect(Buffer.from(lastToken(), "base64url")).toHaveLength(32);
      expect(JSON.stringify(body)).not.toContain(lastToken());
    });

    it("does not activate or spend the token on GET", async () => {
      await register().expect(202);

      await http()
        .get("/auth/register/confirm")
        .query({ token: lastToken() })
        .expect(200);

      expect((await findUser()).status).toBe("pending");
      await confirm({ token: lastToken() }).expect(200);
    });

    it("activates by token exactly once", async () => {
      await register().expect(202);

      await confirm({ token: lastToken() }).expect(200);

      expect((await findUser()).status).toBe("active");
      await confirm({ token: lastToken() }).expect(400);
    });

    it("rejects an expired token", async () => {
      await register().expect(202);
      await db.query(
        `UPDATE registration_confirmations SET expires_at = now() - interval '1 second'`,
      );

      await confirm({ token: lastToken() }).expect(400);
    });

    it("cannot be confirmed through the code form", async () => {
      const { body } = await register().expect(202);

      await confirm({ attemptId: body.attemptId, code: "123456" }).expect(400);
    });
  });

  describe("resend", () => {
    it("returns 429 sooner than 60 seconds after the last email", async () => {
      useConfirmation("otp");
      await register().expect(202);

      await resend().expect(429);

      expect(mail.sendOtp).toHaveBeenCalledTimes(1);
    });

    it("replaces the code and resets the counter", async () => {
      useConfirmation("otp");
      const { body } = await register().expect(202);
      const { attemptId } = body;
      const oldCode = lastOtp();
      const wrong = oldCode === "000000" ? "000001" : "000000";
      for (let i = 0; i < 5; i++) {
        await confirm({ attemptId, code: wrong }).expect(400);
      }
      await allowResend();
      // новый код случайно может совпасть со старым
      mail.sendOtp.mockClear();

      const resent = await resend().expect(202);

      expect(resent.body).toMatchObject({
        confirmationRequired: true,
        method: "otp",
        attemptId,
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(JSON.stringify(resent.body)).not.toContain(lastOtp());
      expect((await findAttempt(attemptId)).failed_attempts).toBe(0);
      if (lastOtp() !== oldCode) {
        await confirm({ attemptId, code: oldCode }).expect(400);
      }
      await confirm({ attemptId, code: lastOtp() }).expect(200);
    });

    it("cancels the old link", async () => {
      useConfirmation("magic_link");
      await register().expect(202);
      const oldToken = lastToken();
      await allowResend();

      await resend().expect(202);

      await confirm({ token: oldToken }).expect(400);
      await confirm({ token: lastToken() }).expect(200);
    });

    it("sends one email for parallel requests", async () => {
      useConfirmation("otp");
      await register().expect(202);
      await allowResend();
      mail.sendOtp.mockClear();

      const responses = await Promise.all([resend(), resend()]);

      expect(responses.map((r) => r.status).sort()).toEqual([202, 429]);
      expect(mail.sendOtp).toHaveBeenCalledTimes(1);
    });

    it("returns 400 when nothing waits for confirmation", async () => {
      await resend("nobody@gmail.com").expect(400);

      await register().expect(201);
      await resend().expect(400);
    });
  });

  describe("email delivery failure", () => {
    beforeEach(() => useConfirmation("otp"));

    it("returns 503, keeps the records and recovers through resend", async () => {
      mail.sendOtp.mockRejectedValueOnce(new Error("smtp down"));

      await register().expect(503);

      expect((await findUser()).status).toBe("pending");
      await register().expect(409);

      const { body } = await resend().expect(202);
      await confirm({ attemptId: body.attemptId, code: lastOtp() }).expect(200);
    });

    it("allows an immediate retry when resend fails", async () => {
      await register().expect(202);
      await allowResend();
      mail.sendOtp.mockRejectedValueOnce(new Error("smtp down"));

      await resend().expect(503);

      await resend().expect(202);
    });
  });

  describe("audit log", () => {
    it("records rejected validation without the submitted values", async () => {
      await register({ email: "not-an-email", password: "weak-secret" }).expect(
        400,
      );

      const entry = logs().find((line) => line.includes("reason=validation"));
      expect(entry).toContain("route=POST /auth/register");
      expect(entry).toContain("email must be an email");
      expect(logs().join("\n")).not.toContain("weak-secret");
      expect(logs().join("\n")).not.toContain("not-an-email");
    });

    it("does not log the token from a rejected request", async () => {
      const token = "x".repeat(65);

      await confirm({ token }).expect(400);

      expect(logs().join("\n")).toContain("route=POST /auth/register/confirm");
      expect(logs().join("\n")).not.toContain(token);
    });

    it("records each step of a registration", async () => {
      useConfirmation("otp");
      const { body } = await register().expect(202);
      const code = lastOtp();
      const wrong = code === "000000" ? "000001" : "000000";

      await confirm({ attemptId: body.attemptId, code: wrong }).expect(400);
      await confirm({ attemptId: body.attemptId, code }).expect(200);
      await register().expect(409);

      const text = logs().join("\n");
      expect(text).toContain("Registration succeeded");
      expect(text).toContain("Confirmation sent");
      expect(text).toContain("Confirmation failed method=otp reason=wrong_code");
      expect(text).toContain("Confirmation succeeded method=otp");
      expect(text).toContain("email already registered");
    });

    it.each(["otp", "magic_link"] as const)(
      "never logs secrets for %s",
      async (method) => {
        useConfirmation(method);
        await register().expect(202);
        const secret = method === "otp" ? lastOtp() : lastToken();

        const text = logs().join("\n");
        expect(text).not.toContain(password);
        expect(text).not.toContain("argon2");
        expect(text).not.toContain(secret);
      },
    );
  });

  describe("rate limit", () => {
    let limitedApp: INestApplication;

    beforeAll(async () => {
      process.env.REGISTRATION_RATE_LIMIT = "2";
      limitedApp = await createApp();
      process.env.REGISTRATION_RATE_LIMIT = "1000";
    });

    afterAll(() => limitedApp.close());

    const send = (path: string, body: object) =>
      request(limitedApp.getHttpServer()).post(path).send(body);

    it("limits registration by the configured threshold and logs it", async () => {
      const statuses: number[] = [];
      for (const name of ["a", "b", "c"]) {
        const { status } = await send("/auth/register", {
          email: `${name}@gmail.com`,
          password,
        });
        statuses.push(status);
      }

      expect(statuses).toEqual([201, 201, 429]);
      expect(await findUser("c@gmail.com")).toBeUndefined();
      expect(logs().join("\n")).toContain(
        "reason=rate_limit route=POST /auth/register",
      );
    });

    it("limits resend separately from registration", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        const { status } = await send("/auth/register/resend", {
          email: "nobody@gmail.com",
        });
        statuses.push(status);
      }

      expect(statuses).toEqual([400, 400, 429]);
    });
  });
});
