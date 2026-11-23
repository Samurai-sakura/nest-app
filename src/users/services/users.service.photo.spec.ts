import { HttpException, Logger } from "@nestjs/common";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
jest.mock("../helpers/photo-normalizer", () => ({ normalizePhoto: jest.fn() }));

import { UsersService } from "./users.service";
import { User } from "../entities/user.entity";
import { StorageCleanupJob } from "../../storage/entities/storage-cleanup-job.entity";
import { normalizePhoto } from "../helpers/photo-normalizer";

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error("expected promise to reject");
}

describe("UsersService photo", () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const updatedAt = new Date("2026-01-02T00:00:00Z");
  const normalized = Buffer.from("normalized-webp");
  const normalize = normalizePhoto as jest.Mock;
  let photoStorage: { read: jest.Mock; write: jest.Mock; delete: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: { findOne: jest.Mock; update: jest.Mock; insert: jest.Mock };
  let service: UsersService;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
    log = jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  const storedUser = (overrides: Partial<User> = {}) =>
    ({
      id: "user-1",
      email: "alice@gmail.com",
      displayName: "Alice",
      photoKey: "old-key",
      status: "active",
      passwordHash: "hash",
      createdAt,
      updatedAt,
      ...overrides,
    }) as User;

  beforeEach(() => {
    normalize.mockReset().mockResolvedValue({ status: "ok", data: normalized });
    photoStorage = {
      read: jest.fn(),
      write: jest.fn().mockResolvedValue({ status: "written" }),
      delete: jest.fn().mockResolvedValue({ status: "deleted" }),
    };
    manager = {
      findOne: jest.fn().mockResolvedValue(storedUser()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: "job-1" }] }),
    };
    dataSource = { transaction: jest.fn((work) => work(manager)) };
    service = new UsersService(
      { findOne: jest.fn() } as any,
      photoStorage as any,
      { getOrThrow: () => "http://localhost:3200" } as any,
      dataSource as any,
    );
    warn.mockClear();
    error.mockClear();
    log.mockClear();
  });

  const connectionRefused = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  const writtenKey = (): string => photoStorage.write.mock.calls[0][0];
  const logText = () =>
    [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");

  describe("replacePhoto", () => {
    const upload = () => service.replacePhoto("user-1", Buffer.from("original"), "image/png");

    it("writes the normalized photo under a new opaque key and switches the profile to it", async () => {
      const profile = await upload();

      expect(normalize).toHaveBeenCalledWith(Buffer.from("original"), "image/png");
      expect(photoStorage.write).toHaveBeenCalledWith(expect.any(String), normalized);
      expect(writtenKey()).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(writtenKey()).not.toContain("user-1");
      expect(manager.findOne).toHaveBeenCalledWith(User, {
        where: { id: "user-1" },
        lock: { mode: "pessimistic_write" },
      });
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: "user-1" },
        { photoKey: writtenKey(), updatedAt: expect.any(Date) },
      );
      expect(profile).toMatchObject({
        id: "user-1",
        photoUrl: "http://localhost:3200/users/user-1/photo",
      });
      expect(profile.updatedAt.getTime()).toBeGreaterThan(updatedAt.getTime());
      expect(JSON.stringify(profile)).not.toContain(writtenKey());
    });

    it("writes the object before the transaction", async () => {
      await upload();

      expect(photoStorage.write.mock.invocationCallOrder[0]).toBeLessThan(
        dataSource.transaction.mock.invocationCallOrder[0],
      );
    });

    it("queues the previous object for cleanup in the same transaction", async () => {
      await upload();

      expect(manager.insert).toHaveBeenCalledWith(StorageCleanupJob, {
        objectKey: "old-key",
        reason: "photo_replaced",
      });
      expect(photoStorage.delete).not.toHaveBeenCalled();
      expect(logText()).toContain("User photo replaced userId=user-1");
      expect(logText()).toContain("Storage cleanup queued jobId=job-1 reason=photo_replaced");
    });

    it("queues nothing for the first photo", async () => {
      manager.findOne.mockResolvedValue(storedUser({ photoKey: null }));

      await upload();

      expect(manager.insert).not.toHaveBeenCalled();
      expect(logText()).toContain("User photo uploaded userId=user-1");
      expect(logText()).not.toContain("Storage cleanup queued");
    });

    it("uses a different key for every upload", async () => {
      await upload();
      await upload();

      const [[first], [second]] = photoStorage.write.mock.calls;
      expect(first).not.toBe(second);
    });

    it.each([
      ["unsupported", { status: "unsupported" }, 415, "unsupported_media_type"],
      ["invalid", { status: "invalid", reason: "animated" }, 400, "invalid_photo"],
    ])("answers %s without touching storage or the database", async (_case, result, status, code) => {
      normalize.mockResolvedValue(result);

      const failure = await errorOf(upload());

      expect(failure.getStatus()).toBe(status);
      expect(failure.getResponse()).toMatchObject({ code });
      expect(photoStorage.write).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("answers 503 and keeps the profile when storage rejects the object", async () => {
      photoStorage.write.mockResolvedValue({ status: "unavailable" });

      const failure = await errorOf(upload());

      expect(failure.getStatus()).toBe(503);
      expect(failure.getResponse()).toMatchObject({ code: "photo_unavailable" });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it.each([
      ["a missing user", () => manager.findOne.mockResolvedValue(null), 404, "user_not_found"],
      ["a pending user", () => manager.findOne.mockResolvedValue(storedUser({ status: "pending" })), 409, "user_state_conflict"],
      ["a deleting user", () => manager.findOne.mockResolvedValue(storedUser({ status: "deleting" })), 409, "user_state_conflict"],
      ["a deleted user", () => manager.findOne.mockResolvedValue(storedUser({ status: "deleted" })), 409, "user_state_conflict"],
    ])("deletes the new object for %s", async (_case, arrange, status, code) => {
      arrange();

      const failure = await errorOf(upload());

      expect(failure.getStatus()).toBe(status);
      expect(failure.getResponse()).toMatchObject({ code });
      expect(manager.update).not.toHaveBeenCalled();
      expect(photoStorage.delete).toHaveBeenCalledWith(writtenKey());
    });

    it("accepts a photo for a blocked user", async () => {
      manager.findOne.mockResolvedValue(storedUser({ status: "blocked" }));

      await expect(upload()).resolves.toMatchObject({ status: "blocked" });
    });

    it("deletes the new object and answers 503 when the database is unavailable", async () => {
      dataSource.transaction.mockRejectedValue(connectionRefused());

      const failure = await errorOf(upload());

      expect(failure.getResponse()).toMatchObject({ statusCode: 503, code: "users_unavailable" });
      expect(photoStorage.delete).toHaveBeenCalledWith(writtenKey());
    });

    it("keeps an unexpected error after deleting the new object", async () => {
      const bug = new TypeError("unexpected");
      manager.update.mockRejectedValue(bug);

      expect(await errorOf(upload())).toBe(bug);
      expect(photoStorage.delete).toHaveBeenCalledWith(writtenKey());
    });

    it("never logs the object keys", async () => {
      await upload();

      expect(logText()).not.toContain(writtenKey());
      expect(logText()).not.toContain("old-key");
    });
  });

  describe("deletePhoto", () => {
    it("clears the link and queues the object for cleanup in one transaction", async () => {
      await service.deletePhoto("user-1");

      expect(manager.findOne).toHaveBeenCalledWith(User, {
        where: { id: "user-1" },
        select: { id: true, photoKey: true, status: true },
        lock: { mode: "pessimistic_write" },
      });
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: "user-1" },
        { photoKey: null, updatedAt: expect.any(Date) },
      );
      expect(manager.insert).toHaveBeenCalledWith(StorageCleanupJob, {
        objectKey: "old-key",
        reason: "photo_cleared",
      });
      expect(photoStorage.delete).not.toHaveBeenCalled();
      expect(logText()).toContain("User photo cleared userId=user-1");
      expect(logText()).toContain("Storage cleanup queued jobId=job-1 reason=photo_cleared");
      expect(logText()).not.toContain("old-key");
    });

    it("changes nothing when there is no photo", async () => {
      manager.findOne.mockResolvedValue(storedUser({ photoKey: null }));

      await service.deletePhoto("user-1");

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
      expect(logText()).not.toContain("Storage cleanup queued");
    });

    it.each([
      ["a missing user", null, 404, "user_not_found"],
      ["a pending user", "pending", 409, "user_state_conflict"],
      ["a deleting user", "deleting", 409, "user_state_conflict"],
      ["a deleted user", "deleted", 409, "user_state_conflict"],
    ] as const)("answers %s without changes", async (_case, userStatus, status, code) => {
      manager.findOne.mockResolvedValue(userStatus === null ? null : storedUser({ status: userStatus }));

      const failure = await errorOf(service.deletePhoto("user-1"));

      expect(failure.getStatus()).toBe(status);
      expect(failure.getResponse()).toMatchObject({ code });
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it("clears the photo of a blocked user", async () => {
      manager.findOne.mockResolvedValue(storedUser({ status: "blocked" }));

      await service.deletePhoto("user-1");

      expect(manager.insert).toHaveBeenCalledTimes(1);
    });

    it("answers 503 when the database is unavailable", async () => {
      dataSource.transaction.mockRejectedValue(connectionRefused());

      const failure = await errorOf(service.deletePhoto("user-1"));

      expect(failure.getResponse()).toMatchObject({ statusCode: 503, code: "users_unavailable" });
      expect(error).toHaveBeenCalledWith("User data unavailable reason=database userId=user-1");
    });

    it("keeps an unexpected error as it is", async () => {
      const bug = new TypeError("unexpected");
      manager.insert.mockRejectedValue(bug);

      expect(await errorOf(service.deletePhoto("user-1"))).toBe(bug);
    });
  });
});
