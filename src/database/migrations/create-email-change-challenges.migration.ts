import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEmailChangeChallengesMigration implements MigrationInterface {
  name = "CreateEmailChangeChallengesMigration1795305600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_change_challenges" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "new_email" character varying(255) NOT NULL,
        "method" character varying(20) NOT NULL,
        "secret_hash" character varying(64) NOT NULL,
        "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "consumed_reason" character varying(20),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_email_change_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "fk_email_change_challenges_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "chk_email_change_challenges_method"
          CHECK ("method" IN ('otp', 'magic_link')),
        CONSTRAINT "chk_email_change_challenges_reason" CHECK (
          "consumed_reason" IN (
            'confirmed', 'replaced', 'attempts_exhausted',
            'user_inactive', 'admin_override', 'email_conflict'
          )
        ),
        CONSTRAINT "chk_email_change_challenges_consumed"
          CHECK (("consumed_at" IS NULL) = ("consumed_reason" IS NULL))
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_email_change_challenge_active_user" ON "email_change_challenges" ("user_id") WHERE "consumed_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_change_challenges"`);
  }
}
