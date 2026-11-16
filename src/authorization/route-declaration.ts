import type { Type } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { RBAC_NAME_PATTERN } from "../rbac/rbac-name";

export const PUBLIC_KEY = "authorization:public";
export const PERMISSION_KEY = "authorization:permission";
export const RECEIPT_KEY = "authorization:receipt";

const HEADER_PATTERN = /^[a-z0-9-]+$/;

export interface RequiredPermission {
  permission: string;
  action: string;
  // критическая операция: успешный допуск тоже попадает в журнал
  audit?: boolean;
}

export type RouteDeclaration =
  | { kind: "public" }
  | { kind: "protected"; required: RequiredPermission; receiptHeader?: string }
  | { kind: "receipt"; receiptHeader: string };

export type DeclarationCheck =
  | { valid: true; declaration: RouteDeclaration }
  | { valid: false; reason: string };

// декларация метода перекрывает декларацию контроллера по каждому ключу отдельно,
// поэтому @Public() на контроллере и пара на методе дают конфликт, а не публичный маршрут
export function readDeclaration(
  reflector: Reflector,
  handler: Function,
  controller: Type<unknown>,
): DeclarationCheck {
  const targets = [handler, controller];
  const isPublic = reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;
  const required = reflector.getAllAndOverride<RequiredPermission>(PERMISSION_KEY, targets);
  const receiptHeader = reflector.getAllAndOverride<string>(RECEIPT_KEY, targets);

  if (isPublic) {
    return required || receiptHeader
      ? invalid("public route also declares a permission or a receipt")
      : { valid: true, declaration: { kind: "public" } };
  }
  if (!required && !receiptHeader) {
    return invalid("route has no authorization declaration");
  }
  if (
    required &&
    !(RBAC_NAME_PATTERN.test(required.permission) && RBAC_NAME_PATTERN.test(required.action))
  ) {
    return invalid(`invalid permission name ${required.permission}@${required.action}`);
  }
  if (receiptHeader !== undefined && !HEADER_PATTERN.test(receiptHeader)) {
    return invalid(`invalid receipt header ${receiptHeader}`);
  }

  return {
    valid: true,
    declaration: required
      ? { kind: "protected", required, receiptHeader }
      : { kind: "receipt", receiptHeader: receiptHeader! },
  };
}

function invalid(reason: string): DeclarationCheck {
  return { valid: false, reason };
}
