import { QueryFailedError } from "typeorm";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const UNAVAILABLE_SQLSTATE = /^(08|57P|53)/;

const UNAVAILABLE_MESSAGE = /connection terminated|timeout exceeded when trying to connect/i;

export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(isDatabaseUnavailable) || hasUnavailableCode(error);
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return hasUnavailableCode(error) || UNAVAILABLE_MESSAGE.test(error.message);
}

function hasUnavailableCode(error: Error) {
  const source = error instanceof QueryFailedError ? error.driverError : error;
  const code = (source as { code?: unknown }).code;
  return (
    typeof code === "string" && (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATE.test(code))
  );
}
