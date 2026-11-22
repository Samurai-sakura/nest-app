import { ValidateBy, ValidationOptions, buildMessage } from "class-validator";

export const DISPLAY_NAME_MAX_LENGTH = 80;

const EDGE_WHITESPACE = /^[\s\u0085]+|[\s\u0085]+$/gu;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/u;

export function normalizeDisplayName(value: string) {
  return value.replace(EDGE_WHITESPACE, "").normalize("NFC");
}

export function isValidDisplayName(value: string) {
  const length = [...value].length;
  return length >= 1 && length <= DISPLAY_NAME_MAX_LENGTH && !CONTROL_CHARS.test(value);
}

export function IsDisplayName(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: "isDisplayName",
      validator: {
        validate: (value) => typeof value === "string" && isValidDisplayName(value),
        defaultMessage: buildMessage(
          (prefix) =>
            `${prefix}$property must contain 1 to ${DISPLAY_NAME_MAX_LENGTH} characters without control characters`,
          options,
        ),
      },
    },
    options,
  );
}
