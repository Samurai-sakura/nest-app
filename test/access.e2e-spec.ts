import {
  Controller,
  Get,
  INestApplication,
  Logger,
  Post,
  UseGuards,
} from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import * as jwt from "jsonwebtoken";
import { AuthModule } from "../src/auth/auth.module";
import { AccessGuard } from "../src/auth/guards/access.guard";
import { CurrentUserId } from "../src/auth/decorators/current-user-id.decorator";
import { createTestApp } from "./helpers/create-test-app";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";
const handler = jest.fn();

// защищённых операций в задании входа нет: маршрут существует только в тесте
@Controller("test-protected")
@UseGuards(AccessGuard)
class ProtectedController {
  @Get()
  public me(@CurrentUserId() userId: string) {
    handler(userId);
    return { userId };
  }

  @Post()
  public change(@CurrentUserId() userId: string) {
    handler(userId);
    return { userId };
  }
}

describe("Access check (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let userId: string;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
    ({ app, db } = await createTestApp({
      imports: [AuthModule],
      controllers: [ProtectedController],
    }));
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE users CASCADE`);
    handler.mockClear();
    logged.forEach((spy) => spy.mockClear());
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
    const [{ id }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, 'active', $2) RETURNING id`,
      [email, await argon2.hash(password)],
    );
    userId = id;
  });

  const http = () => request(app.getHttpServer());

  async function signIn() {
    const response = await http().post("/auth/login").send({ email, password }).expect(204);
    const header = response.headers["set-cookie"] as unknown as string[];
    const value = (name: string) =>
      header.find((cookie) => cookie.startsWith(`${name}=`))!.split(";")[0].split("=")[1];
    return { access: value("access_token"), refresh: value("refresh_token") };
  }

  const withAccess = (token: string) =>
    http().get("/test-protected").set("Cookie", `access_token=${token}`);

  const forgeAccess = (payload: object, secret = process.env.JWT_ACCESS_SECRET!) =>
    jwt.sign(
      {
        sub: userId,
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
        token_use: "access",
        ...payload,
      },
      secret,
      { algorithm: "HS256", expiresIn: 60 },
    );

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  async function rejected(response: request.Response, reason: string) {
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "invalid_session",
      message: "Session is invalid or expired",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(logs().join("\n")).toContain(`Access rejected reason=${reason}`);
  }

  it("passes the user id from the access cookie to the handler", async () => {
    const { access } = await signIn();

    const response = await withAccess(access).expect(200);

    expect(response.body).toEqual({ userId });
    expect(handler).toHaveBeenCalledWith(userId);
  });

  it("rejects a request without the cookie", async () => {
    await rejected(await http().get("/test-protected"), "missing");
  });

  it("ignores a token in the Authorization header", async () => {
    const { access } = await signIn();

    await rejected(
      await http().get("/test-protected").set("Authorization", `Bearer ${access}`),
      "missing",
    );
  });

  it("does not accept a refresh token", async () => {
    const { refresh } = await signIn();

    await rejected(await withAccess(refresh), "signature");
  });

  it.each([
    ["garbage", () => "garbage", "malformed"],
    ["a token signed with another key", () => forgeAccess({}, "another-secret-0123456789abcdef01234567"), "signature"],
    ["a token from another issuer", () => forgeAccess({ iss: "someone-else" }), "claims"],
    ["a token for another audience", () => forgeAccess({ aud: "someone-else" }), "claims"],
    ["a token of the refresh type", () => forgeAccess({ token_use: "refresh" }), "token_use"],
  ])("rejects %s", async (_case, token, reason) => {
    await rejected(await withAccess(token()), reason);
  });

  it("rejects an expired token", async () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = jwt.sign(
      {
        sub: userId,
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
        token_use: "access",
        iat: exp - 900,
        exp,
      },
      process.env.JWT_ACCESS_SECRET!,
      { algorithm: "HS256" },
    );

    await rejected(await withAccess(token), "expired");
  });

  it.each(["pending", "blocked", "deleting", "deleted"])(
    "stops a %s user at the next request with the same token",
    async (status) => {
      const { access } = await signIn();
      await withAccess(access).expect(200);
      handler.mockClear();
      await db.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);

      await rejected(await withAccess(access), "user_inactive");
    },
  );

  it("stops a user that no longer exists", async () => {
    const { access } = await signIn();
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await rejected(await withAccess(access), "user_inactive");
  });

  it("protects state-changing routes the same way", async () => {
    const { access } = await signIn();

    await http().post("/test-protected").expect(401);
    await http().post("/test-protected").set("Cookie", `access_token=${access}`).expect(201);
  });

  it("never logs the token", async () => {
    const { access } = await signIn();
    await withAccess(`${access}x`).expect(401);

    expect(logs().join("\n")).not.toContain(access);
  });
});
