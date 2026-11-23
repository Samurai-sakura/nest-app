import { createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import type { ConfirmationMethod } from "../confirmation-method";

export const CONFIRMATION_TTL_SECONDS = 600;
export const CONFIRMATION_RESEND_AFTER_SECONDS = 60;
export const CONFIRMATION_MAX_ATTEMPTS = 5;

export const CONFIRMATION_LINK_TOKEN_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export function generateSecret(method: ConfirmationMethod) {
  return method === "otp"
    ? randomInt(0, 1_000_000).toString().padStart(6, "0")
    : randomBytes(32).toString("base64url");
}

export function hashSecret(key: string, secret: string) {
  return createHmac("sha256", key).update(secret).digest("hex");
}

export function secretMatches(key: string, secret: string, storedHash: string) {
  return timingSafeEqual(
    Buffer.from(hashSecret(key, secret), "hex"),
    Buffer.from(storedHash, "hex"),
  );
}

export function isExpired(lastSentAt: Date) {
  return lastSentAt.getTime() + CONFIRMATION_TTL_SECONDS * 1000 < Date.now();
}

export function secondsUntilResend(lastSentAt: Date) {
  const readyAt = lastSentAt.getTime() + CONFIRMATION_RESEND_AFTER_SECONDS * 1000;
  return Math.max(0, Math.ceil((readyAt - Date.now()) / 1000));
}
