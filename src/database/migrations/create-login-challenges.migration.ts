import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateLoginChallengesMigration implements MigrationInterface {
  name = "CreateLoginChallengesMigration1794096000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "login_challenges" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "method" character varying(20) NOT NULL,
        "secret_hash" character varying(64) NOT NULL,
        "last_sent_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "consumed_reason" character varying(20),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_85b9467d340eb112cb0fa7a0cde" PRIMARY KEY ("id"),
        CONSTRAINT "FK_23bb9553efaa83910672d214f65" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_login_challenge_active_user" ON "login_challenges" ("user_id") WHERE "consumed_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "login_challenges"`);
  }
}
