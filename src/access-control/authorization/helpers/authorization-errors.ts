import { ForbiddenException, HttpStatus } from "@nestjs/common";

// личность установлена, но права нет; одинаково для существующего и вымышленного ресурса
export function permissionDenied() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code: "permission_denied",
    message: "Permission denied",
  });
}

// право на операцию есть, но запись принадлежит другому пользователю
export function ownershipDenied() {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    code: "ownership_denied",
    message: "Access to this resource is denied",
  });
}
