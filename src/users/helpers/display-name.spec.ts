import { isValidDisplayName, normalizeDisplayName } from "./display-name";

describe("normalizeDisplayName", () => {
  it("trims unicode whitespace on both edges", () => {
    expect(normalizeDisplayName("　  Alex \u0085\n")).toBe("Alex");
  });

  it("keeps inner spaces, case and script", () => {
    expect(normalizeDisplayName("  Иван  Petrov ")).toBe("Иван  Petrov");
  });

  it("composes characters to NFC", () => {
    expect(normalizeDisplayName("é")).toBe("é");
  });

  it("turns whitespace-only input into an empty string", () => {
    expect(normalizeDisplayName(" \t  ")).toBe("");
  });
});

describe("isValidDisplayName", () => {
  it("accepts 1 and 80 code points", () => {
    expect(isValidDisplayName("a")).toBe(true);
    expect(isValidDisplayName("a".repeat(80))).toBe(true);
  });

  it("rejects empty and 81 code points", () => {
    expect(isValidDisplayName("")).toBe(false);
    expect(isValidDisplayName("a".repeat(81))).toBe(false);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(isValidDisplayName("😀".repeat(80))).toBe(true);
    expect(isValidDisplayName("😀".repeat(81))).toBe(false);
  });

  it.each([
    ["NUL", "a\u0000b"],
    ["tab", "a\tb"],
    ["DEL", "a\u007Fb"],
    ["C1 control", "a\u009Fb"],
  ])("rejects %s", (_case, value) => {
    expect(isValidDisplayName(value)).toBe(false);
  });
});
