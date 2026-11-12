import { HttpException, Logger } from "@nestjs/common";
import * as argon2 from "argon2";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock("argon2", () => {
  const actual = jest.requireActual("argon2");
  return { ...actual, verify: jest.fn(actual.verify) };
});

import { LoginService } from "./login.service";
import { LoginAttemptLimiter } from "./login-attempt-limiter.service";
jest.mock("./login-challenge.service", () => ({ LoginChallengeService: class {} }));
import type { UserStatus } from "../entities/user.entity";

const password = "Passw0rd";
const email = "abc@gmail.com";
const ip = "127.0.0.1";
const tokens = { accessToken: "access", refreshToken: "refresh" };
const challenge = {
  confirmationRequired: true as const,
  method: "otp" as const,
  attemptId: "attempt-1",
  expiresInSeconds: 600,
  resendAfterSeconds: 60,
};

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error("expected promise to reject");
}

describe("LoginService", () => {
  let passwordHash: string;
  let env: Record<string, string>;
  let userRepository: { findOne: jest.Mock };
  let tokenService: { signPair: jest.Mock };
  let challenges: { start: jest.Mock };
  let limiter: LoginAttemptLimiter;
  let service: LoginService;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    passwordHash = await argon2.hash(password);
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  beforeEach(async () => {
    env = {
      LOGIN_EMAIL_CONFIRMATION_ENABLED: "false",
      LOG_EMAIL_HMAC_KEY: "log-email-hmac-key-0123456789abcdef0123",
    };
    const config = {
      get: (key: string) => env[key],
      getOrThrow: (key: string) => env[key],
    };
    userRepository = { findOne: jest.fn() };
    tokenService = { signPair: jest.fn(() => tokens) };
    limiter = new LoginAttemptLimiter();
    challenges = { start: jest.fn(async () => challenge) };
    service = new LoginService(
      userRepository as any,
      config as any,
      tokenService as any,
      limiter,
      challenges as any,
    );
    await service.onModuleInit();
    warn.mockClear();
  });

  function withUser(status: UserStatus = "active") {
    userRepository.findOne.mockResolvedValue({
      id: "user-1",
      status,
      passwordHash,
    });
  }

  it("returns a token pair for an active user with the right password", async () => {
    withUser();

    await expect(service.login({ email, password }, ip)).resolves.toEqual({ tokens });
    expect(tokenService.signPair).toHaveBeenCalledWith("user-1");
    expect(challenges.start).not.toHaveBeenCalled();
  });

  it("starts an email challenge instead of issuing tokens when confirmation is on", async () => {
    env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "true";
    withUser();
    limiter.recordFailure(email, ip);

    await expect(service.login({ email, password }, ip)).resolves.toEqual({
      challenge,
    });
    expect(challenges.start).toHaveBeenCalledWith("user-1");
    expect(tokenService.signPair).not.toHaveBeenCalled();
    expect((limiter as any).failures.size).toBe(0);
  });

  it("does not start a challenge for a wrong password", async () => {
    env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "true";
    withUser();

    expect(
      (await errorOf(service.login({ email, password: "Wr0ngpass" }, ip))).status,
    ).toBe(401);
    expect(challenges.start).not.toHaveBeenCalled();
  });

  it("looks the user up by the normalized email only", async () => {
    withUser();

    await service.login({ email, password }, ip);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { email },
      select: { id: true, status: true, passwordHash: true },
    });
  });

  const invalidCredentials = {
    status: 401,
    body: {
      statusCode: 401,
      code: "invalid_credentials",
      message: "Invalid email or password",
    },
  };

  it("rejects an unknown email after checking the dummy hash", async () => {
    userRepository.findOne.mockResolvedValue(null);
    (argon2.verify as jest.Mock).mockClear();

    expect(await errorOf(service.login({ email, password }, ip))).toEqual(
      invalidCredentials,
    );
    expect(argon2.verify).toHaveBeenCalledWith((service as any).dummyHash, password);
    expect((service as any).dummyHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects a wrong password with the same response", async () => {
    withUser();

    expect(
      await errorOf(service.login({ email, password: "Wr0ngpass" }, ip)),
    ).toEqual(invalidCredentials);
  });

  it.each(["pending", "blocked", "deleting", "deleted"] as const)(
    "rejects a %s user even with the right password",
    async (status) => {
      withUser(status);

      expect(await errorOf(service.login({ email, password }, ip))).toEqual(
        invalidCredentials,
      );
      expect(tokenService.signPair).not.toHaveBeenCalled();
    },
  );

  it("blocks the sixth try after five failures without reading the user", async () => {
    withUser();
    for (let i = 0; i < 5; i++) {
      await errorOf(service.login({ email, password: "Wr0ngpass" }, ip));
    }
    userRepository.findOne.mockClear();

    const error = await errorOf(service.login({ email, password }, ip));

    expect(error.status).toBe(429);
    expect(error.body).toMatchObject({ code: "too_many_attempts" });
    expect(userRepository.findOne).not.toHaveBeenCalled();
  });

  it("resets the failure counter after a successful login", async () => {
    withUser();
    for (let i = 0; i < 4; i++) {
      await errorOf(service.login({ email, password: "Wr0ngpass" }, ip));
    }

    await service.login({ email, password }, ip);

    expect(limiter.isBlocked(email, ip)).toBe(false);
    for (let i = 0; i < 4; i++) {
      await errorOf(service.login({ email, password: "Wr0ngpass" }, ip));
    }
    await expect(service.login({ email, password }, ip)).resolves.toEqual({ tokens });
  });

  it("returns 503 when the database is unavailable", async () => {
    userRepository.findOne.mockRejectedValue(new Error("connection refused"));

    expect((await errorOf(service.login({ email, password }, ip))).status).toBe(503);
  });

  it("returns 503 when signing fails and keeps the failure counter", async () => {
    withUser();
    limiter.recordFailure(email, ip);
    tokenService.signPair.mockImplementation(() => {
      throw new Error("sign failed");
    });

    expect((await errorOf(service.login({ email, password }, ip))).status).toBe(503);
    expect((limiter as any).failures.size).toBe(1);
  });

  it("logs the reason without the email or the password", async () => {
    userRepository.findOne.mockResolvedValue(null);
    await errorOf(service.login({ email, password }, ip));
    withUser("blocked");
    await errorOf(service.login({ email, password }, ip));

    const text = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toMatch(/reason=unknown_email emailRef=[0-9a-f]{16}/);
    expect(text).toContain("reason=user_inactive status=blocked userId=user-1");
    expect(text).not.toContain(email);
    expect(text).not.toContain(password);
  });
});
