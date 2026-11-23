import { HttpException, Logger } from "@nestjs/common";
import { QueryFailedError } from "typeorm";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));

import { EmailChangeService } from "./email-change.service";
import { EmailChangeSendLimiter } from "./email-change-send-limiter.service";
import { User } from "../entities/user.entity";
import { EmailChangeChallenge } from "../entities/email-change-challenge.entity";
import { hashSecret } from "../../identity/confirmation/confirmation-secret";

const KEY = "unit-email-change-hmac-key-0123456789ab";
const CHALLENGE_ID = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";
const LINK_SECRET = "A".repeat(43);

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error("expected promise to reject");
}

describe("EmailChangeService", () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const config: Record<string, string> = {};
  let mail: { sendEmailChangeOtp: jest.Mock; sendEmailChangeMagicLink: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    exists: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    query: jest.Mock;
  };
  let user: Partial<User> | null;
  let challenge: Partial<EmailChangeChallenge> | null;
  let limiter: EmailChangeSendLimiter;
  let service: EmailChangeService;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    Object.assign(config, {
      EMAIL_CHANGE_METHOD: "otp",
      EMAIL_CHANGE_HMAC_KEY: KEY,
      FRONTEND_ORIGIN: "http://localhost:3200",
      PUBLIC_API_BASE_URL: "http://localhost:3200",
    });
    user = { id: "user-1", email: "alice@gmail.com", status: "active" };
    challenge = null;
    mail = {
      sendEmailChangeOtp: jest.fn().mockResolvedValue(undefined),
      sendEmailChangeMagicLink: jest.fn().mockResolvedValue(undefined),
    };
    manager = {
      findOne: jest.fn(async (entity) => (entity === User ? user : challenge)),
      findOneOrFail: jest.fn(async () => ({
        id: "user-1",
        email: "alice.new@gmail.com",
        displayName: "Alice",
        photoKey: null,
        status: "active",
        createdAt,
        updatedAt: new Date(),
      })),
      exists: jest.fn().mockResolvedValue(false),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(async (entity) => ({ ...entity, id: "challenge-new" })),
      create: jest.fn((_entity, data) => data),
      query: jest.fn().mockResolvedValue([]),
    };
    dataSource = { transaction: jest.fn((work) => work(manager)) };
    limiter = new EmailChangeSendLimiter();
    const configService = { getOrThrow: (key: string) => config[key] };
    service = new EmailChangeService(
      dataSource as any,
      mail as any,
      configService as any,
      limiter,
      configService as any,
    );
    warn.mockClear();
    error.mockClear();
  });

  const updatesOf = (entity: unknown) =>
    manager.update.mock.calls.filter(([target]) => target === entity);
  const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);
  const openChallenge = (overrides: Partial<EmailChangeChallenge> = {}) => ({
    id: CHALLENGE_ID,
    userId: "user-1",
    newEmail: "alice.new@gmail.com",
    method: "otp" as const,
    secretHash: hashSecret(KEY, "123456"),
    lastSentAt: secondsAgo(120),
    attempts: 0,
    consumedAt: null,
    consumedReason: null,
    ...overrides,
  });
  const logText = () =>
    [...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0])).join("\n");

  describe("start", () => {
    it("stores only the HMAC and sends the code to the new address", async () => {
      const response = await service.start("user-1", "alice.new@gmail.com");

      expect(response).toEqual({
        confirmationRequired: true,
        method: "otp",
        challengeId: "challenge-new",
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
      const code = mail.sendEmailChangeOtp.mock.lastCall[1];
      expect(mail.sendEmailChangeOtp).toHaveBeenCalledWith("alice.new@gmail.com", expect.stringMatching(/^\d{6}$/));
      expect(manager.save.mock.lastCall[0]).toMatchObject({
        userId: "user-1",
        method: "otp",
        newEmail: "alice.new@gmail.com",
        secretHash: hashSecret(KEY, code),
      });
    });

    it("sends a magic link with the token in the URL fragment", async () => {
      config.EMAIL_CHANGE_METHOD = "magic_link";

      await service.start("user-1", "alice.new@gmail.com");

      const link: string = mail.sendEmailChangeMagicLink.mock.lastCall[1];
      expect(link).toMatch(
        /^http:\/\/localhost:3200\/users\/user-1\/email-change\/confirm#token=challenge-new\.[A-Za-z0-9_-]{43}$/,
      );
    });

    it("answers 401 for an inactive user without a challenge", async () => {
      user = { ...user, status: "blocked" };

      const failure = await errorOf(service.start("user-1", "alice.new@gmail.com"));

      expect(failure.getStatus()).toBe(401);
      expect(manager.save).not.toHaveBeenCalled();
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it.each([
      ["email_unchanged", "alice@gmail.com", false],
      ["email_taken", "bob@gmail.com", true],
    ])("answers 409 %s", async (code, newEmail, taken) => {
      manager.exists.mockResolvedValue(taken);

      const failure = await errorOf(service.start("user-1", newEmail));

      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toMatchObject({ code });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("answers 429 with the remaining pause while the previous email is fresh", async () => {
      challenge = openChallenge({ lastSentAt: secondsAgo(20) });

      const failure = await errorOf(service.start("user-1", "alice.new@gmail.com"));

      expect(failure.getStatus()).toBe(429);
      expect(failure.getResponse()).toMatchObject({ code: "resend_too_early" });
      expect((failure.getResponse() as any).retryAfterSeconds).toBeGreaterThanOrEqual(39);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("replaces the previous challenge after the pause", async () => {
      challenge = openChallenge();

      await service.start("user-1", "alice.other@gmail.com");

      expect(updatesOf(EmailChangeChallenge)).toEqual([
        [EmailChangeChallenge, CHALLENGE_ID, { consumedAt: expect.any(Date), consumedReason: "replaced" }],
      ]);
    });

    it("keeps the previous challenge when the hourly limit is reached", async () => {
      challenge = openChallenge();
      for (let i = 0; i < 5; i++) {
        limiter.record("user-1");
      }

      const failure = await errorOf(service.start("user-1", "alice.other@gmail.com"));

      expect(failure.getResponse()).toMatchObject({ code: "rate_limited" });
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("keeps the challenge and answers 503 with safe retry fields when SMTP fails", async () => {
      mail.sendEmailChangeOtp.mockRejectedValue(
        Object.assign(new Error("Recipient address rejected: alice.new@gmail.com"), { code: "EENVELOPE" }),
      );

      const failure = await errorOf(service.start("user-1", "alice.new@gmail.com"));

      expect(failure.getStatus()).toBe(503);
      expect(failure.getResponse()).toEqual({
        statusCode: 503,
        code: "email_delivery_failed",
        message: "Failed to send confirmation email",
        confirmationRequired: true,
        method: "otp",
        challengeId: "challenge-new",
        retryAfterSeconds: 60,
      });
      expect(logText()).toContain("errorCode=EENVELOPE");
      expect(logText()).not.toContain("alice.new@gmail.com");
    });

    it("answers 503 users_unavailable when the transaction fails", async () => {
      dataSource.transaction.mockRejectedValue(new Error("connection terminated"));

      const failure = await errorOf(service.start("user-1", "alice.new@gmail.com"));

      expect(failure.getResponse()).toMatchObject({ statusCode: 503, code: "users_unavailable" });
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });
  });

  describe("resend", () => {
    it("replaces the secret, resets attempts and sends to the new address", async () => {
      challenge = openChallenge({ attempts: 3 });

      const response = await service.resend("user-1", CHALLENGE_ID);

      expect(response).toMatchObject({ challengeId: CHALLENGE_ID, method: "otp" });
      const code = mail.sendEmailChangeOtp.mock.lastCall[1];
      expect(mail.sendEmailChangeOtp).toHaveBeenCalledWith("alice.new@gmail.com", code);
      expect(updatesOf(EmailChangeChallenge)).toEqual([
        [
          EmailChangeChallenge,
          CHALLENGE_ID,
          { secretHash: hashSecret(KEY, code), attempts: 0, lastSentAt: expect.any(Date) },
        ],
      ]);
    });

    it("looks the challenge up only among the user's own", async () => {
      challenge = openChallenge();

      await service.resend("user-1", CHALLENGE_ID);

      expect(manager.findOne).toHaveBeenCalledWith(EmailChangeChallenge, {
        where: { id: CHALLENGE_ID, userId: "user-1" },
        lock: { mode: "pessimistic_write" },
      });
    });

    it("answers 400 invalid_challenge for an unknown challenge", async () => {
      const failure = await errorOf(service.resend("user-1", CHALLENGE_ID));

      expect(failure.getStatus()).toBe(400);
      expect(failure.getResponse()).toMatchObject({ code: "invalid_challenge" });
    });

    it.each([
      ["replaced", 400, "invalid_challenge"],
      ["confirmed", 400, "invalid_challenge"],
      ["user_inactive", 400, "invalid_challenge"],
      ["attempts_exhausted", 429, "attempts_exhausted"],
      ["admin_override", 409, "admin_override"],
      ["email_conflict", 409, "email_conflict"],
    ] as const)("answers %s with %i %s", async (reason, status, code) => {
      challenge = openChallenge({ consumedAt: new Date(), consumedReason: reason });

      const failure = await errorOf(service.resend("user-1", CHALLENGE_ID));

      expect(failure.getStatus()).toBe(status);
      expect(failure.getResponse()).toMatchObject({ code });
      expect(mail.sendEmailChangeOtp).not.toHaveBeenCalled();
    });

    it("answers 429 before the pause ends", async () => {
      challenge = openChallenge({ lastSentAt: secondsAgo(10) });

      const failure = await errorOf(service.resend("user-1", CHALLENGE_ID));

      expect(failure.getResponse()).toMatchObject({ code: "resend_too_early" });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("counts resends in the hourly limit", async () => {
      challenge = openChallenge();
      for (let i = 0; i < 4; i++) {
        limiter.record("user-1");
      }

      await service.resend("user-1", CHALLENGE_ID);
      const failure = await errorOf(service.resend("user-1", CHALLENGE_ID));

      expect(failure.getResponse()).toMatchObject({ code: "rate_limited" });
    });
  });

  describe("confirm", () => {
    const otp = (code: string) => ({ challengeId: CHALLENGE_ID, code });

    it("changes the email under a savepoint and returns the profile", async () => {
      challenge = openChallenge();

      const profile = await service.confirm("user-1", otp("123456"));

      expect(profile).toMatchObject({
        id: "user-1",
        email: "alice.new@gmail.com",
        photoUrl: null,
        status: "active",
      });
      expect(manager.query.mock.calls.map(([sql]) => sql)).toEqual([
        "SAVEPOINT email_change_update",
        "RELEASE SAVEPOINT email_change_update",
      ]);
      expect(updatesOf(User)).toEqual([
        [User, { id: "user-1" }, { email: "alice.new@gmail.com", updatedAt: expect.any(Date) }],
      ]);
      expect(updatesOf(EmailChangeChallenge)).toEqual([
        [EmailChangeChallenge, CHALLENGE_ID, { consumedAt: expect.any(Date), consumedReason: "confirmed" }],
      ]);
    });

    it("confirms a magic link token", async () => {
      challenge = openChallenge({ method: "magic_link", secretHash: hashSecret(KEY, LINK_SECRET) });

      await service.confirm("user-1", { token: `${CHALLENGE_ID}.${LINK_SECRET}` });

      expect(updatesOf(User)).toHaveLength(1);
    });

    it("answers 400 invalid_challenge when the method differs", async () => {
      challenge = openChallenge({ method: "magic_link" });

      const failure = await errorOf(service.confirm("user-1", otp("123456")));

      expect(failure.getResponse()).toMatchObject({ code: "invalid_challenge" });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("answers 400 challenge_expired without counting the attempt", async () => {
      challenge = openChallenge({ lastSentAt: secondsAgo(601) });

      const failure = await errorOf(service.confirm("user-1", otp("000000")));

      expect(failure.getStatus()).toBe(400);
      expect(failure.getResponse()).toMatchObject({ code: "challenge_expired" });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("consumes the challenge as user_inactive and answers 401 for an inactive user", async () => {
      user = { ...user, status: "blocked" };
      challenge = openChallenge();

      const failure = await errorOf(service.confirm("user-1", otp("123456")));

      expect(failure.getStatus()).toBe(401);
      expect(updatesOf(EmailChangeChallenge)).toEqual([
        [EmailChangeChallenge, CHALLENGE_ID, { consumedAt: expect.any(Date), consumedReason: "user_inactive" }],
      ]);
      expect(updatesOf(User)).toHaveLength(0);
    });

    it("counts a wrong code and answers 400 invalid_code", async () => {
      challenge = openChallenge({ attempts: 2 });

      const failure = await errorOf(service.confirm("user-1", otp("000000")));

      expect(failure.getResponse()).toMatchObject({ code: "invalid_code" });
      expect(updatesOf(EmailChangeChallenge)).toEqual([[EmailChangeChallenge, CHALLENGE_ID, { attempts: 3 }]]);
    });

    it("burns the challenge on the fifth wrong code", async () => {
      challenge = openChallenge({ attempts: 4 });

      const failure = await errorOf(service.confirm("user-1", otp("000000")));

      expect(failure.getStatus()).toBe(400);
      expect(failure.getResponse()).toMatchObject({ code: "attempts_exhausted" });
      expect(updatesOf(EmailChangeChallenge)).toEqual([
        [
          EmailChangeChallenge,
          CHALLENGE_ID,
          { attempts: 5, consumedAt: expect.any(Date), consumedReason: "attempts_exhausted" },
        ],
      ]);
    });

    it("does not count a wrong magic link", async () => {
      challenge = openChallenge({ method: "magic_link", secretHash: hashSecret(KEY, LINK_SECRET) });

      const failure = await errorOf(
        service.confirm("user-1", { token: `${CHALLENGE_ID}.${"B".repeat(43)}` }),
      );

      expect(failure.getResponse()).toMatchObject({ code: "invalid_code" });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("rolls back only the email update on a unique conflict and answers 409", async () => {
      challenge = openChallenge();
      manager.update.mockImplementation(async (entity) => {
        if (entity === User) {
          throw new QueryFailedError(
            "UPDATE",
            [],
            Object.assign(new Error("duplicate key"), {
              code: "23505",
              constraint: "UQ_97672ac88f789774dd47f7c8be3",
            }),
          );
        }
        return { affected: 1 };
      });

      const failure = await errorOf(service.confirm("user-1", otp("123456")));

      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toMatchObject({ code: "email_conflict" });
      expect(manager.query.mock.calls.map(([sql]) => sql)).toEqual([
        "SAVEPOINT email_change_update",
        "ROLLBACK TO SAVEPOINT email_change_update",
      ]);
      expect(updatesOf(EmailChangeChallenge)).toEqual([
        [EmailChangeChallenge, CHALLENGE_ID, { consumedAt: expect.any(Date), consumedReason: "email_conflict" }],
      ]);
    });

    it("answers 503 and keeps the challenge usable when the update fails otherwise", async () => {
      challenge = openChallenge();
      manager.update.mockRejectedValue(new Error("connection terminated"));

      const failure = await errorOf(service.confirm("user-1", otp("123456")));

      expect(failure.getResponse()).toMatchObject({ statusCode: 503, code: "users_unavailable" });
    });

    it("never logs the code or the addresses", async () => {
      challenge = openChallenge();

      await errorOf(service.confirm("user-1", otp("000000")));

      expect(logText()).toContain(`challengeId=${CHALLENGE_ID}`);
      expect(logText()).not.toMatch(/000000|alice/);
    });
  });
});
