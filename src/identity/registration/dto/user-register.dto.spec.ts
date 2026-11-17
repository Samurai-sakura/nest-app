import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRegisterDto } from "./user-register.dto";

async function errorsFor(body: Record<string, unknown>) {
  const dto = plainToInstance(UserRegisterDto, body);
  const errors = await validate(dto);
  return { dto, fields: errors.map((e) => e.property) };
}

describe("UserRegisterDto", () => {
  it("accepts a valid email and password", async () => {
    const { fields } = await errorsFor({
      email: "abc@gmail.com",
      password: "Passw0rd",
    });
    expect(fields).toEqual([]);
  });

  it("trims and lowercases email", async () => {
    const { dto, fields } = await errorsFor({
      email: "  ABC@Gmail.COM ",
      password: "Passw0rd",
    });
    expect(fields).toEqual([]);
    expect(dto.email).toBe("abc@gmail.com");
  });

  it("keeps plus-tag as a separate address", async () => {
    const { dto } = await errorsFor({
      email: "user+tag@example.com",
      password: "Passw0rd",
    });
    expect(dto.email).toBe("user+tag@example.com");
  });

  it("rejects invalid email", async () => {
    const { fields } = await errorsFor({
      email: "not-an-email",
      password: "Passw0rd",
    });
    expect(fields).toContain("email");
  });

  it.each([
    ["shorter than 8 chars", "Pass0rd"],
    ["without a digit", "Password"],
    ["without a letter", "12345678"],
    ["longer than 128 chars", "a1".repeat(65)],
  ])("rejects password %s", async (_case, password) => {
    const { fields } = await errorsFor({ email: "abc@gmail.com", password });
    expect(fields).toContain("password");
  });

  it("accepts letters of any alphabet", async () => {
    const { fields } = await errorsFor({
      email: "abc@gmail.com",
      password: "пароль123",
    });
    expect(fields).toEqual([]);
  });

  it("keeps leading and trailing spaces in password", async () => {
    const { dto } = await errorsFor({
      email: "abc@gmail.com",
      password: "  Passw0rd  ",
    });
    expect(dto.password).toBe("  Passw0rd  ");
  });
});
