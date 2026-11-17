import type { CookieOptions, Response } from "express";
import type { ConfigService } from "@nestjs/config";
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  TokenPair,
} from "../services/token.service";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";

// none нужен только frontend на другом site; по умолчанию strict
export type AuthCookieSameSite = "strict" | "none";

export function cookieSameSite(config: ConfigService): AuthCookieSameSite {
  return config.get("AUTH_COOKIE_SAME_SITE") === "none" ? "none" : "strict";
}

// host-only: Domain не задаётся
function optionsFor(path: string, sameSite: AuthCookieSameSite): CookieOptions {
  return { httpOnly: true, secure: true, sameSite, path };
}

export function setAuthCookies(
  res: Response,
  tokens: TokenPair,
  sameSite: AuthCookieSameSite = "strict",
) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...optionsFor("/", sameSite),
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...optionsFor("/auth/refresh", sameSite),
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
}

// cookie удаляется, только если Path, Secure и SameSite совпадают с установкой
export function clearAuthCookies(
  res: Response,
  sameSite: AuthCookieSameSite = "strict",
) {
  res.clearCookie(ACCESS_COOKIE, optionsFor("/", sameSite));
  res.clearCookie(REFRESH_COOKIE, optionsFor("/auth/refresh", sameSite));
}
