import { existsSync } from "fs";
import { DataSource } from "typeorm";
import { User } from "./auth/entities/user.entity";
import { RegistrationConfirmation } from "./auth/entities/registration-confirmation.entity";
import { LoginChallenge } from "./auth/entities/login-challenge.entity";
import {
  CreateAuthTablesMigration,
} from "./migrations/create-auth-tables.migration";
import { CreateLoginChallengesMigration } from "./migrations/create-login-challenges.migration";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default new DataSource({
  type: "postgres",
  host: process.env.DB_HOST,
  port: Number(process.env.POSTGRES_PORT),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  entities: [User, RegistrationConfirmation, LoginChallenge],
  migrations: [CreateAuthTablesMigration, CreateLoginChallengesMigration],
});
