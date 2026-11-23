import {
  attemptsExhausted,
  emailDeliveryFailed,
  invalidConfirmation,
  resendTooEarly,
} from "./confirmation-errors";

describe("confirmation-errors", () => {
  it.each([
    ["invalidConfirmation", invalidConfirmation(), 400, "invalid_confirmation"],
    ["attemptsExhausted", attemptsExhausted(), 429, "attempts_exhausted"],
    ["emailDeliveryFailed", emailDeliveryFailed(), 503, "email_delivery_failed"],
  ])("%s returns its status and code", (_name, error, status, code) => {
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toMatchObject({ statusCode: status, code });
  });

  it("returns 429 with retryAfterSeconds for an early resend", () => {
    const error = resendTooEarly(42);

    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      code: "resend_too_early",
      retryAfterSeconds: 42,
    });
  });

  it("adds safe retry details to a delivery failure", () => {
    const error = emailDeliveryFailed({ method: "otp", retryAfterSeconds: 60 });

    expect(error.getResponse()).toEqual({
      statusCode: 503,
      code: "email_delivery_failed",
      message: "Failed to send confirmation email",
      method: "otp",
      retryAfterSeconds: 60,
    });
  });
});
