import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStorageCleanupJobsMigration implements MigrationInterface {
  name = "CreateStorageCleanupJobsMigration1795392000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "storage_cleanup_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "object_key" character varying(255) NOT NULL,
        "reason" character varying(20) NOT NULL,
        "status" character varying(10) NOT NULL DEFAULT 'queued',
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_storage_cleanup_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "chk_storage_cleanup_jobs_reason"
          CHECK ("reason" IN ('photo_replaced', 'photo_cleared')),
        CONSTRAINT "chk_storage_cleanup_jobs_status"
          CHECK ("status" IN ('queued', 'done', 'failed')),
        CONSTRAINT "chk_storage_cleanup_jobs_attempts"
          CHECK ("attempts" BETWEEN 0 AND 5)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "ix_storage_cleanup_jobs_due" ON "storage_cleanup_jobs" ("next_attempt_at") WHERE "status" = 'queued'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "storage_cleanup_jobs"`);
  }
}
