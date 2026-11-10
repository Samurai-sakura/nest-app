import { ConsoleLogger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "X-Request-Id";
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

const storage = new AsyncLocalStorage<{ requestId: string }>();

export function currentRequestId() {
  return storage.getStore()?.requestId;
}

// входящий X-Request-Id принимается только в безопасном формате, иначе генерируется новый:
// значение попадает в журнал и не должно позволять подделать строку лога
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(REQUEST_ID_HEADER);
  const requestId =
    incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  storage.run({ requestId }, next);
}

function withRequestId(message: unknown) {
  const requestId = currentRequestId();
  return requestId && typeof message === "string"
    ? `${message} requestId=${requestId}`
    : message;
}

// добавляет requestId к каждой строке журнала, записанной во время запроса
export class RequestAwareLogger extends ConsoleLogger {
  public log(message: unknown, ...rest: unknown[]) {
    super.log(withRequestId(message), ...rest);
  }

  public warn(message: unknown, ...rest: unknown[]) {
    super.warn(withRequestId(message), ...rest);
  }

  public error(message: unknown, ...rest: unknown[]) {
    super.error(withRequestId(message), ...rest);
  }

  public debug(message: unknown, ...rest: unknown[]) {
    super.debug(withRequestId(message), ...rest);
  }

  public verbose(message: unknown, ...rest: unknown[]) {
    super.verbose(withRequestId(message), ...rest);
  }

  public fatal(message: unknown, ...rest: unknown[]) {
    super.fatal(withRequestId(message), ...rest);
  }
}
