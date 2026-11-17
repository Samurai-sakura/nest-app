import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ConfirmRegistrationDto } from "./confirm-registration.dto";

const attemptId = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";

async function errorsFor(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(ConfirmRegistrationDto, body));
  return errors.map((e) => e.property);
}

describe("ConfirmRegistrationDto", () => {
  it("accepts attemptId with a code", async () => {
    expect(await errorsFor({ attemptId, code: "123456" })).toEqual([]);
  });

  it("accepts a token", async () => {
    expect(await errorsFor({ token: "some-token" })).toEqual([]);
  });

  it("rejects an empty body", async () => {
    expect(await errorsFor({})).toEqual(
      expect.arrayContaining(["attemptId", "code", "token"]),
    );
  });

  it("rejects a code without attemptId", async () => {
    expect(await errorsFor({ code: "123456" })).toContain("attemptId");
  });

  it("rejects attemptId without a code", async () => {
    expect(await errorsFor({ attemptId })).toContain("code");
  });

  it.each(["12345", "1234567", "12345a"])("rejects code %s", async (code) => {
    expect(await errorsFor({ attemptId, code })).toContain("code");
  });

  it("rejects attemptId that is not a UUID", async () => {
    expect(
      await errorsFor({ attemptId: "attempt-1", code: "123456" }),
    ).toContain("attemptId");
  });

  it.each([
    ["a number", 123],
    ["null", null],
    ["an empty string", ""],
    ["too long", "a".repeat(65)],
  ])("rejects token that is %s", async (_case, token) => {
    expect(await errorsFor({ token })).toContain("token");
  });

  it("still validates a token sent together with OTP fields", async () => {
    expect(await errorsFor({ attemptId, code: "123456", token: 123 })).toContain(
      "token",
    );
  });
});
