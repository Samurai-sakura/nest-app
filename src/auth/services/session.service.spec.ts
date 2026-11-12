import { HttpException, Logger } from "@nestjs/common";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));

import { SessionService } from "./session.service";
import type { TokenCheck } from "./token.service";
import type { UserStatus } from "../entities/user.entity";

const tokens = { accessToken: "new-access", refreshToken: "new-refresh" };

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error("expected promise to reject");
}

describe("SessionService", () => {
  let userRepository: { findOne: jest.Mock };
  let tokenService: { verify: jest.Mock; signPair: jest.Mock };
  let service: SessionService;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  beforeEach(() => {
    userRepository = { findOne: jest.fn() };
    tokenService = {
      verify: jest.fn((): TokenCheck => ({ valid: true, userId: "user-1" })),
      signPair: jest.fn(() => tokens),
    };
    service = new SessionService(userRepository as any, tokenService as any);
    warn.mockClear();
  });

  const withUser = (status: UserStatus = "active") =>
    userRepository.findOne.mockResolvedValue({ id: "user-1", status });

  const invalidSession = {
    status: 401,
    body: {
      statusCode: 401,
      code: "invalid_session",
      message: "Session is invalid or expired",
    },
  };

  it("issues a new pair for an active user", async () => {
    withUser();

    await expect(service.refresh("refresh-jwt")).resolves.toBe(tokens);
    expect(tokenService.verify).toHaveBeenCalledWith("refresh-jwt", "refresh");
    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { id: true, status: true },
    });
    expect(tokenService.signPair).toHaveBeenCalledWith("user-1");
  });

  it.each(["missing", "malformed", "signature", "expired", "claims", "token_use"] as const)(
    "returns invalid_session and logs the %s reason",
    async (reason) => {
      tokenService.verify.mockReturnValue({ valid: false, reason });

      expect(await errorOf(service.refresh("bad"))).toEqual(invalidSession);
      expect(userRepository.findOne).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(`Refresh failed reason=${reason}`);
    },
  );

  it.each(["pending", "blocked", "deleting", "deleted"] as const)(
    "returns the same 401 for a %s user",
    async (status) => {
      withUser(status);

      expect(await errorOf(service.refresh("refresh-jwt"))).toEqual(invalidSession);
      expect(tokenService.signPair).not.toHaveBeenCalled();
    },
  );

  it("returns the same 401 for a user that no longer exists", async () => {
    userRepository.findOne.mockResolvedValue(null);

    expect(await errorOf(service.refresh("refresh-jwt"))).toEqual(invalidSession);
    expect(warn).toHaveBeenCalledWith(
      "Refresh failed reason=user_inactive userId=user-1 status=missing",
    );
  });

  it("returns 503 instead of 401 when the database is unavailable", async () => {
    userRepository.findOne.mockRejectedValue(new Error("connection refused"));

    expect((await errorOf(service.refresh("refresh-jwt"))).status).toBe(503);
  });

  it("returns 503 when signing fails", async () => {
    withUser();
    tokenService.signPair.mockImplementation(() => {
      throw new Error("sign failed");
    });

    expect((await errorOf(service.refresh("refresh-jwt"))).status).toBe(503);
  });

  describe("authenticate", () => {
    it("returns the user id for a valid access token of an active user", async () => {
      withUser();

      await expect(service.authenticate("access-jwt")).resolves.toBe("user-1");
      expect(tokenService.verify).toHaveBeenCalledWith("access-jwt", "access");
      expect(tokenService.signPair).not.toHaveBeenCalled();
    });

    it.each(["missing", "malformed", "signature", "expired", "claims", "token_use"] as const)(
      "returns invalid_session and logs the %s reason",
      async (reason) => {
        tokenService.verify.mockReturnValue({ valid: false, reason });

        expect(await errorOf(service.authenticate("bad"))).toEqual(invalidSession);
        expect(userRepository.findOne).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(`Access rejected reason=${reason}`);
      },
    );

    it.each(["pending", "blocked", "deleting", "deleted"] as const)(
      "returns invalid_session for a %s user",
      async (status) => {
        withUser(status);

        expect(await errorOf(service.authenticate("access-jwt"))).toEqual(invalidSession);
        expect(warn).toHaveBeenCalledWith(
          `Access rejected reason=user_inactive userId=user-1 status=${status}`,
        );
      },
    );

    it("returns 503 instead of 401 when the database is unavailable", async () => {
      userRepository.findOne.mockRejectedValue(new Error("connection refused"));

      expect((await errorOf(service.authenticate("access-jwt"))).status).toBe(503);
    });
  });
});
