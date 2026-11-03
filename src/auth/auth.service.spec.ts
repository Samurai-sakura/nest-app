import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { createHmac } from "crypto";
import * as argon2 from "argon2";

// эти пакеты опубликованы как ES-модули, которые Jest (CommonJS) не загружает;
// сервису в тесте они не нужны, все зависимости передаются вручную
jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock("../mail/mail.service", () => ({ MailService: class {} }));

import { AuthService } from "./auth.service";
import { User } from "./entities/user.entity";
import { RegistrationConfirmation } from "./entities/registration-confirmation.entity";

const HMAC_SECRET = "test-secret";
const hmac = (value: string) =>
  createHmac("sha256", HMAC_SECRET).update(value).digest("hex");

async function statusOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getStatus();
  }
  throw new Error("expected promise to reject");
}

function uniqueViolation() {
  const error = new QueryFailedError("INSERT", [], new Error("duplicate key"));
  (error as any).code = "23505";
  return error;
}

function makeAttempt(
  overrides: Partial<RegistrationConfirmation> = {},
): RegistrationConfirmation {
  return {
    id: "attempt-1",
    userId: "user-1",
    method: "otp",
    secretHash: hmac("123456"),
    failedAttempts: 0,
    expiresAt: new Date(Date.now() + 600_000),
    lastSentAt: new Date(Date.now() - 120_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as RegistrationConfirmation;
}

describe("AuthService", () => {
  let env: Record<string, string>;
  let userRepository: { create: jest.Mock; save: jest.Mock };
  let confirmationRepository: { update: jest.Mock };
  let attempts: { findOne: jest.Mock; increment: jest.Mock; update: jest.Mock };
  let manager: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock };
  let mail: { sendOtp: jest.Mock; sendMagicLink: jest.Mock };
  let service: AuthService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  beforeEach(() => {
    env = {
      REGISTRATION_CONFIRM_ENABLED: "false",
      REGISTRATION_CONFIRM_METHOD: "otp",
      CONFIRMATION_HMAC_SECRET: HMAC_SECRET,
      APP_URL: "http://localhost:3200",
    };
    const config = {
      get: (key: string) => env[key],
      getOrThrow: (key: string) => {
        if (env[key] === undefined) throw new Error(`missing ${key}`);
        return env[key];
      },
    };

    userRepository = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (user) => Object.assign(user, { id: "user-1" })),
    };
    confirmationRepository = { update: jest.fn() };
    attempts = { findOne: jest.fn(), increment: jest.fn(), update: jest.fn() };
    manager = {
      getRepository: jest.fn(() => attempts),
      create: jest.fn((_entity, data) => ({ ...data })),
      save: jest.fn(async (data) => ({
        ...data,
        id: data.userId ? "attempt-1" : "user-1",
      })),
      update: jest.fn(),
      findOneBy: jest.fn(),
      findOne: jest.fn(),
      findOneByOrFail: jest.fn(async () => ({
        id: "user-1",
        email: "abc@gmail.com",
        status: "active",
      })),
    };
    dataSource = { transaction: jest.fn((cb) => cb(manager)) };
    mail = { sendOtp: jest.fn(), sendMagicLink: jest.fn() };

    service = new AuthService(
      userRepository as any,
      confirmationRepository as any,
      dataSource as any,
      config as any,
      mail as any,
    );
  });

  describe("register without confirmation", () => {
    const dto = { email: "abc@gmail.com", password: "Passw0rd" };

    it("creates an active user with a slow password hash", async () => {
      const result = await service.register(dto);

      const saved = userRepository.save.mock.calls[0][0];
      expect(saved.status).toBe("active");
      expect(saved.passwordHash).not.toBe(dto.password);
      expect(await argon2.verify(saved.passwordHash, dto.password)).toBe(true);
      expect(result).toMatchObject({
        id: "user-1",
        email: "abc@gmail.com",
        status: "active",
      });
      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("password");
    });

    it("throws 409 when email is already taken", async () => {
      userRepository.save.mockRejectedValue(uniqueViolation());

      await expect(service.register(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe("register with confirmation", () => {
    const dto = { email: "abc@gmail.com", password: "Passw0rd" };

    beforeEach(() => {
      env.REGISTRATION_CONFIRM_ENABLED = "true";
    });

    it("creates a pending user and sends an OTP", async () => {
      const result = await service.register(dto);

      const [userData, attemptData] = manager.save.mock.calls.map((c) => c[0]);
      expect(userData.status).toBe("pending");
      expect(attemptData.method).toBe("otp");

      const code = mail.sendOtp.mock.calls[0][1];
      expect(code).toMatch(/^\d{6}$/);
      expect(attemptData.secretHash).toBe(hmac(code));
      expect(attemptData.secretHash).not.toContain(code);
      expect(attemptData.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);

      expect(confirmationRepository.update).toHaveBeenCalledWith("attempt-1", {
        lastSentAt: expect.any(Date),
      });
      expect(result).toEqual({
        confirmationRequired: true,
        method: "otp",
        attemptId: "attempt-1",
        expiresInSeconds: 600,
        resendAfterSeconds: 60,
      });
    });

    it("sends a magic link whose token matches the stored hash", async () => {
      env.REGISTRATION_CONFIRM_METHOD = "magic_link";

      const result = await service.register(dto);

      const link: string = mail.sendMagicLink.mock.calls[0][1];
      expect(link).toContain(
        "http://localhost:3200/auth/register/confirm?token=",
      );
      const token = new URL(link).searchParams.get("token")!;
      expect(Buffer.from(token, "base64url")).toHaveLength(32);

      const attemptData = manager.save.mock.calls[1][0];
      expect(attemptData.secretHash).toBe(hmac(token));
      expect(result).toMatchObject({ method: "magic_link" });
      expect(JSON.stringify(result)).not.toContain(token);
    });

    it("throws 503 and keeps records when email is not sent", async () => {
      mail.sendOtp.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(service.register(dto)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(confirmationRepository.update).not.toHaveBeenCalled();
    });

    it("throws 409 when email is already taken", async () => {
      manager.save.mockRejectedValueOnce(uniqueViolation());

      await expect(service.register(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mail.sendOtp).not.toHaveBeenCalled();
    });
  });

  describe("confirmOtp", () => {
    const dto = { attemptId: "attempt-1", code: "123456" };

    it("activates the user and consumes the attempt", async () => {
      attempts.findOne.mockResolvedValue(makeAttempt());

      const result = await service.confirm(dto);

      expect(manager.update).toHaveBeenCalledWith(User, "user-1", {
        status: "active",
      });
      expect(attempts.update).toHaveBeenCalledWith("attempt-1", {
        consumedAt: expect.any(Date),
      });
      expect(result).toEqual({
        id: "user-1",
        email: "abc@gmail.com",
        status: "active",
      });
    });

    it("throws 400 and increments the counter on a wrong code", async () => {
      attempts.findOne.mockResolvedValue(makeAttempt());

      await expect(
        service.confirm({ ...dto, code: "000000" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(attempts.increment).toHaveBeenCalledWith(
        { id: "attempt-1" },
        "failedAttempts",
        1,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("accepts the correct code on the fifth try", async () => {
      attempts.findOne.mockResolvedValue(makeAttempt({ failedAttempts: 4 }));

      await expect(service.confirm(dto)).resolves.toMatchObject({
        status: "active",
      });
    });

    it("throws 429 after 5 failed tries even with the correct code", async () => {
      attempts.findOne.mockResolvedValue(makeAttempt({ failedAttempts: 5 }));

      expect(await statusOf(service.confirm(dto))).toBe(429);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("throws 400 without touching the counter when expired", async () => {
      attempts.findOne.mockResolvedValue(
        makeAttempt({ expiresAt: new Date(Date.now() - 1000) }),
      );

      expect(await statusOf(service.confirm(dto))).toBe(400);
      expect(attempts.increment).not.toHaveBeenCalled();
    });

    it("throws 400 when the attempt is not found", async () => {
      attempts.findOne.mockResolvedValue(null);

      expect(await statusOf(service.confirm(dto))).toBe(400);
    });

    it("throws 400 when the attempt is already consumed", async () => {
      attempts.findOne.mockResolvedValue(
        makeAttempt({ consumedAt: new Date() }),
      );

      expect(await statusOf(service.confirm(dto))).toBe(400);
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe("confirmLink", () => {
    const token = "some-token";

    it("finds the attempt by token HMAC and activates the user", async () => {
      attempts.findOne.mockResolvedValue(
        makeAttempt({ method: "magic_link", secretHash: hmac(token) }),
      );

      const result = await service.confirm({ token });

      expect(attempts.findOne.mock.calls[0][0].where.secretHash).toBe(
        hmac(token),
      );
      expect(result).toMatchObject({ status: "active" });
    });

    it("throws 400 for an unknown token", async () => {
      attempts.findOne.mockResolvedValue(null);

      expect(await statusOf(service.confirm({ token }))).toBe(400);
    });

    it("throws 400 when the link is expired", async () => {
      attempts.findOne.mockResolvedValue(
        makeAttempt({
          method: "magic_link",
          expiresAt: new Date(Date.now() - 1000),
        }),
      );

      expect(await statusOf(service.confirm({ token }))).toBe(400);
    });
  });

  describe("resend", () => {
    const dto = { email: "abc@gmail.com" };
    const pendingUser = { id: "user-1", email: "abc@gmail.com", status: "pending" };

    it("replaces the secret, resets counter and TTL, sends a new email", async () => {
      manager.findOneBy.mockResolvedValue(pendingUser);
      manager.findOne.mockResolvedValue(makeAttempt({ failedAttempts: 3 }));

      const result = await service.resend(dto);

      const [entity, id, changes] = manager.update.mock.calls[0];
      expect(entity).toBe(RegistrationConfirmation);
      expect(id).toBe("attempt-1");
      expect(changes.failedAttempts).toBe(0);
      expect(changes.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);

      const newCode = mail.sendOtp.mock.calls[0][1];
      expect(changes.secretHash).toBe(hmac(newCode));
      expect(changes.secretHash).not.toBe(hmac("123456"));
      expect(result).toMatchObject({
        confirmationRequired: true,
        method: "otp",
        attemptId: "attempt-1",
      });
    });

    it("uses the attempt's method, not the current setting", async () => {
      env.REGISTRATION_CONFIRM_METHOD = "otp";
      manager.findOneBy.mockResolvedValue(pendingUser);
      manager.findOne.mockResolvedValue(makeAttempt({ method: "magic_link" }));

      await service.resend(dto);

      expect(mail.sendMagicLink).toHaveBeenCalled();
      expect(mail.sendOtp).not.toHaveBeenCalled();
    });

    it("throws 429 when called within 60 seconds", async () => {
      manager.findOneBy.mockResolvedValue(pendingUser);
      manager.findOne.mockResolvedValue(
        makeAttempt({ lastSentAt: new Date(Date.now() - 10_000) }),
      );

      expect(await statusOf(service.resend(dto))).toBe(429);
      expect(mail.sendOtp).not.toHaveBeenCalled();
    });

    it("throws 400 for an unknown email", async () => {
      manager.findOneBy.mockResolvedValue(null);

      expect(await statusOf(service.resend(dto))).toBe(400);
    });

    it("throws 400 for an already active user", async () => {
      manager.findOneBy.mockResolvedValue({ ...pendingUser, status: "active" });

      expect(await statusOf(service.resend(dto))).toBe(400);
    });

    it("throws 503 and restores lastSentAt when email is not sent", async () => {
      const previous = new Date(Date.now() - 120_000);
      manager.findOneBy.mockResolvedValue(pendingUser);
      manager.findOne.mockResolvedValue(makeAttempt({ lastSentAt: previous }));
      mail.sendOtp.mockRejectedValue(new Error("ECONNREFUSED"));

      expect(await statusOf(service.resend(dto))).toBe(503);
      expect(confirmationRepository.update).toHaveBeenCalledWith("attempt-1", {
        lastSentAt: previous,
      });
    });
  });
});
