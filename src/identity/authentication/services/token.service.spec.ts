import * as jwt from "jsonwebtoken";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));

import { TokenService, TokenUse } from "./token.service";

const env: Record<string, string> = {
  JWT_ACCESS_SECRET: "access-secret-0123456789abcdef0123456789",
  JWT_REFRESH_SECRET: "refresh-secret-0123456789abcdef012345678",
  JWT_ISSUER: "backend-app",
  JWT_AUDIENCE: "backend-app",
};
const config = { getOrThrow: (key: string) => env[key] };
const userId = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";
const now = () => Math.floor(Date.now() / 1000);

function forge(
  use: TokenUse,
  payload: Record<string, unknown> = {},
  options: jwt.SignOptions = {},
  secret = use === "access" ? env.JWT_ACCESS_SECRET : env.JWT_REFRESH_SECRET,
) {
  const claims: Record<string, unknown> = {
    sub: userId,
    iss: env.JWT_ISSUER,
    aud: env.JWT_AUDIENCE,
    iat: now(),
    exp: now() + 900,
    token_use: use,
    ...payload,
  };
  for (const key of Object.keys(claims)) {
    if (claims[key] === undefined) delete claims[key];
  }
  // без noTimestamp библиотека сама добавляет iat
  const noTimestamp = !("iat" in claims);
  return jwt.sign(claims, secret, { algorithm: "HS256", noTimestamp, ...options });
}

describe("TokenService", () => {
  const service = new TokenService(config as any);

  describe("signPair", () => {
    it.each([
      ["access", "accessToken", 15 * 60],
      ["refresh", "refreshToken", 30 * 24 * 60 * 60],
    ] as const)("signs a %s token with the required claims only", (use, key, ttl) => {
      const token = service.signPair(userId)[key];

      const { header, payload } = jwt.decode(token, { complete: true }) as {
        header: jwt.JwtHeader;
        payload: jwt.JwtPayload;
      };
      expect(header.alg).toBe("HS256");
      expect(Object.keys(payload).sort()).toEqual(
        ["aud", "exp", "iat", "iss", "sub", "token_use"].sort(),
      );
      expect(payload).toMatchObject({
        sub: userId,
        iss: "backend-app",
        aud: "backend-app",
        token_use: use,
      });
      expect(payload.exp! - payload.iat!).toBe(ttl);
      expect(Math.abs(payload.iat! - now())).toBeLessThanOrEqual(1);
    });

    it("signs access and refresh with different keys", () => {
      const { accessToken, refreshToken } = service.signPair(userId);

      expect(() => jwt.verify(accessToken, env.JWT_ACCESS_SECRET)).not.toThrow();
      expect(() => jwt.verify(accessToken, env.JWT_REFRESH_SECRET)).toThrow();
      expect(() => jwt.verify(refreshToken, env.JWT_REFRESH_SECRET)).not.toThrow();
      expect(() => jwt.verify(refreshToken, env.JWT_ACCESS_SECRET)).toThrow();
    });
  });

  describe("verify", () => {
    it.each(["access", "refresh"] as const)("accepts its own %s token", (use) => {
      const pair = service.signPair(userId);
      const token = use === "access" ? pair.accessToken : pair.refreshToken;

      expect(service.verify(token, use)).toEqual({ valid: true, userId });
    });

    it.each([undefined, ""])("reports a missing token for %p", (token) => {
      expect(service.verify(token, "access")).toEqual({
        valid: false,
        reason: "missing",
      });
    });

    it.each(["abc", "a.b.c", "Bearer x"])("reports a malformed token %p", (token) => {
      expect(service.verify(token, "access")).toMatchObject({ reason: "malformed" });
    });

    it("reports a token signed with another key", () => {
      const token = forge("access", {}, {}, "another-secret-0123456789abcdef01234567");

      expect(service.verify(token, "access")).toMatchObject({ reason: "signature" });
    });

    it("reports a refresh token sent as access", () => {
      const { refreshToken } = service.signPair(userId);

      expect(service.verify(refreshToken, "access")).toMatchObject({
        valid: false,
      });
    });

    it.each(["HS384", "HS512"] as const)("rejects the %s algorithm", (algorithm) => {
      const token = forge("access", {}, { algorithm });

      expect(service.verify(token, "access")).toMatchObject({ reason: "signature" });
    });

    it("rejects an unsigned token", () => {
      const token = forge("access", {}, { algorithm: "none" }, "");

      expect(service.verify(token, "access")).toMatchObject({ valid: false });
    });

    it("accepts a token expired within the 30 second tolerance", () => {
      const token = forge("access", { iat: now() - 920, exp: now() - 20 });

      expect(service.verify(token, "access")).toEqual({ valid: true, userId });
    });

    it("reports a token expired beyond the tolerance", () => {
      const token = forge("access", { iat: now() - 940, exp: now() - 40 });

      expect(service.verify(token, "access")).toMatchObject({ reason: "expired" });
    });

    it.each([
      ["a wrong issuer", { iss: "someone-else" }],
      ["a wrong audience", { aud: "someone-else" }],
      ["an empty subject", { sub: "" }],
      ["no subject", { sub: undefined }],
      ["no issued-at", { iat: undefined }],
      ["no expiry", { exp: undefined }],
      ["an issued-at in the future", { iat: now() + 120, exp: now() + 1020 }],
    ])("reports %s as invalid claims", (_case, payload) => {
      const token = forge("access", payload);

      expect(service.verify(token, "access")).toMatchObject({ reason: "claims" });
    });

    it("reports a token of the wrong type", () => {
      const token = forge("access", { token_use: "refresh" });

      expect(service.verify(token, "access")).toMatchObject({ reason: "token_use" });
    });

    it("reports a token without a type", () => {
      const token = forge("access", { token_use: undefined });

      expect(service.verify(token, "access")).toMatchObject({ reason: "token_use" });
    });
  });
});
