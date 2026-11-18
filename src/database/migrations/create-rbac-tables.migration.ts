import { MigrationInterface, QueryRunner } from "typeorm";

const NAME_CHECK = `~ '^[a-z][a-z0-9._-]{0,63}$'`;

const VERSIONED_TABLES = [
  "roles",
  "permissions",
  "permission_actions",
  "grants",
  "grant_actions",
  "user_roles",
];

export class CreateRbacTablesMigration implements MigrationInterface {
  name = "CreateRbacTablesMigration1794515400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(64) NOT NULL,
        "description" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_roles" PRIMARY KEY ("id"),
        CONSTRAINT "uq_roles_name" UNIQUE ("name"),
        CONSTRAINT "chk_roles_name" CHECK ("name" ${NAME_CHECK})
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(64) NOT NULL,
        "description" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_permissions_name" UNIQUE ("name"),
        CONSTRAINT "chk_permissions_name" CHECK ("name" ${NAME_CHECK})
      )
    `);

    // действие удаляется вместе с разрешением, но не пока входит в конкретное назначение
    await queryRunner.query(`
      CREATE TABLE "permission_actions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "permission_id" uuid NOT NULL,
        "name" character varying(64) NOT NULL,
        CONSTRAINT "pk_permission_actions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_permission_actions_permission_name" UNIQUE ("permission_id", "name"),
        CONSTRAINT "chk_permission_actions_name" CHECK ("name" ${NAME_CHECK}),
        CONSTRAINT "fk_permission_actions_permission" FOREIGN KEY ("permission_id")
          REFERENCES "permissions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    // роль и разрешение нельзя удалить, пока на них есть назначение
    await queryRunner.query(`
      CREATE TABLE "grants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        "all_actions" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_grants" PRIMARY KEY ("id"),
        CONSTRAINT "uq_grants_role_permission" UNIQUE ("role_id", "permission_id"),
        CONSTRAINT "fk_grants_role" FOREIGN KEY ("role_id")
          REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_grants_permission" FOREIGN KEY ("permission_id")
          REFERENCES "permissions" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_grants_permission" ON "grants" ("permission_id")`,
    );

    // связка без неключевых полей (BCNF): принадлежность действия разрешению назначения
    // проверяет сервис RBAC, а проверка доступа соединяет действие только с разрешением назначения
    await queryRunner.query(`
      CREATE TABLE "grant_actions" (
        "grant_id" uuid NOT NULL,
        "permission_action_id" uuid NOT NULL,
        CONSTRAINT "pk_grant_actions" PRIMARY KEY ("grant_id", "permission_action_id"),
        CONSTRAINT "fk_grant_actions_grant" FOREIGN KEY ("grant_id")
          REFERENCES "grants" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "fk_grant_actions_action" FOREIGN KEY ("permission_action_id")
          REFERENCES "permission_actions" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_grant_actions_action" ON "grant_actions" ("permission_action_id")`,
    );

    // роль нельзя удалить, пока она назначена пользователю
    await queryRunner.query(`
      CREATE TABLE "user_roles" (
        "user_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        CONSTRAINT "pk_user_roles" PRIMARY KEY ("user_id", "role_id"),
        CONSTRAINT "fk_user_roles_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "fk_user_roles_role" FOREIGN KEY ("role_id")
          REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_user_roles_role" ON "user_roles" ("role_id")`,
    );

    // одна строка: CHECK не даёт вставить вторую
    await queryRunner.query(`
      CREATE TABLE "rbac_policy_state" (
        "id" smallint NOT NULL,
        "version" integer NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_rbac_policy_state" PRIMARY KEY ("id"),
        CONSTRAINT "chk_rbac_policy_state_single_row" CHECK ("id" = 1),
        CONSTRAINT "chk_rbac_policy_state_version" CHECK ("version" >= 0)
      )
    `);
    await queryRunner.query(
      `INSERT INTO "rbac_policy_state" ("id", "version") VALUES (1, 0)`,
    );

    // версия растёт в той же транзакции, что и изменение RBAC, даже при ручном SQL.
    // Один раз на запрос, а не на строку; UPDATE блокирует строку и выстраивает изменения в очередь
    await queryRunner.query(`
      CREATE FUNCTION "bump_rbac_policy_version"() RETURNS trigger AS $$
      BEGIN
        UPDATE "rbac_policy_state"
        SET "version" = "version" + 1, "updated_at" = now()
        WHERE "id" = 1;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of VERSIONED_TABLES) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_bump_policy_version"
        AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${table}"
        FOR EACH STATEMENT EXECUTE FUNCTION "bump_rbac_policy_version"()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "rbac_policy_state"`);
    await queryRunner.query(`DROP TABLE "user_roles"`);
    await queryRunner.query(`DROP TABLE "grant_actions"`);
    await queryRunner.query(`DROP TABLE "grants"`);
    await queryRunner.query(`DROP TABLE "permission_actions"`);
    await queryRunner.query(`DROP TABLE "permissions"`);
    await queryRunner.query(`DROP TABLE "roles"`);
    // триггеры удалены вместе с таблицами, функция больше ни от чего не зависит
    await queryRunner.query(`DROP FUNCTION "bump_rbac_policy_version"()`);
  }
}
