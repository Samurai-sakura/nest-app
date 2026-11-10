import { existsSync } from "fs";
import { join } from "path";

export const TEST_DB = "backend_app_test";

const envFile = join(__dirname, "..", ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

process.env.POSTGRES_DB = TEST_DB;
process.env.APP_URL = "http://localhost:3200";
process.env.FRONTEND_ORIGIN = "http://localhost:3200";
process.env.CONFIRMATION_HMAC_SECRET = "e2e-registration-confirmation-hmac-key";
process.env.JWT_ACCESS_SECRET = "e2e-jwt-access-secret-0123456789abcdef";
process.env.JWT_REFRESH_SECRET = "e2e-jwt-refresh-secret-0123456789abcdef";
process.env.LOGIN_CHALLENGE_HMAC_KEY = "e2e-login-challenge-hmac-key-0123456789";
process.env.LOG_EMAIL_HMAC_KEY = "e2e-log-email-hmac-key-0123456789abcdef";
process.env.JWT_ISSUER = "backend-app";
process.env.JWT_AUDIENCE = "backend-app";
process.env.LOGIN_EMAIL_CONFIRMATION_ENABLED = "false";
process.env.LOGIN_EMAIL_CONFIRMATION_METHOD = "otp";
process.env.REGISTRATION_RATE_LIMIT = "1000";
process.env.REGISTRATION_RATE_TTL_SECONDS = "60";
