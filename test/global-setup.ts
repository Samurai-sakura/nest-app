import { Client } from "pg";
import { TEST_DB } from "./setup-env";
import dataSource from "../src/data-source";

export default async function globalSetup() {
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  await admin.end();

  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.undoLastMigration();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
