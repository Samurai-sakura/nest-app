import { HttpException, Logger } from "@nestjs/common";

jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));

import { RbacPolicyService } from "./rbac-policy.service";

const unavailable = {
  status: 503,
  body: {
    statusCode: 503,
    code: "authorization_unavailable",
    message: "Authorization is temporarily unavailable",
  },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("RbacPolicyService", () => {
  let manager: { findOneOrFail: jest.Mock; query: jest.Mock };
  let policyRepository: {
    findOne: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let service: RbacPolicyService;
  let error: jest.SpyInstance;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  beforeEach(() => {
    manager = {
      findOneOrFail: jest.fn().mockResolvedValue({ id: 1, version: 1 }),
      query: jest.fn().mockResolvedValue([
        { user_id: "user-1", permission: "reports", action: "read" },
        { user_id: "user-1", permission: "users", action: "read" },
        { user_id: "user-2", permission: "reports", action: "delete" },
      ]),
    };
    policyRepository = {
      findOne: jest.fn().mockResolvedValue({ version: 1 }),
      manager: {
        transaction: jest.fn((_level: string, work: (m: unknown) => unknown) =>
          work(manager),
        ),
      },
    };
    service = new RbacPolicyService(policyRepository as any);
    error.mockClear();
  });

  const loads = () => policyRepository.manager.transaction.mock.calls.length;

  it("allows a pair from any role of the user", async () => {
    await expect(service.authorize("user-1", "reports", "read")).resolves.toEqual({
      allowed: true,
      version: 1,
    });
    await expect(service.authorize("user-1", "users", "read")).resolves.toEqual({
      allowed: true,
      version: 1,
    });
    expect(policyRepository.manager.transaction).toHaveBeenCalledWith(
      "REPEATABLE READ",
      expect.any(Function),
    );
  });

  it.each([
    ["another action", "user-1", "reports", "delete"],
    ["another user's right", "user-2", "reports", "read"],
    ["an unknown permission", "user-1", "billing", "read"],
    ["a user without roles", "user-3", "reports", "read"],
  ])("denies %s", async (_case, userId, permission, action) => {
    await expect(service.authorize(userId, permission, action)).resolves.toEqual({
      allowed: false,
      version: 1,
    });
  });

  it("reuses the snapshot while the version is unchanged", async () => {
    await service.authorize("user-1", "reports", "read");
    await service.authorize("user-2", "reports", "delete");

    expect(loads()).toBe(1);
    expect(policyRepository.findOne).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the snapshot when the version grows", async () => {
    await service.authorize("user-1", "reports", "read");

    policyRepository.findOne.mockResolvedValue({ version: 2 });
    manager.findOneOrFail.mockResolvedValue({ id: 1, version: 2 });
    manager.query.mockResolvedValue([]);

    await expect(service.authorize("user-1", "reports", "read")).resolves.toEqual({
      allowed: false,
      version: 2,
    });
    expect(loads()).toBe(2);
  });

  it("returns 503 when the version cannot be read", async () => {
    policyRepository.findOne.mockRejectedValue(new Error("connection lost"));

    expect(await errorOf(service.authorize("user-1", "reports", "read"))).toEqual(
      unavailable,
    );
    expect(error).toHaveBeenCalledWith(
      "Authorization unavailable reason=rbac_version: connection lost",
    );
  });

  it("returns 503 when the state row is missing", async () => {
    policyRepository.findOne.mockResolvedValue(null);

    expect(await errorOf(service.authorize("user-1", "reports", "read"))).toEqual(
      unavailable,
    );
    expect(error).toHaveBeenCalledWith(
      "Authorization unavailable reason=rbac_version: state row is missing",
    );
  });

  it("drops the old snapshot when a rebuild fails", async () => {
    await service.authorize("user-1", "reports", "read");

    policyRepository.findOne.mockResolvedValue({ version: 2 });
    manager.query.mockRejectedValue(new Error("timeout"));

    expect(await errorOf(service.authorize("user-1", "reports", "read"))).toEqual(
      unavailable,
    );
    expect(error).toHaveBeenCalledWith(
      "Authorization unavailable reason=rbac_snapshot: timeout",
    );
    expect(service.ready).toBe(false);

    policyRepository.findOne.mockResolvedValue({ version: 1 });
    expect(await errorOf(service.authorize("user-1", "reports", "read"))).toEqual(
      unavailable,
    );
    expect(loads()).toBe(3);
  });

  it("shares one load between concurrent checks", async () => {
    const rows = deferred<unknown[]>();
    manager.query.mockReturnValue(rows.promise);

    const checks = [
      service.authorize("user-1", "reports", "read"),
      service.authorize("user-2", "reports", "delete"),
      service.authorize("user-3", "reports", "read"),
    ];
    await new Promise(setImmediate);
    rows.resolve([{ user_id: "user-1", permission: "reports", action: "read" }]);

    expect((await Promise.all(checks)).map((d) => d.allowed)).toEqual([true, false, false]);
    expect(loads()).toBe(1);
  });

  it("loads again when the joined load is older than the version it read", async () => {
    const firstRows = deferred<unknown[]>();
    manager.query.mockReturnValueOnce(firstRows.promise);
    manager.findOneOrFail
      .mockResolvedValueOnce({ id: 1, version: 1 })
      .mockResolvedValueOnce({ id: 1, version: 2 });

    const first = service.authorize("user-1", "reports", "read");
    await new Promise(setImmediate);

    policyRepository.findOne.mockResolvedValue({ version: 2 });
    const second = service.authorize("user-1", "reports", "read");
    await new Promise(setImmediate);
    firstRows.resolve([]);

    await expect(first).resolves.toEqual({ allowed: false, version: 1 });
    await expect(second).resolves.toEqual({ allowed: true, version: 2 });
    expect(loads()).toBe(2);
  });

  describe("startup", () => {
    it("is ready after the initial snapshot is loaded", async () => {
      expect(service.ready).toBe(false);

      await service.onApplicationBootstrap();

      expect(service.ready).toBe(true);
    });

    it("loads the missing snapshot when readiness is checked", async () => {
      manager.query.mockRejectedValueOnce(new Error("timeout"));
      await service.onApplicationBootstrap();
      expect(service.ready).toBe(false);

      await expect(service.checkReady()).resolves.toBe(true);
      expect(service.ready).toBe(true);

      await service.checkReady();
      expect(loads()).toBe(2);
    });

    it("stays not ready when the readiness load fails", async () => {
      manager.query.mockRejectedValue(new Error("timeout"));

      await expect(service.checkReady()).resolves.toBe(false);
    });

    it("starts without the snapshot when loading fails", async () => {
      manager.query.mockRejectedValue(new Error("relation does not exist"));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(service.ready).toBe(false);
      expect(error).toHaveBeenCalledWith(
        "Authorization unavailable reason=rbac_snapshot: relation does not exist",
      );
    });
  });
});
