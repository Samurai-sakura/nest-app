import { Logger } from "@nestjs/common";

jest.mock("@nestjs/typeorm", () => ({ InjectDataSource: () => () => undefined }));
jest.mock("@nestjs/schedule", () => ({ Interval: () => () => undefined }));

import {
  CLEANUP_MAX_ATTEMPTS,
  CLEANUP_RETRY_DELAY_MS,
  ORPHAN_MIN_AGE_MS,
  StorageCleanupWorker,
} from "./storage-cleanup.worker";
import { StorageCleanupJob } from "./entities/storage-cleanup-job.entity";

describe("StorageCleanupWorker", () => {
  let now: number;
  let jobs: Partial<StorageCleanupJob>[];
  let query: Record<string, jest.Mock>;
  let manager: { createQueryBuilder: jest.Mock; update: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let photoStorage: { delete: jest.Mock; list: jest.Mock };
  let worker: StorageCleanupWorker;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeAll(() => {
    log = jest.spyOn(Logger.prototype, "log").mockImplementation();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    now = Date.parse("2026-01-01T00:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    jobs = [];
    query = {};
    for (const method of ["where", "orderBy", "limit", "setLock", "setOnLocked"]) {
      query[method] = jest.fn(() => query);
    }
    query.getOne = jest.fn(async () => jobs.shift() ?? null);
    manager = {
      createQueryBuilder: jest.fn(() => query),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      transaction: jest.fn((work) => work(manager)),
      query: jest.fn().mockResolvedValue([]),
    };
    photoStorage = {
      delete: jest.fn().mockResolvedValue({ status: "deleted" }),
      list: jest.fn().mockResolvedValue({ status: "listed", keys: [] }),
    };
    worker = new StorageCleanupWorker(dataSource as any, photoStorage as any);
    log.mockClear();
    warn.mockClear();
    error.mockClear();
  });

  afterEach(() => (Date.now as jest.Mock).mockRestore());

  const job = (overrides: Partial<StorageCleanupJob> = {}) => ({
    id: "job-1",
    objectKey: "secret-object-key",
    reason: "photo_replaced" as const,
    status: "queued" as const,
    attempts: 0,
    ...overrides,
  });
  const logText = () =>
    [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");

  describe("processNext", () => {
    it("returns false when no job is due", async () => {
      await expect(worker.processNext()).resolves.toBe(false);

      expect(photoStorage.delete).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it("takes the oldest due queued job and skips jobs locked by another worker", async () => {
      jobs.push(job());

      await worker.processNext();

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(StorageCleanupJob, "job");
      expect(query.where).toHaveBeenCalledWith(
        "job.status = 'queued' AND job.next_attempt_at <= now()",
      );
      expect(query.orderBy).toHaveBeenCalledWith("job.next_attempt_at");
      expect(query.limit).toHaveBeenCalledWith(1);
      expect(query.setLock).toHaveBeenCalledWith("pessimistic_write");
      expect(query.setOnLocked).toHaveBeenCalledWith("skip_locked");
    });

    it.each(["deleted", "not_found"])("marks the job done when storage answers %s", async (status) => {
      jobs.push(job({ attempts: 2 }));
      photoStorage.delete.mockResolvedValue({ status });

      await expect(worker.processNext()).resolves.toBe(true);

      expect(photoStorage.delete).toHaveBeenCalledWith("secret-object-key");
      expect(manager.update).toHaveBeenCalledWith(StorageCleanupJob, "job-1", {
        status: "done",
        attempts: 3,
      });
      expect(log).toHaveBeenCalledWith(
        `Storage cleanup done jobId=job-1 reason=photo_replaced result=${status}`,
      );
    });

    it("schedules a retry in one minute when storage is unavailable", async () => {
      jobs.push(job({ attempts: 1 }));
      photoStorage.delete.mockResolvedValue({ status: "unavailable" });

      await expect(worker.processNext()).resolves.toBe(true);

      expect(manager.update).toHaveBeenCalledWith(StorageCleanupJob, "job-1", {
        attempts: 2,
        nextAttemptAt: new Date(now + CLEANUP_RETRY_DELAY_MS),
      });
      expect(warn).toHaveBeenCalledWith("Storage cleanup retry scheduled jobId=job-1 attempts=2");
    });

    it(`fails the job after ${CLEANUP_MAX_ATTEMPTS} unsuccessful attempts`, async () => {
      jobs.push(job({ attempts: CLEANUP_MAX_ATTEMPTS - 1 }));
      photoStorage.delete.mockResolvedValue({ status: "unavailable" });

      await worker.processNext();

      expect(manager.update).toHaveBeenCalledWith(StorageCleanupJob, "job-1", {
        attempts: CLEANUP_MAX_ATTEMPTS,
        status: "failed",
      });
      expect(warn).toHaveBeenCalledWith(
        `Storage cleanup failed jobId=job-1 attempts=${CLEANUP_MAX_ATTEMPTS}`,
      );
    });

    it("never logs the object key", async () => {
      jobs.push(job(), job({ id: "job-2" }));
      photoStorage.delete
        .mockResolvedValueOnce({ status: "deleted" })
        .mockResolvedValueOnce({ status: "unavailable" });

      await worker.processNext();
      await worker.processNext();

      expect(logText()).toContain("jobId=job-1");
      expect(logText()).toContain("jobId=job-2");
      expect(logText()).not.toContain("secret-object-key");
    });
  });

  describe("tick", () => {
    it("processes due jobs until the queue is empty", async () => {
      jobs.push(job(), job({ id: "job-2" }), job({ id: "job-3" }));

      await worker.tick();

      expect(photoStorage.delete).toHaveBeenCalledTimes(3);
      expect(dataSource.transaction).toHaveBeenCalledTimes(4);
    });

    it("processes at most 20 jobs per tick", async () => {
      for (let i = 0; i < 25; i++) {
        jobs.push(job({ id: `job-${i}` }));
      }

      await worker.tick();

      expect(photoStorage.delete).toHaveBeenCalledTimes(20);
      expect(jobs).toHaveLength(5);
    });

    it("does not start a tick while the previous one is running", async () => {
      let release!: () => void;
      photoStorage.delete.mockReturnValueOnce(
        new Promise((resolve) => {
          release = () => resolve({ status: "deleted" });
        }),
      );
      jobs.push(job());

      const first = worker.tick();
      await worker.tick();
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);

      release();
      await first;
      expect(photoStorage.delete).toHaveBeenCalledTimes(1);
    });

    it("logs a failed tick and runs the next one", async () => {
      dataSource.transaction.mockRejectedValueOnce(new Error("connection terminated"));

      await expect(worker.tick()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith("Storage cleanup tick failed: connection terminated");

      jobs.push(job());
      await worker.tick();
      expect(photoStorage.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("reconcile", () => {
    it("lists only objects older than an hour", async () => {
      await worker.reconcile();

      expect(photoStorage.list).toHaveBeenCalledWith(new Date(now - ORPHAN_MIN_AGE_MS));
      expect(ORPHAN_MIN_AGE_MS).toBe(60 * 60_000);
    });

    it("deletes objects without a profile link or a queued job", async () => {
      photoStorage.list.mockResolvedValue({
        status: "listed",
        keys: ["orphan-1", "profile-key", "queued-key", "orphan-2"],
      });
      dataSource.query.mockResolvedValue([{ key: "profile-key" }, { key: "queued-key" }]);

      await worker.reconcile();

      expect(dataSource.query).toHaveBeenCalledWith(expect.stringContaining("users"), [
        ["orphan-1", "profile-key", "queued-key", "orphan-2"],
      ]);
      expect(dataSource.query.mock.calls[0][0]).toContain("status = 'queued'");
      expect(photoStorage.delete.mock.calls).toEqual([["orphan-1"], ["orphan-2"]]);
      expect(log).toHaveBeenCalledWith("Storage reconcile completed checked=4 deleted=2 failed=0");
    });

    it("checks references in chunks of 500 keys", async () => {
      const keys = Array.from({ length: 1200 }, (_, i) => `key-${i}`);
      photoStorage.list.mockResolvedValue({ status: "listed", keys });
      dataSource.query.mockImplementation(async (_sql, [chunk]: [string[]]) =>
        chunk.map((key) => ({ key })),
      );

      await worker.reconcile();

      expect(dataSource.query.mock.calls.map(([, [chunk]]) => chunk.length)).toEqual([500, 500, 200]);
      expect(photoStorage.delete).not.toHaveBeenCalled();
    });

    it("counts objects storage could not delete and never logs keys", async () => {
      photoStorage.list.mockResolvedValue({ status: "listed", keys: ["orphan-1", "orphan-2"] });
      photoStorage.delete
        .mockResolvedValueOnce({ status: "unavailable" })
        .mockResolvedValueOnce({ status: "not_found" });

      await worker.reconcile();

      expect(log).toHaveBeenCalledWith("Storage reconcile completed checked=2 deleted=1 failed=1");
      expect(logText()).not.toContain("orphan");
    });

    it("skips the run when storage cannot list objects", async () => {
      photoStorage.list.mockResolvedValue({ status: "unavailable" });

      await worker.reconcile();

      expect(dataSource.query).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("Storage reconcile skipped reason=storage_unavailable");
    });

    it("deletes nothing and logs the error when the database is unavailable", async () => {
      photoStorage.list.mockResolvedValue({ status: "listed", keys: ["orphan-1"] });
      dataSource.query.mockRejectedValue(new Error("connection terminated"));

      await expect(worker.reconcile()).resolves.toBeUndefined();

      expect(photoStorage.delete).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("Storage reconcile failed: connection terminated");
    });

    it("does not start while the previous run is in progress", async () => {
      let release!: () => void;
      photoStorage.list.mockReturnValueOnce(
        new Promise((resolve) => {
          release = () => resolve({ status: "listed", keys: [] });
        }),
      );

      const first = worker.reconcile();
      await worker.reconcile();
      release();
      await first;

      expect(photoStorage.list).toHaveBeenCalledTimes(1);
    });
  });
});
