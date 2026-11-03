import { existsSync } from "fs";
import { join } from "path";

export const TEST_DB = "backend_app_test";

const envFile = join(__dirname, "..", ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

process.env.POSTGRES_DB = TEST_DB;
process.env.APP_URL = "http://localhost:3200";
process.env.CONFIRMATION_HMAC_SECRET = "e2e-secret";
process.env.REGISTRATION_RATE_LIMIT = "1000";
process.env.REGISTRATION_RATE_TTL_SECONDS = "60";
