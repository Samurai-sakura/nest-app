import { HttpException, Logger } from "@nestjs/common";
import { IsNull, QueryFailedError } from "typeorm";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));

import { UsersService } from "./users.service";
import { User } from "../entities/user.entity";
import { LoginChallenge } from "../../identity/authentication/entities/login-challenge.entity";
import { EmailChangeChallenge } from "../entities/email-change-challenge.entity";

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("UsersService", () => {
  let userRepository: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let service: UsersService;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeAll(() => {
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    log = jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    userRepository = { findOne: jest.fn() };
    dataSource = { transaction: jest.fn() };
    service = new UsersService(
      userRepository as any,
      { read: jest.fn() } as any,
      { getOrThrow: () => "http://localhost:3200" } as any,
      dataSource as any,
    );
    error.mockClear();
    log.mockClear();
  });

  const connectionRefused = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

  it.each([
    ["profile", (s: UsersService) => s.findProfile("user-1")],
    ["photo", (s: UsersService) => s.findPhoto("user-1")],
  ])("answers 503 when the database is unavailable for the %s", async (_case, call) => {
    userRepository.findOne.mockRejectedValue(connectionRefused());

    const failure = (await errorOf(call(service))) as HttpException;

    expect(failure.getStatus()).toBe(503);
    expect(failure.getResponse()).toEqual({
      statusCode: 503,
      code: "users_unavailable",
      message: "User data is temporarily unavailable",
    });
    expect(error).toHaveBeenCalledWith("User data unavailable reason=database userId=user-1");
  });

  it("keeps an unexpected error as it is", async () => {
    const bug = new TypeError("unexpected");
    userRepository.findOne.mockRejectedValue(bug);

    expect(await errorOf(service.findProfile("user-1"))).toBe(bug);
  });

  describe("updateUserProfile", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const updatedAt = new Date("2026-01-02T00:00:00Z");
    let manager: { findOne: jest.Mock; update: jest.Mock; query: jest.Mock };
    let managerExists: boolean;

    const storedUser = (overrides: Partial<User> = {}) =>
      ({
        id: "user-1",
        email: "alice@gmail.com",
        displayName: "Alice",
        photoKey: null,
        status: "active",
        passwordHash: "hash",
        createdAt,
        updatedAt,
        ...overrides,
      }) as User;

    const updatesOf = (entity: unknown) =>
      manager.update.mock.calls.filter(([target]) => target === entity);

    beforeEach(() => {
      managerExists = true;
      manager = {
        findOne: jest.fn().mockResolvedValue(storedUser()),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        query: jest.fn(async (sql: string) =>
          sql.includes("EXISTS") ? [{ exists: managerExists }] : [],
        ),
      };
      dataSource.transaction.mockImplementation((work) => work(manager));
    });

    it("rejects an empty update before the database", async () => {
      const failure = (await errorOf(service.updateUserProfile("user-1", {}))) as HttpException;

      expect(failure.getStatus()).toBe(400);
      expect(failure.getResponse()).toMatchObject({ code: "empty_update" });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("updates only the sent field and returns the safe profile", async () => {
      const profile = await service.updateUserProfile("user-1", { displayName: "Alicia" });

      expect(updatesOf(User)).toEqual([
        [User, { id: "user-1" }, { displayName: "Alicia", updatedAt: expect.any(Date) }],
      ]);
      expect(profile).toEqual({
        id: "user-1",
        email: "alice@gmail.com",
        displayName: "Alicia",
        photoUrl: null,
        status: "active",
        createdAt,
        updatedAt: expect.any(Date),
      });
      expect(profile.updatedAt).not.toEqual(updatedAt);
      expect(profile).not.toHaveProperty("passwordHash");
    });

    it("locks the user row for update", async () => {
      await service.updateUserProfile("user-1", { displayName: "Alicia" });

      expect(manager.findOne).toHaveBeenCalledWith(User, {
        where: { id: "user-1" },
        lock: { mode: "pessimistic_write" },
      });
    });

    it("treats unchanged values as a no-op without touching updatedAt", async () => {
      const profile = await service.updateUserProfile("user-1", {
        displayName: "Alice",
        email: "alice@gmail.com",
        status: "active",
      });

      expect(manager.update).not.toHaveBeenCalled();
      expect(profile.updatedAt).toBe(updatedAt);
    });

    it("clears displayName with null", async () => {
      const profile = await service.updateUserProfile("user-1", { displayName: null });

      expect(updatesOf(User)[0][2]).toMatchObject({ displayName: null });
      expect(profile.displayName).toBeNull();
    });

    it("answers 404 for a missing user", async () => {
      manager.findOne.mockResolvedValue(null);

      const failure = (await errorOf(
        service.updateUserProfile("user-1", { displayName: "A" }),
      )) as HttpException;

      expect(failure.getStatus()).toBe(404);
      expect(failure.getResponse()).toMatchObject({ code: "user_not_found" });
    });

    it.each(["pending", "deleting", "deleted"] as const)(
      "answers 409 for a %s user without changes",
      async (status) => {
        manager.findOne.mockResolvedValue(storedUser({ status }));

        const failure = (await errorOf(
          service.updateUserProfile("user-1", { displayName: "A" }),
        )) as HttpException;

        expect(failure.getStatus()).toBe(409);
        expect(failure.getResponse()).toMatchObject({ code: "user_state_conflict" });
        expect(manager.update).not.toHaveBeenCalled();
      },
    );

    it("lets a blocked user be edited and unblocked", async () => {
      manager.findOne.mockResolvedValue(storedUser({ status: "blocked" }));

      const profile = await service.updateUserProfile("user-1", { status: "active" });

      expect(profile.status).toBe("active");
      expect(updatesOf(LoginChallenge)).toEqual([]);
    });

    it("consumes the email challenge as admin_override on a direct email change", async () => {
      await service.updateUserProfile("user-1", { email: "new@gmail.com" });

      expect(updatesOf(EmailChangeChallenge)).toEqual([
        [
          EmailChangeChallenge,
          { userId: "user-1", consumedAt: IsNull() },
          { consumedAt: expect.any(Date), consumedReason: "admin_override" },
        ],
      ]);
      expect(updatesOf(LoginChallenge)).toEqual([]);
    });

    it("locks the policy and consumes challenges as user_inactive when blocking", async () => {
      const profile = await service.updateUserProfile("user-1", { status: "blocked" });

      expect(manager.query.mock.calls[0][0]).toContain("FOR UPDATE");
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        manager.findOne.mock.invocationCallOrder[0],
      );
      for (const entity of [LoginChallenge, EmailChangeChallenge]) {
        expect(updatesOf(entity)).toEqual([
          [
            entity,
            { userId: "user-1", consumedAt: IsNull() },
            { consumedAt: expect.any(Date), consumedReason: "user_inactive" },
          ],
        ]);
      }
      expect(profile.status).toBe("blocked");
    });

    it.each([
      ["active", "blocked"],
      ["blocked", "active"],
    ] as const)("logs the committed transition %s -> %s", async (from, to) => {
      manager.findOne.mockResolvedValue(storedUser({ status: from }));

      await service.updateUserProfile("user-1", { status: to });

      expect(log).toHaveBeenCalledWith(
        `User status changed transition=${from}->${to} userId=user-1`,
      );
    });

    it("does not log a transition for an unchanged status or a rolled back block", async () => {
      await service.updateUserProfile("user-1", { status: "active" });
      managerExists = false;
      await errorOf(service.updateUserProfile("user-1", { status: "blocked" }));

      expect(log).not.toHaveBeenCalled();
    });

    it("does not lock the policy for other changes", async () => {
      await service.updateUserProfile("user-1", { displayName: "Alicia", status: "active" });

      expect(manager.query).not.toHaveBeenCalled();
    });

    it("refuses to block the last active rbac manager", async () => {
      managerExists = false;

      const failure = (await errorOf(
        service.updateUserProfile("user-1", { status: "blocked" }),
      )) as HttpException;

      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toMatchObject({ code: "last_rbac_manager" });
      expect(updatesOf(LoginChallenge)).toEqual([]);
    });

    it("answers 409 email_taken on the users.email unique violation", async () => {
      manager.update.mockRejectedValueOnce(
        new QueryFailedError(
          "UPDATE",
          [],
          Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "UQ_97672ac88f789774dd47f7c8be3",
          }),
        ),
      );

      const failure = (await errorOf(
        service.updateUserProfile("user-1", { email: "taken@gmail.com" }),
      )) as HttpException;

      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toEqual({
        statusCode: 409,
        code: "email_taken",
        message: "Email is already in use",
      });
    });

    it("keeps other unique violations as they are", async () => {
      const violation = new QueryFailedError(
        "UPDATE",
        [],
        Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "uq_users_photo_key",
        }),
      );
      manager.update.mockRejectedValueOnce(violation);

      expect(await errorOf(service.updateUserProfile("user-1", { displayName: "A" }))).toBe(
        violation,
      );
    });

    it("answers 503 when the database is unavailable", async () => {
      dataSource.transaction.mockRejectedValue(connectionRefused());

      const failure = (await errorOf(
        service.updateUserProfile("user-1", { displayName: "A" }),
      )) as HttpException;

      expect(failure.getStatus()).toBe(503);
      expect(failure.getResponse()).toMatchObject({ code: "users_unavailable" });
      expect(error).toHaveBeenCalledWith("User data unavailable reason=database userId=user-1");
    });
  });
});
