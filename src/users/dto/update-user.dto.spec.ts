import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateUserDto } from "./update-user.dto";

async function errorsFor(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdateUserDto, body);
  const errors = await validate(dto);
  return { dto, fields: errors.map((e) => e.property) };
}

describe("UpdateUserDto", () => {
  it("normalizes displayName", async () => {
    const { dto, fields } = await errorsFor({ displayName: "  é  " });
    expect(fields).toEqual([]);
    expect(dto.displayName).toBe("é");
  });

  it("accepts null displayName", async () => {
    const { dto, fields } = await errorsFor({ displayName: null });
    expect(fields).toEqual([]);
    expect(dto.displayName).toBeNull();
  });

  it.each([
    ["whitespace only", "   "],
    ["too long", "a".repeat(81)],
    ["control char", "a\u0001"],
    ["not a string", 42],
  ])("rejects displayName %s", async (_case, displayName) => {
    const { fields } = await errorsFor({ displayName });
    expect(fields).toContain("displayName");
  });

  it("trims and lowercases email, keeping plus-tag", async () => {
    const { dto, fields } = await errorsFor({ email: "  User+Tag@Example.COM " });
    expect(fields).toEqual([]);
    expect(dto.email).toBe("user+tag@example.com");
  });

  it.each([
    ["null", null],
    ["invalid", "not-an-email"],
    ["longer than 254", `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`],
  ])("rejects email %s", async (_case, email) => {
    const { fields } = await errorsFor({ email });
    expect(fields).toContain("email");
  });

  it.each(["active", "blocked"])("accepts status %s", async (status) => {
    const { fields } = await errorsFor({ status });
    expect(fields).toEqual([]);
  });

  it.each([null, "pending", "deleting", "deleted", "ACTIVE"])(
    "rejects status %s",
    async (status) => {
      const { fields } = await errorsFor({ status });
      expect(fields).toContain("status");
    },
  );

  it("leaves absent fields undefined", async () => {
    const { dto, fields } = await errorsFor({ displayName: "Alex" });
    expect(fields).toEqual([]);
    expect(dto.email).toBeUndefined();
    expect(dto.status).toBeUndefined();
  });
});
