import { HttpException } from "@nestjs/common";
import { assertNoDuplicateKeys, findDuplicateKey } from "./duplicate-json-keys";

describe("findDuplicateKey", () => {
  it.each([
    ["distinct keys", '{"displayName":"a","email":"b@c.d"}'],
    ["an empty object", "{}"],
    ["the same key in sibling objects", '[{"a":1},{"a":2}]'],
    ["the same key at different depths", '{"a":{"a":1}}'],
    ["a key-like string value", '{"a":"b","c":"a"}'],
    ["an escaped quote inside a value", '{"a":"x\\"a\\":1","b":2}'],
    ["strings in arrays", '{"a":["a","a"]}'],
    ["a top-level string", '"a"'],
  ])("finds nothing for %s", (_case, json) => {
    expect(findDuplicateKey(json)).toBeNull();
  });

  it.each([
    ["a repeated key", '{"displayName":"a","displayName":"b"}', "displayName"],
    ["whitespace before the colon", '{"a":1, "a" :2}', "a"],
    ["an escaped spelling of the same key", '{"a":1,"\\u0061":2}', "a"],
    ["a repeat inside a nested object", '{"x":{"b":1,"b":2}}', "b"],
    ["a repeat after a nested object", '{"a":{"b":1},"a":2}', "a"],
  ])("finds %s", (_case, json, key) => {
    expect(findDuplicateKey(json)).toBe(key);
  });

  it("leaves malformed JSON to the parser", () => {
    expect(findDuplicateKey('{"a":1,"a')).toBeNull();
  });
});

describe("assertNoDuplicateKeys", () => {
  it("passes a body without repeats and a missing raw body", () => {
    expect(() => assertNoDuplicateKeys(Buffer.from('{"a":1}'))).not.toThrow();
    expect(() => assertNoDuplicateKeys(undefined)).not.toThrow();
  });

  it("answers 400 duplicate_field without the key or the values", () => {
    let error: HttpException | undefined;
    try {
      assertNoDuplicateKeys(Buffer.from('{"displayName":"secret","displayName":"b"}'));
    } catch (caught) {
      error = caught as HttpException;
    }

    expect(error!.getStatus()).toBe(400);
    expect(error!.getResponse()).toEqual({
      statusCode: 400,
      code: "duplicate_field",
      message: "Request body contains a repeated field",
    });
  });
});
