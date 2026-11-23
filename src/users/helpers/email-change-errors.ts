import {
  BadRequestException,
  ConflictException,
  HttpStatus,
} from "@nestjs/common";
import type { EmailChangeConsumedReason } from "../entities/email-change-challenge.entity";
import { attemptsExhausted } from "../../identity/confirmation/confirmation-errors";
import { emailTaken } from "./users-errors";

export function emailChangeRejected(reason: "email_taken" | "email_unchanged") {
  if (reason === "email_taken") {
    return emailTaken();
  }
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    code: "email_unchanged",
    message: "New email matches the current one",
  });
}

export function invalidChallenge() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "invalid_challenge",
    message: "Email change challenge is invalid",
  });
}

export function challengeExpired() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "challenge_expired",
    message: "Confirmation code or link has expired, request a new one",
  });
}

export function invalidCode() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "invalid_code",
    message: "Confirmation code or link is invalid",
  });
}

export function lastAttemptFailed() {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    code: "attempts_exhausted",
    message: "Too many invalid codes, request a new email change",
  });
}

export function consumedChallenge(reason: EmailChangeConsumedReason | null) {
  if (reason === "attempts_exhausted") {
    return attemptsExhausted();
  }
  if (reason === "admin_override" || reason === "email_conflict") {
    return new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: reason,
      message: "Email change challenge is no longer valid",
    });
  }
  return invalidChallenge();
}
