const MIN_SECRET_BYTES = 32;

const SECRET_KEYS = [
  "CONFIRMATION_HMAC_SECRET",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "LOGIN_CHALLENGE_HMAC_KEY",
  "LOG_EMAIL_HMAC_KEY",
];

const REQUIRED_KEYS = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "DB_HOST",
  "SMTP_HOST",
  "MAIL_FROM",
  "JWT_ISSUER",
  "JWT_AUDIENCE",
];

const POSITIVE_INT_KEYS = [
  "POSTGRES_PORT",
  "SMTP_PORT",
  "REGISTRATION_RATE_LIMIT",
  "REGISTRATION_RATE_TTL_SECONDS",
];

const BOOLEAN_KEYS = [
  "REGISTRATION_CONFIRM_ENABLED",
  "LOGIN_EMAIL_CONFIRMATION_ENABLED",
];

const METHOD_KEYS = [
  "REGISTRATION_CONFIRM_METHOD",
  "LOGIN_EMAIL_CONFIRMATION_METHOD",
];

function isPositiveInt(value: string) {
  return /^\d+$/.test(value) && Number(value) > 0;
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// сообщения содержат только имена переменных, значения ключей в журнал не попадают
export function validateEnv(config: Record<string, unknown>) {
  const errors: string[] = [];
  const read = (key: string) =>
    typeof config[key] === "string" ? (config[key] as string) : "";

  for (const key of REQUIRED_KEYS) {
    if (!read(key).trim()) {
      errors.push(`${key} is required`);
    }
  }

  for (const key of POSITIVE_INT_KEYS) {
    if (!isPositiveInt(read(key))) {
      errors.push(`${key} must be a positive integer`);
    }
  }
  if (read("PORT") && !isPositiveInt(read("PORT"))) {
    errors.push("PORT must be a positive integer");
  }

  for (const key of BOOLEAN_KEYS) {
    if (!["true", "false"].includes(read(key))) {
      errors.push(`${key} must be true or false`);
    }
  }

  for (const key of METHOD_KEYS) {
    if (!["otp", "magic_link"].includes(read(key))) {
      errors.push(`${key} must be otp or magic_link`);
    }
  }

  if (read("AUTH_COOKIE_SAME_SITE") && !["strict", "none"].includes(read("AUTH_COOKIE_SAME_SITE"))) {
    errors.push("AUTH_COOKIE_SAME_SITE must be strict or none");
  }

  if (!parseHttpUrl(read("APP_URL"))) {
    errors.push("APP_URL must be an http(s) URL");
  }
  if (parseHttpUrl(read("FRONTEND_ORIGIN"))?.origin !== read("FRONTEND_ORIGIN")) {
    errors.push("FRONTEND_ORIGIN must be an origin like https://example.com");
  }

  for (const key of SECRET_KEYS) {
    if (Buffer.byteLength(read(key)) < MIN_SECRET_BYTES) {
      errors.push(`${key} must be at least ${MIN_SECRET_BYTES} bytes`);
    }
  }
  const secrets = SECRET_KEYS.map(read).filter(Boolean);
  if (new Set(secrets).size !== secrets.length) {
    errors.push(`${SECRET_KEYS.join(", ")} must all be different`);
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join("\n- ")}`,
    );
  }
  return config;
}
