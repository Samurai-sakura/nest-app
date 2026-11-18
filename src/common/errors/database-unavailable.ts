import { QueryFailedError } from "typeorm";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

// SQLSTATE: 08 — потеря соединения, 57P — остановка сервера, 53 — нехватка ресурсов
const UNAVAILABLE_SQLSTATE = /^(08|57P|53)/;

// драйвер pg сообщает о разрыве соединения без кода, только текстом
const UNAVAILABLE_MESSAGE = /connection terminated|timeout exceeded when trying to connect/i;

// отличает недоступную базу (временный сбой, 503) от ошибки запроса или кода (500)
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
