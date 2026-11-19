import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserProfileColumnsMigration implements MigrationInterface {
  name = "AddUserProfileColumnsMigration1795046400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" RENAME COLUMN "name" TO "display_name"`);
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "display_name" TYPE character varying(80)
      USING NULLIF(left(btrim("display_name"), 80), '')
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "photo_key" character varying(255),
      ADD CONSTRAINT "uq_users_photo_key" UNIQUE ("photo_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "photo_key"`);
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "display_name" TYPE character varying(250)`,
    );
    await queryRunner.query(`ALTER TABLE "users" RENAME COLUMN "display_name" TO "name"`);
  }
}
