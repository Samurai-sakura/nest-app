import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PHOTO_STORAGE } from "./photo-storage";
import { Interval } from "@nestjs/schedule";
import { StorageCleanupJob } from "./entities/storage-cleanup-job.entity";
import type { PhotoStorage } from "./photo-storage";

export const CLEANUP_MAX_ATTEMPTS = 5;
export const CLEANUP_RETRY_DELAY_MS = 60_000;
const BATCH_SIZE = 20;
export const ORPHAN_MIN_AGE_MS = 60 * 60_000;
const RECONCILE_INTERVAL_MS = 10 * 60_000;
const RECONCILE_CHUNK = 500;

@Injectable()
export class StorageCleanupWorker {
  private readonly logger = new Logger(StorageCleanupWorker.name);
  private running = false;
  private reconciling = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PHOTO_STORAGE) private readonly photoStorage: PhotoStorage,
  ) {}

  @Interval("storage-cleanup", 15_000)
  public async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < BATCH_SIZE && (await this.processNext()); i++);
    } catch (error) {
      this.logger.error(
        `Storage cleanup tick failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  @Interval("storage-reconcile", RECONCILE_INTERVAL_MS)
  public async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const listed = await this.photoStorage.list(new Date(Date.now() - ORPHAN_MIN_AGE_MS));
      if (listed.status !== "listed") {
        this.logger.warn("Storage reconcile skipped reason=storage_unavailable");
        return;
      }

      let deleted = 0;
      let failed = 0;
      for (let i = 0; i < listed.keys.length; i += RECONCILE_CHUNK) {
        const chunk = listed.keys.slice(i, i + RECONCILE_CHUNK);
        const referenced = await this.referencedKeys(chunk);
        for (const key of chunk.filter((candidate) => !referenced.has(candidate))) {
          const result = await this.photoStorage.delete(key);
          if (result.status === "unavailable") {
            failed++;
          } else {
            deleted++;
          }
        }
      }
      this.logger.log(
        `Storage reconcile completed checked=${listed.keys.length} deleted=${deleted} failed=${failed}`,
      );
    } catch (error) {
      this.logger.error(`Storage reconcile failed: ${(error as Error).message}`);
    } finally {
      this.reconciling = false;
    }
  }

  public async processNext(): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const job = await manager
        .createQueryBuilder(StorageCleanupJob, "job")
        .where("job.status = 'queued' AND job.next_attempt_at <= now()")
        .orderBy("job.next_attempt_at")
        .limit(1)
        .setLock("pessimistic_write")
        .setOnLocked("skip_locked")
        .getOne();
      if (!job) return false;

      const result = await this.photoStorage.delete(job.objectKey);
      if (result.status !== "unavailable") {
        await manager.update(StorageCleanupJob, job.id, {
          status: "done",
          attempts: job.attempts + 1,
        });
        this.logger.log(
          `Storage cleanup done jobId=${job.id} reason=${job.reason} result=${result.status}`,
        );
        return true;
      }

      const attempts = job.attempts + 1;
      const failed = attempts >= CLEANUP_MAX_ATTEMPTS;
      await manager.update(StorageCleanupJob, job.id, {
        attempts,
        ...(failed
          ? { status: "failed" as const }
          : { nextAttemptAt: new Date(Date.now() + CLEANUP_RETRY_DELAY_MS) }),
      });
      this.logger.warn(
        `Storage cleanup ${failed ? "failed" : "retry scheduled"} jobId=${job.id} attempts=${attempts}`,
      );
      return true;
    });
  }

  private async referencedKeys(keys: string[]) {
    const rows: { key: string }[] = await this.dataSource.query(
      `SELECT photo_key AS key FROM users WHERE photo_key = ANY($1::text[])
       UNION
       SELECT object_key AS key FROM storage_cleanup_jobs
       WHERE status = 'queued' AND object_key = ANY($1::text[])`,
      [keys],
    );
    return new Set(rows.map((row) => row.key));
  }
}
