import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { EmailChangeConfirmDto } from "./email-change-confirm.dto";

const challengeId = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";
const secret = "A".repeat(43);
const token = `${challengeId}.${secret}`;

async function errorsFor(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(EmailChangeConfirmDto, body));
  return errors.map((e) => e.property);
}

describe("EmailChangeConfirmDto", () => {
  it("accepts challengeId with a code", async () => {
    expect(await errorsFor({ challengeId, code: "123456" })).toEqual([]);
  });

  it("accepts a token made of challengeId and a 32 byte secret", async () => {
    expect(await errorsFor({ token })).toEqual([]);
    expect(
      await errorsFor({ token: `${challengeId}.${"aZ09_-".repeat(7)}a` }),
    ).toEqual([]);
  });

  it("rejects an empty body", async () => {
    expect(await errorsFor({})).toEqual(
      expect.arrayContaining(["challengeId", "code", "token"]),
    );
  });

  it.each([
    ["challengeId", { challengeId }],
    ["code", { code: "123456" }],
    ["challengeId and code", { challengeId, code: "123456" }],
  ])("rejects a token combined with %s", async (_case, otpFields) => {
    expect(await errorsFor({ token, ...otpFields })).toContain("token");
  });

  it.each([
    ["without a dot", `${challengeId}${secret}`],
    ["with a short secret", `${challengeId}.${"A".repeat(42)}`],
    ["with a long secret", `${challengeId}.${"A".repeat(44)}`],
    ["with a bad challengeId", `not-a-uuid.${secret}`],
    ["with padding", `${challengeId}.${"A".repeat(42)}=`],
    ["that is a number", 123],
    ["that is null", null],
  ])("rejects a token %s", async (_case, value) => {
    expect(await errorsFor({ token: value })).toContain("token");
  });

  it.each(["12345", "1234567", "12345a", " 123456", 123456])(
    "rejects code %p",
    async (code) => {
      expect(await errorsFor({ challengeId, code })).toContain("code");
    },
  );

  it("rejects a code without challengeId", async () => {
    expect(await errorsFor({ code: "123456" })).toContain("challengeId");
  });

  it("rejects challengeId without a code", async () => {
    expect(await errorsFor({ challengeId })).toContain("code");
  });

  it("rejects a challengeId that is not a UUID", async () => {
    expect(
      await errorsFor({ challengeId: "abc", code: "123456" }),
    ).toContain("challengeId");
  });
});
