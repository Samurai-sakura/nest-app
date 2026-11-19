import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { RbacBootstrapService } from "../src/access-control/rbac/services/rbac-bootstrap.service";
import { RbacPolicyService } from "../src/access-control/rbac/services/rbac-policy.service";
import { UserRolesService } from "../src/access-control/rbac/services/user-roles.service";
import { createTestApp } from "./helpers/create-test-app";
import { resetRbac } from "./helpers/rbac";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";

describe("Default role on activation (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  const mail = { sendOtp: jest.fn(), sendMagicLink: jest.fn() };
  let app: INestApplication;
  let db: DataSource;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp({ mail }));
  });

  afterAll(async () => {
    process.env.REGISTRATION_CONFIRM_ENABLED = "false";
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    await resetRbac(db);
    await app.get(RbacBootstrapService).bootstrap();
    mail.sendOtp.mockReset();
    logged.forEach((spy) => spy.mockClear());
    process.env.REGISTRATION_CONFIRM_ENABLED = "false";
    process.env.REGISTRATION_CONFIRM_METHOD = "otp";
  });

  const http = () => request(app.getHttpServer());

  const register = () => http().post("/auth/register").send({ email, password });

  const userId = async () =>
    (await db.query(`SELECT id FROM users WHERE email = $1`, [email]))[0].id as string;

  const rolesOf = async (id: string) =>
    (
      await db.query(
        `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [id],
      )
    ).map((row: { name: string }) => row.name);

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  it("gives an immediately active user the user role and its rights", async () => {
    await register().expect(201);
    const id = await userId();

    expect(await rolesOf(id)).toEqual(["user"]);
    const rbac = app.get(RbacPolicyService);
    expect((await rbac.authorize(id, "users", "read")).allowed).toBe(true);
    expect((await rbac.authorize(id, "users", "read_any")).allowed).toBe(false);
  });

  it("gives no role while pending and the user role after confirmation", async () => {
    process.env.REGISTRATION_CONFIRM_ENABLED = "true";

    const response = await register().expect(202);
    const id = await userId();
    expect(await rolesOf(id)).toEqual([]);

    const code: string = mail.sendOtp.mock.lastCall[1];
    await http()
      .post("/auth/register/confirm")
      .send({ attemptId: response.body.attemptId, code })
      .expect(200);

    expect(await rolesOf(id)).toEqual(["user"]);
  });

  it("does not assign the role after a wrong code", async () => {
    process.env.REGISTRATION_CONFIRM_ENABLED = "true";

    const response = await register().expect(202);
    await http()
      .post("/auth/register/confirm")
      .send({ attemptId: response.body.attemptId, code: "000000" })
      .expect(400);

    expect(await rolesOf(await userId())).toEqual([]);
  });

  it("does not duplicate an already assigned role", async () => {
    await register().expect(201);
    const id = await userId();

    await app.get(UserRolesService).assignDefaultRole(db.manager, id);

    expect(await rolesOf(id)).toEqual(["user"]);
  });

  it("still activates the user when the user role does not exist", async () => {
    await resetRbac(db);

    await register().expect(201);
    const id = await userId();

    expect(await rolesOf(id)).toEqual([]);
    expect(logs().join("\n")).toContain(
      `Default role not assigned reason=role_missing role=user userId=${id}`,
    );
  });
});
