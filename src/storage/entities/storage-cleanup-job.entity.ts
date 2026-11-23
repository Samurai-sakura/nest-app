import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type StorageCleanupReason = "photo_replaced" | "photo_cleared";
export type StorageCleanupStatus = "queued" | "done" | "failed";

@Entity("storage_cleanup_jobs")
@Index("ix_storage_cleanup_jobs_due", ["nextAttemptAt"], {
  where: `"status" = 'queued'`,
})
export class StorageCleanupJob {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "object_key", type: "varchar", length: 255 })
  objectKey: string;

  @Column({ type: "varchar", length: 20 })
  reason: StorageCleanupReason;

  @Column({ type: "varchar", length: 10, default: "queued" })
  status: StorageCleanupStatus;

  @Column({ type: "int", default: 0 })
  attempts: number;

  @Column({ name: "next_attempt_at", type: "timestamptz", default: () => "now()" })
  nextAttemptAt: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
