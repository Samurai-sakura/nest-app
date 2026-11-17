import express from "express";
import request from "supertest";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));

import { clearAuthCookies, setAuthCookies } from "./auth-cookies";

const app = express();
app.post("/set", (_req, res) => {
  setAuthCookies(res, { accessToken: "access-jwt", refreshToken: "refresh-jwt" });
  res.status(204).end();
});
app.post("/clear", (_req, res) => {
  clearAuthCookies(res);
  res.status(204).end();
});
app.post("/set-none", (_req, res) => {
  setAuthCookies(res, { accessToken: "access-jwt", refreshToken: "refresh-jwt" }, "none");
  res.status(204).end();
});
app.post("/clear-none", (_req, res) => {
  clearAuthCookies(res, "none");
  res.status(204).end();
});

async function cookiesFrom(path: string) {
  const response = await request(app).post(path).expect(204);
  const header = response.headers["set-cookie"] as unknown as string[];
  return Object.fromEntries(
    header.map((cookie) => [cookie.split("=")[0], cookie]),
  ) as Record<"access_token" | "refresh_token", string>;
}

describe("auth cookies", () => {
  it("sets the access cookie for the whole site for 15 minutes", async () => {
    const { access_token } = await cookiesFrom("/set");

    expect(access_token).toMatch(/^access_token=access-jwt;/);
    expect(access_token).toContain("Max-Age=900");
    expect(access_token).toContain("Path=/;");
    expect(access_token).toContain("HttpOnly");
    expect(access_token).toContain("Secure");
    expect(access_token).toContain("SameSite=Strict");
    expect(access_token).not.toContain("Domain");
  });

  it("sets the refresh cookie only for /auth/refresh for 30 days", async () => {
    const { refresh_token } = await cookiesFrom("/set");

    expect(refresh_token).toMatch(/^refresh_token=refresh-jwt;/);
    expect(refresh_token).toContain("Max-Age=2592000");
    expect(refresh_token).toContain("Path=/auth/refresh;");
    expect(refresh_token).toContain("HttpOnly");
    expect(refresh_token).toContain("Secure");
    expect(refresh_token).toContain("SameSite=Strict");
    expect(refresh_token).not.toContain("Domain");
  });

  it("clears both cookies with the same Path, Secure and SameSite", async () => {
    const { access_token, refresh_token } = await cookiesFrom("/clear");

    for (const [cookie, path] of [
      [access_token, "Path=/;"],
      [refresh_token, "Path=/auth/refresh;"],
    ]) {
      expect(cookie).toMatch(/^[a-z_]+=;/);
      expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      expect(cookie).toContain(path);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Domain");
    }
  });

  it.each(["/set-none", "/clear-none"])(
    "uses SameSite=None with Secure for a cross-site frontend (%s)",
    async (path) => {
      const cookies = await cookiesFrom(path);

      for (const cookie of Object.values(cookies)) {
        expect(cookie).toContain("SameSite=None");
        expect(cookie).toContain("Secure");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).not.toContain("Domain");
      }
    },
  );
});
