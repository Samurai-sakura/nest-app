import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp } from "./helpers/create-test-app";

describe("Health (e2e)", () => {
  let app: INestApplication;
  let db: DataSource;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const http = () => request(app.getHttpServer());

  it("answers liveness without a session, even with a broken cookie", async () => {
    await http()
      .get("/health/live")
      .set("Cookie", "access_token=garbage")
      .expect(200, { status: "ok" });
  });

  it("is ready when the database, RBAC and routes are fine", async () => {
    await http().get("/health/ready").expect(200, { status: "ready" });
  });

  it("is not ready while the database is unreachable and gives no details", async () => {
    jest.spyOn(db, "query").mockRejectedValueOnce(new Error("connection refused"));

    const response = await http().get("/health/ready").expect(503);

    expect(response.body).toEqual({
      statusCode: 503,
      code: "not_ready",
      message: "Service is not ready",
    });
  });

  it("no longer serves the hello route", async () => {
    await http().get("/").expect(404);
  });
});
