import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

export type RbacEntity = "role" | "permission" | "grant" | "user";

const ENTITY_TITLES: Record<RbacEntity, string> = {
  role: "Role",
  permission: "Permission",
  grant: "Grant",
  user: "User",
};

export function rbacNotFound(entity: RbacEntity) {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    code: `${entity}_not_found`,
    message: `${ENTITY_TITLES[entity]} not found`,
  });
}

export function rbacConflict(code: string, message: string) {
  return new ConflictException({ statusCode: HttpStatus.CONFLICT, code, message });
}

export function rbacBadRequest(code: string, message: string) {
  return new BadRequestException({ statusCode: HttpStatus.BAD_REQUEST, code, message });
}

// база недоступна: изменение не записано, его можно повторить позже
export function rbacUnavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: "rbac_unavailable",
    message: "RBAC is temporarily unavailable",
  });
}

// изменение оставило бы систему без пользователя, способного управлять RBAC
export function lastManagerConflict() {
  return rbacConflict(
    "last_rbac_manager",
    "The change would leave no active user with rbac@manage",
  );
}
