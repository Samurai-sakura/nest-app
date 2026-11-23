import {
  CONFIRMATION_LINK_TOKEN_PATTERN,
  generateSecret,
  hashSecret,
  isExpired,
  secondsUntilResend,
  secretMatches,
} from "./confirmation-secret";

const key = "k".repeat(32);

describe("confirmation-secret", () => {
  afterEach(() => jest.useRealTimers());

  it("generates a 6 digit OTP", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSecret("otp")).toMatch(/^\d{6}$/);
    }
  });

  it("generates a 32 byte link secret that fits the token pattern", () => {
    const secret = generateSecret("magic_link");
    const token = `3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c.${secret}`;

    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(CONFIRMATION_LINK_TOKEN_PATTERN.exec(token)?.[2]).toBe(secret);
  });

  it("matches only the secret hashed with the same key", () => {
    const stored = hashSecret(key, "123456");

    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(secretMatches(key, "123456", stored)).toBe(true);
    expect(secretMatches(key, "654321", stored)).toBe(false);
    expect(secretMatches("o".repeat(32), "123456", stored)).toBe(false);
  });

  it("expires 10 minutes after the last send", () => {
    jest.useFakeTimers({ now: new Date("2026-01-01T00:10:00Z") });

    expect(isExpired(new Date("2026-01-01T00:00:00Z"))).toBe(false);
    expect(isExpired(new Date("2025-12-31T23:59:59Z"))).toBe(true);
  });

  it("counts seconds until resend is allowed", () => {
    jest.useFakeTimers({ now: new Date("2026-01-01T00:00:30Z") });

    expect(secondsUntilResend(new Date("2026-01-01T00:00:00Z"))).toBe(30);
    expect(secondsUntilResend(new Date("2025-12-31T23:59:00Z"))).toBe(0);
  });
});
