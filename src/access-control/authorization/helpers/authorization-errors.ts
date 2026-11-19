import { ForbiddenException, HttpStatus } from "@nestjs/common";

export function permissionDenied() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code: "permission_denied",
    message: "Permission denied",
  });
}

export function ownershipDenied() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code: "ownership_denied",
    message: "Access to this resource is denied",
  });
}
