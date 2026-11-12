import { INestApplication, Logger } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import * as argon2 from "argon2";
import * as jwt from "jsonwebtoken";
import { createTestApp } from "./helpers/create-test-app";

const email = "abc@gmail.com";
const password = "Passw0rd-secret";

describe("Session refresh and logout (e2e)", () => {
  const logged: jest.SpyInstance[] = [];
  let app: INestApplication;
  let db: DataSource;
  let userId: string;

  beforeAll(() => {
    for (const level of ["log", "warn", "error"] as const) {
      logged.push(jest.spyOn(Logger.prototype, level).mockImplementation());
    }
  });

  afterAll(() => jest.restoreAllMocks());

  // своё приложение на каждый тест: лимиты частоты хранятся в памяти
  beforeEach(async () => {
    ({ app, db } = await createTestApp());

    await db.query(`TRUNCATE users CASCADE`);
    logged.forEach((spy) => spy.mockClear());
    process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
    const [{ id }] = await db.query(
      `INSERT INTO users (email, status, password_hash) VALUES ($1, 'active', $2) RETURNING id`,
      [email, await argon2.hash(password)],
    );
    userId = id;
  });

  afterEach(() => app.close());

  const http = () => request(app.getHttpServer());

  function cookiesOf(response: request.Response) {
    const header = (response.headers["set-cookie"] ?? []) as unknown as string[];
    return Object.fromEntries(header.map((cookie) => [cookie.split("=")[0], cookie]));
  }

  const valueOf = (cookie: string) => cookie.split(";")[0].split("=")[1];

  async function signIn() {
    const cookies = cookiesOf(
      await http().post("/auth/login").send({ email, password }).expect(204),
    );
    return {
      access: valueOf(cookies.access_token),
      refresh: valueOf(cookies.refresh_token),
    };
  }

  const refreshWith = (token: string) =>
    http().post("/auth/refresh").set("Cookie", `refresh_token=${token}`);

  const forgeRefresh = (payload: object, secret = process.env.JWT_REFRESH_SECRET!) =>
    jwt.sign(
      {
        sub: userId,
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
        token_use: "refresh",
        ...payload,
      },
      secret,
      { algorithm: "HS256", expiresIn: 60 },
    );

  const logs = () =>
    logged.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));

  describe("POST /auth/refresh", () => {
    it("issues a new pair of cookies for an active user", async () => {
      const { refresh } = await signIn();

      const response = await refreshWith(refresh).expect(204);

      expect(response.text).toBe("");
      const cookies = cookiesOf(response);
      expect(cookies.access_token).toContain("Max-Age=900; Path=/;");
      expect(cookies.refresh_token).toContain("Max-Age=2592000; Path=/auth/refresh;");
      const access = jwt.verify(
        valueOf(cookies.access_token),
        process.env.JWT_ACCESS_SECRET!,
      ) as jwt.JwtPayload;
      expect(access).toMatchObject({ sub: userId, token_use: "access" });
    });

    it("keeps the previous refresh usable after rotation", async () => {
      const { refresh } = await signIn();
      await refreshWith(refresh).expect(204);

      await refreshWith(refresh).expect(204);
    });

    async function rejected(response: request.Response) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        statusCode: 401,
        code: "invalid_session",
        message: "Session is invalid or expired",
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }

    it("returns invalid_session without a cookie", async () => {
      await rejected(await http().post("/auth/refresh"));
      expect(logs().join("\n")).toContain("Refresh failed reason=missing");
    });

    it("takes the token only from the cookie", async () => {
      const { refresh } = await signIn();

      await rejected(await http().post("/auth/refresh").send({ refresh_token: refresh }));
      await rejected(
        await http().post(`/auth/refresh?refresh_token=${encodeURIComponent(refresh)}`),
      );
      await rejected(
        await http().post("/auth/refresh").set("Authorization", `Bearer ${refresh}`),
      );
    });

    it("does not accept an access token", async () => {
      const { access } = await signIn();

      await rejected(await refreshWith(access));
    });

    it.each([
      ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }, "expired"],
      ["from another issuer", { iss: "someone-else" }, "claims"],
      ["with the access type", { token_use: "access" }, "token_use"],
    ])("rejects a refresh token %s", async (_case, payload, reason) => {
      const token =
        "exp" in payload
          ? jwt.sign(
              {
                sub: userId,
                iss: process.env.JWT_ISSUER,
                aud: process.env.JWT_AUDIENCE,
                token_use: "refresh",
                iat: payload.exp - 900,
                exp: payload.exp,
              },
              process.env.JWT_REFRESH_SECRET!,
              { algorithm: "HS256" },
            )
          : forgeRefresh(payload);

      await rejected(await refreshWith(token));
      expect(logs().join("\n")).toContain(`Refresh failed reason=${reason}`);
    });

    it("rejects a token signed with another key", async () => {
      await rejected(
        await refreshWith(forgeRefresh({}, "another-secret-0123456789abcdef01234567")),
      );
    });

    it.each(["pending", "blocked", "deleting", "deleted"])(
      "rejects the refresh of a %s user",
      async (status) => {
        const { refresh } = await signIn();
        await db.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);

        await rejected(await refreshWith(refresh));
      },
    );

    it("rejects the refresh of a user that no longer exists", async () => {
      const { refresh } = await signIn();
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);

      await rejected(await refreshWith(refresh));
    });

    it("allows 30 refreshes per minute from one IP", async () => {
      const { refresh } = await signIn();
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        statuses.push((await refreshWith(refresh)).status);
      }

      expect(statuses.slice(0, 30).every((status) => status === 204)).toBe(true);
      expect(statuses[30]).toBe(429);
    });

    it("never logs tokens", async () => {
      const { refresh } = await signIn();
      await refreshWith(refresh).expect(204);
      await refreshWith(`${refresh}x`).expect(401);

      const text = logs().join("\n");
      expect(text).toContain(`Refresh succeeded userId=${userId}`);
      expect(text).toContain("Refresh failed reason=signature");
      expect(text).not.toContain(refresh);
    });
  });

  describe("POST /auth/logout", () => {
    function expectCleared(response: request.Response) {
      const cookies = cookiesOf(response);
      for (const [name, path] of [
        ["access_token", "Path=/;"],
        ["refresh_token", "Path=/auth/refresh;"],
      ]) {
        expect(cookies[name]).toMatch(new RegExp(`^${name}=;`));
        expect(cookies[name]).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(cookies[name]).toContain(path);
        expect(cookies[name]).toContain("HttpOnly; Secure; SameSite=Strict");
        expect(cookies[name]).not.toContain("Domain");
      }
    }

    it("clears both cookies of a signed-in client", async () => {
      const { access } = await signIn();

      const response = await http()
        .post("/auth/logout")
        .set("Cookie", `access_token=${access}`)
        .expect(204);

      expect(response.text).toBe("");
      expectCleared(response);
    });

    it("answers 204 without any cookies", async () => {
      expectCleared(await http().post("/auth/logout").expect(204));
    });

    it("answers 204 with broken cookies", async () => {
      expectCleared(
        await http()
          .post("/auth/logout")
          .set("Cookie", "access_token=garbage; refresh_token=garbage")
          .expect(204),
      );
    });

    it("does not revoke a refresh copy kept elsewhere", async () => {
      const { refresh } = await signIn();
      await http().post("/auth/logout").expect(204);

      await refreshWith(refresh).expect(204);
    });
  });
});
