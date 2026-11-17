import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAuthTablesMigration implements MigrationInterface {
  name = "CreateAuthTablesMigration1793664000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying(255) NOT NULL,
        "name" character varying(250),
        "status" character varying(20) NOT NULL,
        "password_hash" character varying(250) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"),
        CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "registration_confirmations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "method" character varying(20) NOT NULL,
        "secret_hash" character varying(64) NOT NULL,
        "failed_attempts" integer NOT NULL DEFAULT 0,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "last_sent_at" TIMESTAMP WITH TIME ZONE,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_26715d962956a267adf0fa90315" PRIMARY KEY ("id"),
        CONSTRAINT "FK_54563ea8488ebf078b3ec409a57" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_confirmation_secret_hash" ON "registration_confirmations" ("secret_hash")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_confirmation_active_user" ON "registration_confirmations" ("user_id") WHERE "consumed_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "registration_confirmations"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
