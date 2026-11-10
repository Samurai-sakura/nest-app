import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ConfirmLoginDto } from "./confirm-login.dto";

const attemptId = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";
const secret = "A".repeat(43);

async function errorsFor(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(ConfirmLoginDto, body));
  return errors.map((e) => e.property);
}

describe("ConfirmLoginDto", () => {
  it("accepts attemptId with a code", async () => {
    expect(await errorsFor({ attemptId, code: "123456" })).toEqual([]);
  });

  it("accepts a token made of attemptId and a 32 byte secret", async () => {
    expect(await errorsFor({ token: `${attemptId}.${secret}` })).toEqual([]);
    expect(
      await errorsFor({ token: `${attemptId}.${"aZ09_-".repeat(7)}a` }),
    ).toEqual([]);
  });

  it("rejects an empty body", async () => {
    expect(await errorsFor({})).toEqual(
      expect.arrayContaining(["attemptId", "code", "token"]),
    );
  });

  it.each([
    ["without a dot", `${attemptId}${secret}`],
    ["with a short secret", `${attemptId}.${"A".repeat(42)}`],
    ["with a long secret", `${attemptId}.${"A".repeat(44)}`],
    ["with a bad attemptId", `not-a-uuid.${secret}`],
    ["with padding", `${attemptId}.${"A".repeat(42)}=`],
    ["that is a number", 123],
  ])("rejects a token %s", async (_case, token) => {
    expect(await errorsFor({ token })).toContain("token");
  });

  it.each(["12345", "1234567", "12345a"])("rejects code %s", async (code) => {
    expect(await errorsFor({ attemptId, code })).toContain("code");
  });

  it("rejects a code without attemptId", async () => {
    expect(await errorsFor({ code: "123456" })).toContain("attemptId");
  });
});
