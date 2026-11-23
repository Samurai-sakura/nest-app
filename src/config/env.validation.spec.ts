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
    PUBLIC_API_BASE_URL: "http://localhost:3200",
    REGISTRATION_CONFIRM_ENABLED: "true",
    REGISTRATION_CONFIRM_METHOD: "otp",
    REGISTRATION_RATE_LIMIT: "5",
    REGISTRATION_RATE_TTL_SECONDS: "60",
    LOGIN_EMAIL_CONFIRMATION_ENABLED: "false",
    LOGIN_EMAIL_CONFIRMATION_METHOD: "magic_link",
    EMAIL_CHANGE_METHOD: "otp",
    CONFIRMATION_HMAC_SECRET: secret("a"),
    JWT_ACCESS_SECRET: secret("b"),
    JWT_REFRESH_SECRET: secret("c"),
    LOGIN_CHALLENGE_HMAC_KEY: secret("d"),
    LOG_EMAIL_HMAC_KEY: secret("e"),
    EMAIL_CHANGE_HMAC_KEY: secret("f"),
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
    "EMAIL_CHANGE_HMAC_KEY",
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

  it.each([
    "REGISTRATION_CONFIRM_METHOD",
    "LOGIN_EMAIL_CONFIRMATION_METHOD",
    "EMAIL_CHANGE_METHOD",
  ])(
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
    "https://api.example.com",
    "https://example.com/api/v1/",
    "http://localhost:3200",
    "http://127.0.0.1:3200",
    "http://[::1]:3200",
  ])("accepts PUBLIC_API_BASE_URL %p", (value) => {
    expect(errorFor({ PUBLIC_API_BASE_URL: value })).toBeNull();
  });

  it.each([undefined, "", "not a url", "ftp://api.example.com", "https://api.example.com/?a=1", "https://api.example.com/#top"])(
    "rejects PUBLIC_API_BASE_URL %p",
    (value) => {
      expect(errorFor({ PUBLIC_API_BASE_URL: value })).toContain(
        "PUBLIC_API_BASE_URL must be an http(s) URL without query or fragment",
      );
    },
  );

  it("requires https for PUBLIC_API_BASE_URL outside localhost", () => {
    expect(errorFor({ PUBLIC_API_BASE_URL: "http://api.example.com" })).toContain(
      "PUBLIC_API_BASE_URL must use https outside localhost",
    );
  });

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

  it("accepts an optional RBAC_BOOTSTRAP_ADMIN_USER_ID that is a uuid", () => {
    expect(errorFor({ RBAC_BOOTSTRAP_ADMIN_USER_ID: undefined })).toBeNull();
    expect(
      errorFor({ RBAC_BOOTSTRAP_ADMIN_USER_ID: "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c" }),
    ).toBeNull();
    expect(errorFor({ RBAC_BOOTSTRAP_ADMIN_USER_ID: "admin" })).toContain(
      "RBAC_BOOTSTRAP_ADMIN_USER_ID must be a user id (uuid)",
    );
  });

  describe("photo storage", () => {
    const s3 = {
      PHOTO_STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "http://localhost:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "backend-app-photos",
      S3_ACCESS_KEY_ID: "BACKENDAPPDEV",
      S3_SECRET_ACCESS_KEY: "BACKENDAPPDEVSECRET2026",
    };

    it("uses the local folder when the driver is not set", () => {
      expect(errorFor({ PHOTO_STORAGE_DRIVER: undefined })).toBeNull();
    });

    it("accepts a complete S3 configuration", () => {
      expect(errorFor({ ...s3, S3_CREATE_BUCKET: "true" })).toBeNull();
    });

    it("rejects an unknown driver", () => {
      expect(errorFor({ PHOTO_STORAGE_DRIVER: "ftp" })).toContain(
        "PHOTO_STORAGE_DRIVER must be local or s3",
      );
    });

    it("requires S3 in production", () => {
      expect(errorFor({ NODE_ENV: "production" })).toContain(
        "PHOTO_STORAGE_DRIVER must be s3 when NODE_ENV is production",
      );
      expect(errorFor({ ...s3, NODE_ENV: "production" })).toBeNull();
    });

    it.each(Object.keys(s3).filter((key) => key !== "PHOTO_STORAGE_DRIVER"))(
      "requires %s for the S3 driver",
      (key) => {
        expect(errorFor({ ...s3, [key]: undefined })).toContain(
          `${key} is required for PHOTO_STORAGE_DRIVER=s3`,
        );
      },
    );

    it("rejects an S3 endpoint that is not an http(s) URL", () => {
      expect(errorFor({ ...s3, S3_ENDPOINT: "localhost:9000" })).toContain(
        "S3_ENDPOINT must be an http(s) URL",
      );
    });

    it("rejects S3_CREATE_BUCKET other than true or false", () => {
      expect(errorFor({ ...s3, S3_CREATE_BUCKET: "yes" })).toContain(
        "S3_CREATE_BUCKET must be true or false",
      );
    });

    it("does not put the S3 secret into the message", () => {
      expect(errorFor({ ...s3, S3_ENDPOINT: "bad" })).not.toContain("BACKENDAPPDEVSECRET2026");
    });
  });
});
