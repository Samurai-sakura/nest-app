import { QueryFailedError } from "typeorm";

const USERS_EMAIL_UNIQUE = "UQ_97672ac88f789774dd47f7c8be3";

export function isEmailConflict(error: unknown) {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as {
    code?: string;
    constraint?: string;
  };
  return (
    driverError.code === "23505" &&
    driverError.constraint === USERS_EMAIL_UNIQUE
  );
}