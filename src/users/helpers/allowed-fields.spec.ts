import { HttpException } from "@nestjs/common";
import { checkAllowedFields } from "./allowed-fields";

function rejection(body: unknown) {
  try {
    checkAllowedFields(body);
  } catch (error) {
    return error as HttpException;
  }
  return null;
}

describe("checkAllowedFields", () => {
  it.each([
    ["one field", { displayName: "Alex" }],
    ["null displayName", { displayName: null }],
    ["all three fields", { displayName: "Alex", email: "a@gmail.com", status: "active" }],
  ])("accepts %s", (_case, body) => {
    expect(rejection(body)).toBeNull();
  });

  it.each([
    ["a string", "displayName"],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an empty array", []],
    ["an array of keys", ["displayName"]],
  ])("rejects %s as invalid_body", (_case, body) => {
    const error = rejection(body);

    expect(error!.getStatus()).toBe(400);
    expect(error!.getResponse()).toMatchObject({ code: "invalid_body" });
  });

  it("rejects an empty object as empty_update", () => {
    expect(rejection({})!.getResponse()).toEqual({
      statusCode: 400,
      code: "empty_update",
      message: "At least one field is required",
    });
  });

  it.each(["id", "photoUrl", "createdAt", "updatedAt", "password", "passwordHash", "roles", "photoKey"])(
    "rejects the forbidden field %s next to an allowed one",
    (field) => {
      const error = rejection({ displayName: "Alex", [field]: "x" });

      expect(error!.getStatus()).toBe(400);
      expect(error!.getResponse()).toMatchObject({ code: "unknown_field" });
    },
  );

  it("lists every unknown field without the values", () => {
    const response = rejection({ id: "secret-id", password: "Passw0rd" })!.getResponse() as {
      message: string;
    };

    expect(response.message).toBe("Unknown fields: id, password");
    expect(response.message).not.toContain("Passw0rd");
  });
});
