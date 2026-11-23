import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { RbacBootstrapService } from "../src/access-control/rbac/services/rbac-bootstrap.service";
import { TokenService } from "../src/identity/authentication/services/token.service";
import { EmailChangeSendLimiter } from "../src/users/services/email-change-send-limiter.service";
import { createTestApp } from "./helpers/create-test-app";
import { resetRbac } from "./helpers/rbac";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const NEW_EMAIL = "alice.new@gmail.com";

describe("Email change (e2e)", () => {
  const mail = {
    sendEmailChangeOtp: jest.fn(),
    sendEmailChangeMagicLink: jest.fn(),
  };
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let adminId: string;
  let aliceId: string;
  let bobId: string;

  async function startApp(method: "otp" | "magic_link") {
    process.env.EMAIL_CHANGE_METHOD = method;
    ({ app, db } = await createTestApp({ mail }));
  }

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    await startApp("otp");
  });

  afterAll(async () => {
    await app.close();
    process.env.EMAIL_CHANGE_METHOD = "otp";
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
    (app.get(EmailChangeSendLimiter) as unknown as { sends: Map<string, number[]> }).sends.clear();
    Object.values(mail).forEach((fn) => fn.mockReset());
    logged.forEach((spy) => spy.mockClear());
  });

  const http = () => request(app.getHttpServer());
  const cookie = (userId: string) =>
    `access_token=${app.get(TokenService).signPair(userId).accessToken}`;
  const start = (actor: string, target: string, newEmail: unknown = NEW_EMAIL) =>
    http().post(`/users/${target}/email-change`).set("Cookie", cookie(actor)).send({ newEmail });
  const resend = (actor: string, target: string, challengeId: string) =>
    http()
      .post(`/users/${target}/email-change/resend`)
      .set("Cookie", cookie(actor))
      .send({ challengeId });
  const confirm = (actor: string, target: string, body: object) =>
    http()
      .post(`/users/${target}/email-change/confirm`)
      .set("Cookie", cookie(actor))
      .send(body);

  const lastCode = (): string => mail.sendEmailChangeOtp.mock.lastCall[1];
  const wrong = (code: string) => (code === "000000" ? "000001" : "000000");
  const lastToken = () =>
    new URLSearchParams(new URL(mail.sendEmailChangeMagicLink.mock.lastCall[1]).hash.slice(1)).get(
      "token",
    )!;

  const challenge = async (id: string) =>
    (await db.query(`SELECT * FROM email_change_challenges WHERE id = $1`, [id]))[0];
  const emailOf = async (userId: string) =>
    (await db.query(`SELECT email FROM users WHERE id = $1`, [userId]))[0].email;
  const ageChallenges = (seconds: number) =>
    db.query(
      `UPDATE email_change_challenges SET last_sent_at = last_sent_at - make_interval(secs => $1)`,
      [seconds],
    );

  const logs = () => logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  describe("start", () => {
    it("answers 202, sends the code only to the new address and stores its HMAC", async () => {
      const response = await start(aliceId, aliceId).expect(202);

      expect(response.body).toEqual({
        confirmationRequired: true,
        method: "otp",
        challengeId: expect.any(String),
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      expect(mail.sendEmailChangeOtp).toHaveBeenCalledTimes(1);
      expect(mail.sendEmailChangeOtp).toHaveBeenCalledWith(NEW_EMAIL, expect.stringMatching(/^\d{6}$/));
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(lastCode());
      expect(text).not.toContain("@");
      const stored = await challenge(response.body.challengeId);
      expect(stored).toMatchObject({ user_id: aliceId, new_email: NEW_EMAIL, method: "otp", attempts: 0 });
      expect(stored.secret_hash).not.toContain(lastCode());
      expect(await emailOf(aliceId)).toBe("alice@gmail.com");
    });

    it("normalizes the new address and keeps +tag", async () => {
      await start(aliceId, aliceId, "  Alice.New+Tag@Gmail.COM ").expect(202);

      expect(mail.sendEmailChangeOtp).toHaveBeenCalledWith("alice.new+tag@gmail.com", expect.any(String));
    });

    it("answers the same 403 for a foreign and a missing user before any lookup", async () => {
      const foreign = await start(adminId, aliceId).expect(403);
      const missing = await start(adminId, MISSING_ID).expect(403);

      expect(foreign.body).toEqual(missing.body);
      expect(foreign.body.code).toBe("permission_denied");
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
      expect(await db.query(`SELECT id FROM email_change_challenges`)).toEqual([]);
    });

    it.each([
      ["email_taken", "BOB@gmail.com"],
      ["email_unchanged", " Alice@Gmail.com"],
    ])("answers 409 %s", async (code, newEmail) => {
      const response = await start(aliceId, aliceId, newEmail).expect(409);

      expect(response.body.code).toBe(code);
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it("answers 400 to a body without newEmail", async () => {
      await http().post(`/users/${aliceId}/email-change`).set("Cookie", cookie(aliceId)).send({}).expect(400);
    });

    it.each([
      ["an invalid address", "not-an-email"],
      ["a number", 42],
    ])("answers 400 to %s", async (_case, newEmail) => {
      await start(aliceId, aliceId, newEmail).expect(400);
    });

    it("answers 401 without a session", async () => {
      await http().post(`/users/${aliceId}/email-change`).send({ newEmail: NEW_EMAIL }).expect(401);
    });

    it("answers 429 within 60 seconds and replaces the challenge after the pause", async () => {
      const first = await start(aliceId, aliceId).expect(202);
      const firstCode = lastCode();

      const early = await start(aliceId, aliceId, "alice.other@gmail.com").expect(429);
      expect(early.body).toMatchObject({ code: "resend_too_early", retryAfterSeconds: expect.any(Number) });

      await ageChallenges(61);
      const second = await start(aliceId, aliceId, "alice.other@gmail.com").expect(202);

      expect(await challenge(first.body.challengeId)).toMatchObject({ consumed_reason: "replaced" });
      const stale = await confirm(aliceId, aliceId, {
        challengeId: first.body.challengeId,
        code: firstCode,
      }).expect(400);
      expect(stale.body.code).toBe("invalid_challenge");
      await confirm(aliceId, aliceId, { challengeId: second.body.challengeId, code: lastCode() }).expect(200);
      expect(await emailOf(aliceId)).toBe("alice.other@gmail.com");
    });

    it("keeps the challenge and answers 503 with safe retry fields when SMTP fails", async () => {
      mail.sendEmailChangeOtp.mockRejectedValueOnce(
        Object.assign(new Error(`Recipient address rejected: ${NEW_EMAIL}`), { code: "EENVELOPE" }),
      );

      const response = await start(aliceId, aliceId).expect(503);

      expect(response.body).toEqual({
        statusCode: 503,
        code: "email_delivery_failed",
        message: "Failed to send confirmation email",
        confirmationRequired: true,
        method: "otp",
        challengeId: expect.any(String),
        retryAfterSeconds: 60,
      });
      expect(await challenge(response.body.challengeId)).toMatchObject({ consumed_at: null });
      expect(logs().join("\n")).not.toContain(NEW_EMAIL);
    });

    it("sends at most 5 emails an hour across start and resend", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      for (let i = 0; i < 4; i++) {
        await ageChallenges(61);
        await resend(aliceId, aliceId, body.challengeId).expect(202);
      }
      await ageChallenges(61);

      const response = await resend(aliceId, aliceId, body.challengeId).expect(429);

      expect(response.body).toMatchObject({ code: "rate_limited", retryAfterSeconds: expect.any(Number) });
      expect(mail.sendEmailChangeOtp).toHaveBeenCalledTimes(5);
      expect(logs().join("\n")).toContain(
        `Email change challenge rejected reason=rate_limited userId=${aliceId}`,
      );
    });
  });

  describe("resend", () => {
    it("replaces the code, resets attempts and keeps the address", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      const oldCode = lastCode();
      await confirm(aliceId, aliceId, { challengeId: body.challengeId, code: wrong(oldCode) }).expect(400);
      await ageChallenges(61);

      const response = await resend(aliceId, aliceId, body.challengeId).expect(202);

      expect(response.body).toMatchObject({ challengeId: body.challengeId, method: "otp" });
      expect(mail.sendEmailChangeOtp).toHaveBeenLastCalledWith(NEW_EMAIL, expect.any(String));
      expect(await challenge(body.challengeId)).toMatchObject({ attempts: 0, consumed_at: null });
      const newCode = lastCode();
      if (newCode !== oldCode) {
        await confirm(aliceId, aliceId, { challengeId: body.challengeId, code: oldCode }).expect(400);
      }
      await confirm(aliceId, aliceId, { challengeId: body.challengeId, code: newCode }).expect(200);
    });

    it("answers 429 within 60 seconds", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);

      const response = await resend(aliceId, aliceId, body.challengeId).expect(429);

      expect(response.body.code).toBe("resend_too_early");
    });

    it("answers 400 to an unknown or someone else's challenge", async () => {
      const { body } = await start(bobId, bobId, "bob.new@gmail.com").expect(202);
      await ageChallenges(61);

      for (const challengeId of [MISSING_ID, body.challengeId]) {
        const response = await resend(aliceId, aliceId, challengeId).expect(400);
        expect(response.body.code).toBe("invalid_challenge");
      }
    });

    it("answers 403 for a foreign userId", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);

      const response = await resend(adminId, aliceId, body.challengeId).expect(403);

      expect(response.body.code).toBe("permission_denied");
    });
  });

  describe("confirm with a code", () => {
    it("changes the email atomically and the profile shows it", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      const payload = { challengeId: body.challengeId, code: lastCode() };

      const response = await confirm(aliceId, aliceId, payload).expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        "createdAt",
        "displayName",
        "email",
        "id",
        "photoUrl",
        "status",
        "updatedAt",
      ]);
      expect(response.body).toMatchObject({ id: aliceId, email: NEW_EMAIL, status: "active" });
      expect(await challenge(body.challengeId)).toMatchObject({ consumed_reason: "confirmed" });
      const profile = await http().get(`/users/${aliceId}`).set("Cookie", cookie(aliceId)).expect(200);
      expect(profile.body.email).toBe(NEW_EMAIL);

      const repeated = await confirm(aliceId, aliceId, payload).expect(400);
      expect(repeated.body.code).toBe("invalid_challenge");
    });

    it("answers 403 for a foreign userId without touching the challenge", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);

      await confirm(adminId, aliceId, { challengeId: body.challengeId, code: lastCode() }).expect(403);

      expect(await challenge(body.challengeId)).toMatchObject({ attempts: 0, consumed_at: null });
      expect(await emailOf(aliceId)).toBe("alice@gmail.com");
    });

    it("accepts the right code on the fifth try", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      const code = lastCode();
      for (let i = 0; i < 4; i++) {
        await confirm(aliceId, aliceId, { challengeId: body.challengeId, code: wrong(code) }).expect(400);
      }

      await confirm(aliceId, aliceId, { challengeId: body.challengeId, code }).expect(200);
    });

    it("burns the challenge on the fifth wrong code and answers 429 afterwards", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      const code = lastCode();
      for (let i = 0; i < 4; i++) {
        const response = await confirm(aliceId, aliceId, {
          challengeId: body.challengeId,
          code: wrong(code),
        }).expect(400);
        expect(response.body.code).toBe("invalid_code");
      }

      const fifth = await confirm(aliceId, aliceId, {
        challengeId: body.challengeId,
        code: wrong(code),
      }).expect(400);
      expect(fifth.body.code).toBe("attempts_exhausted");

      const after = await confirm(aliceId, aliceId, { challengeId: body.challengeId, code }).expect(429);
      expect(after.body.code).toBe("attempts_exhausted");
      expect(await challenge(body.challengeId)).toMatchObject({
        attempts: 5,
        consumed_reason: "attempts_exhausted",
      });
      expect(await emailOf(aliceId)).toBe("alice@gmail.com");

      await ageChallenges(61);
      const resent = await resend(aliceId, aliceId, body.challengeId).expect(429);
      expect(resent.body.code).toBe("attempts_exhausted");
    });

    it("answers 400 challenge_expired after 10 minutes without counting the attempt", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      await ageChallenges(601);

      const response = await confirm(aliceId, aliceId, {
        challengeId: body.challengeId,
        code: lastCode(),
      }).expect(400);

      expect(response.body.code).toBe("challenge_expired");
      expect(await challenge(body.challengeId)).toMatchObject({ attempts: 0, consumed_at: null });
    });

    it("answers 409 admin_override after an admin changed the email directly", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      await http()
        .patch(`/users/${aliceId}`)
        .set("Cookie", cookie(adminId))
        .send({ email: "alice.admin@gmail.com" })
        .expect(200);

      const response = await confirm(aliceId, aliceId, {
        challengeId: body.challengeId,
        code: lastCode(),
      }).expect(409);

      expect(response.body.code).toBe("admin_override");
      expect(await emailOf(aliceId)).toBe("alice.admin@gmail.com");
    });

    it("lets exactly one of two parallel confirmations to the same address win", async () => {
      const alice = await start(aliceId, aliceId, "race@gmail.com").expect(202);
      const aliceCode = lastCode();
      const bob = await start(bobId, bobId, "race@gmail.com").expect(202);
      const bobCode = lastCode();

      const responses = await Promise.all([
        confirm(aliceId, aliceId, { challengeId: alice.body.challengeId, code: aliceCode }),
        confirm(bobId, bobId, { challengeId: bob.body.challengeId, code: bobCode }),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)!.body.code).toBe("email_conflict");
      const [{ count }] = await db.query(
        `SELECT count(*)::int AS count FROM users WHERE email = 'race@gmail.com'`,
      );
      expect(count).toBe(1);
      const reasons = await db.query(
        `SELECT consumed_reason FROM email_change_challenges ORDER BY consumed_reason`,
      );
      expect(reasons.map((r: { consumed_reason: string }) => r.consumed_reason)).toEqual([
        "confirmed",
        "email_conflict",
      ]);
    });

    it.each([
      ["an empty body", {}],
      ["a code without challengeId", { code: "123456" }],
      ["a code with a token", { challengeId: MISSING_ID, code: "123456", token: `${MISSING_ID}.${"A".repeat(43)}` }],
      ["a short code", { challengeId: MISSING_ID, code: "12345" }],
    ])("answers 400 to %s", async (_case, payload) => {
      await confirm(aliceId, aliceId, payload).expect(400);
    });

    it("logs challenge events without addresses or codes", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      const code = lastCode();
      await confirm(aliceId, aliceId, { challengeId: body.challengeId, code: wrong(code) }).expect(400);
      await confirm(aliceId, aliceId, { challengeId: body.challengeId, code }).expect(200);

      const text = logs().join("\n");
      expect(text).toContain(`Email change challenge created userId=${aliceId} challengeId=${body.challengeId} method=otp`);
      expect(text).toContain(`reason=invalid_secret userId=${aliceId} challengeId=${body.challengeId}`);
      expect(text).not.toContain(NEW_EMAIL);
      expect(text).not.toContain(code);
    });
  });

  describe("confirm with a magic link", () => {
    beforeAll(async () => {
      await app.close();
      await startApp("magic_link");
    });

    afterAll(async () => {
      await app.close();
      await startApp("otp");
    });

    it("sends the token in the URL fragment and confirms it with POST", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);

      expect(body.method).toBe("magic_link");
      const link: string = mail.sendEmailChangeMagicLink.mock.lastCall[1];
      expect(
        link.startsWith(`http://localhost:3200/users/${aliceId}/email-change/confirm#token=`),
      ).toBe(true);
      expect(lastToken().startsWith(`${body.challengeId}.`)).toBe(true);

      const response = await confirm(aliceId, aliceId, { token: lastToken() }).expect(200);

      expect(response.body.email).toBe(NEW_EMAIL);
    });

    it("serves the page from the email link without a session and without changes", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);
      const link = new URL(mail.sendEmailChangeMagicLink.mock.lastCall[1]);

      const page = await http()
        .get(link.pathname)
        .expect(200)
        .expect("Content-Type", /text\/html/)
        .expect("Cache-Control", "no-store")
        .expect("Referrer-Policy", "no-referrer");

      expect(page.text).toContain("Подтверждение нового email");
      expect(page.text).toContain("X-CSRF-Protection");
      expect(page.text).not.toContain(lastToken());
      expect(await challenge(body.challengeId)).toMatchObject({ attempts: 0, consumed_at: null });
      expect(await emailOf(aliceId)).toBe("alice@gmail.com");
    });

    it("answers 400 to a wrong link without counting attempts", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);

      const response = await confirm(aliceId, aliceId, {
        token: `${body.challengeId}.${"A".repeat(43)}`,
      }).expect(400);

      expect(response.body.code).toBe("invalid_code");
      expect(await challenge(body.challengeId)).toMatchObject({ attempts: 0, consumed_at: null });
    });

    it("answers 400 invalid_challenge to a code for a magic link challenge", async () => {
      const { body } = await start(aliceId, aliceId).expect(202);

      const response = await confirm(aliceId, aliceId, {
        challengeId: body.challengeId,
        code: "123456",
      }).expect(400);

      expect(response.body.code).toBe("invalid_challenge");
    });
  });
});
