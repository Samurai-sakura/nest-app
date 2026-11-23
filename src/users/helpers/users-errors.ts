import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";

export function usersUnavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: "users_unavailable",
    message: "User data is temporarily unavailable",
  });
}

export function userNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    code: "user_not_found",
    message: "User not found",
  });
}

export function userStateConflict() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    code: "user_state_conflict",
    message: "User cannot be changed in its current state",
  });
}

export function photoUnavailable() {
  return new ServiceUnavailableException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    code: "photo_unavailable",
    message: "Photo is temporarily unavailable",
  });
}

export function photoNotFound() {
  return new NotFoundException({
    statusCode: HttpStatus.NOT_FOUND,
    code: "photo_not_found",
    message: "Photo not found",
  });
}

export function emptyUpdate() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "empty_update",
    message: "At least one field is required",
  });
}

export function emailTaken() {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    code: "email_taken",
    message: "Email is already in use",
  });
}

export function unsupportedPhotoType() {
  return new UnsupportedMediaTypeException({
    statusCode: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    code: "unsupported_media_type",
    message: "Only JPEG, PNG and WebP images are accepted",
  });
}

export function invalidPhoto() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "invalid_photo",
    message: "Image is corrupted, animated, has unsupported dimensions or is too large",
  });
}

export function photoRequired() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "photo_required",
    message: 'Exactly one file in the field "file" is required',
  });
}
