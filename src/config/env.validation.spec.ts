import { validateEnv } from "./env.validation";

const secret = (char: string) => char.repeat(32);

function validEnv(): Record<string, string> {
  return {
    POSTGRES_USER: "db_user",
    POSTGRES_PASSWORD: "postgrespassword",
    POSTGRES_DB: "backend_app_db",
    POSTGRES_PORT: "5432",
    DB_HOST: "localhost",
    PORT: "3200",
    APP_URL: "http://localhost:3200",
    FRONTEND_ORIGIN: "http://localhost:3200",
    REGISTRATION_CONFIRM_ENABLED: "true",
    REGISTRATION_CONFIRM_METHOD: "otp",
    REGISTRATION_RATE_LIMIT: "5",
    REGISTRATION_RATE_TTL_SECONDS: "60",
    LOGIN_EMAIL_CONFIRMATION_ENABLED: "false",
    LOGIN_EMAIL_CONFIRMATION_METHOD: "magic_link",
    CONFIRMATION_HMAC_SECRET: secret("a"),
    JWT_ACCESS_SECRET: secret("b"),
    JWT_REFRESH_SECRET: secret("c"),
    LOGIN_CHALLENGE_HMAC_KEY: secret("d"),
    LOG_EMAIL_HMAC_KEY: secret("e"),
    JWT_ISSUER: "backend-app",
    JWT_AUDIENCE: "backend-app",
    SMTP_HOST: "localhost",
    SMTP_PORT: "1025",
    MAIL_FROM: "no-reply@backend-app.local",
  };
}

function errorFor(overrides: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = { ...validEnv(), ...overrides };
  try {
    validateEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  return null;
}

describe("validateEnv", () => {
  it("accepts a complete configuration", () => {
    const env = validEnv();

    expect(validateEnv(env)).toBe(env);
  });

  it("accepts a missing PORT", () => {
    expect(errorFor({ PORT: undefined })).toBeNull();
  });

  it.each([
    "CONFIRMATION_HMAC_SECRET",
    "JWT_ACCESS_SECRET",
    "JWT_REFRESH_SECRET",
    "LOGIN_CHALLENGE_HMAC_KEY",
    "LOG_EMAIL_HMAC_KEY",
  ])("rejects %s that is missing or shorter than 32 bytes", (key) => {
    expect(errorFor({ [key]: undefined })).toContain(
      `${key} must be at least 32 bytes`,
    );
    expect(errorFor({ [key]: "x".repeat(31) })).toContain(key);
  });

  it("counts bytes, not characters", () => {
    expect(errorFor({ JWT_ACCESS_SECRET: "ключ".repeat(4) })).toBeNull();
    expect(errorFor({ JWT_ACCESS_SECRET: "ключ".repeat(3) })).toContain(
      "JWT_ACCESS_SECRET",
    );
  });

  it("rejects a key shared between two purposes", () => {
    expect(errorFor({ JWT_REFRESH_SECRET: secret("b") })).toContain(
      "must all be different",
    );
  });

  it("does not put secret values into the message", () => {
    const leaked = "leaked-secret-value-1234567890abcdef";

    const message = errorFor({
      JWT_ACCESS_SECRET: leaked,
      JWT_REFRESH_SECRET: leaked,
      LOG_EMAIL_HMAC_KEY: "short",
    });

    expect(message).not.toContain(leaked);
    expect(message).not.toContain("short");
  });

  it.each([
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "DB_HOST",
    "SMTP_HOST",
    "MAIL_FROM",
    "JWT_ISSUER",
    "JWT_AUDIENCE",
  ])("requires %s", (key) => {
    expect(errorFor({ [key]: undefined })).toContain(`${key} is required`);
    expect(errorFor({ [key]: "   " })).toContain(`${key} is required`);
  });

  it.each([
    "POSTGRES_PORT",
    "SMTP_PORT",
    "REGISTRATION_RATE_LIMIT",
    "REGISTRATION_RATE_TTL_SECONDS",
    "PORT",
  ])("rejects %s that is not a positive integer", (key) => {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      expect(errorFor({ [key]: value })).toContain(
        `${key} must be a positive integer`,
      );
    }
  });

  it.each(["REGISTRATION_CONFIRM_ENABLED", "LOGIN_EMAIL_CONFIRMATION_ENABLED"])(
    "accepts only true or false for %s",
    (key) => {
      expect(errorFor({ [key]: "yes" })).toContain(`${key} must be true or false`);
      expect(errorFor({ [key]: undefined })).toContain(key);
    },
  );

  it.each(["REGISTRATION_CONFIRM_METHOD", "LOGIN_EMAIL_CONFIRMATION_METHOD"])(
    "accepts only otp or magic_link for %s",
    (key) => {
      expect(errorFor({ [key]: "sms" })).toContain(
        `${key} must be otp or magic_link`,
      );
      expect(errorFor({ [key]: undefined })).toContain(key);
    },
  );

  it.each(["not a url", "ftp://localhost", ""])(
    "rejects APP_URL %p",
    (value) => {
      expect(errorFor({ APP_URL: value })).toContain("APP_URL");
    },
  );

  it.each([
    "http://localhost:3200/",
    "http://localhost:3200/app",
    "localhost:3200",
    "",
  ])("rejects FRONTEND_ORIGIN %p", (value) => {
    expect(errorFor({ FRONTEND_ORIGIN: value })).toContain("FRONTEND_ORIGIN");
  });

  it("lists every problem at once", () => {
    const message = errorFor({ JWT_ISSUER: "", SMTP_PORT: "abc" });

    expect(message).toContain("JWT_ISSUER is required");
    expect(message).toContain("SMTP_PORT must be a positive integer");
  });

  it("accepts an optional AUTH_COOKIE_SAME_SITE of strict or none", () => {
    expect(errorFor({ AUTH_COOKIE_SAME_SITE: undefined })).toBeNull();
    expect(errorFor({ AUTH_COOKIE_SAME_SITE: "strict" })).toBeNull();
    expect(errorFor({ AUTH_COOKIE_SAME_SITE: "none" })).toBeNull();
    expect(errorFor({ AUTH_COOKIE_SAME_SITE: "lax" })).toContain(
      "AUTH_COOKIE_SAME_SITE must be strict or none",
    );
  });
});
