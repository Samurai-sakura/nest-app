import { BadRequestException, HttpStatus } from "@nestjs/common";

const ALLOWED_FIELDS = ['displayName', 'email', 'status'];

export function checkAllowedFields(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "invalid_body",
      message: "Request body must be a JSON object",
    });
  }

  const keys = Object.keys(body);

  if (keys.length === 0) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "empty_update",
      message: "At least one field is required",
    });
  }

  const wrongKeys = keys.filter((key: string) => !ALLOWED_FIELDS.includes(key));
  if (wrongKeys.length !== 0) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "unknown_field",
      message: "Unknown fields: " + wrongKeys.join(", "),
    });
  }
}