import { LoginAttemptLimiter } from "./login-attempt-limiter.service";

describe("LoginAttemptLimiter", () => {
  let now: number;
  let limiter: LoginAttemptLimiter;

  beforeEach(() => {
    now = Date.UTC(2026, 10, 9);
    jest.spyOn(Date, "now").mockImplementation(() => now);
    limiter = new LoginAttemptLimiter();
  });

  afterEach(() => jest.restoreAllMocks());

  function fail(times: number, email = "abc@gmail.com", ip = "1.1.1.1") {
    for (let i = 0; i < times; i++) {
      limiter.recordFailure(email, ip);
    }
  }

  it("allows four failures and blocks after the fifth", () => {
    fail(4);
    expect(limiter.isBlocked("abc@gmail.com", "1.1.1.1")).toBe(false);

    fail(1);
    expect(limiter.isBlocked("abc@gmail.com", "1.1.1.1")).toBe(true);
  });

  it("counts each email and IP pair separately", () => {
    fail(5);

    expect(limiter.isBlocked("other@gmail.com", "1.1.1.1")).toBe(false);
    expect(limiter.isBlocked("abc@gmail.com", "2.2.2.2")).toBe(false);
  });

  it("forgets failures older than 15 minutes", () => {
    fail(5);

    now += 15 * 60 * 1000 + 1;

    expect(limiter.isBlocked("abc@gmail.com", "1.1.1.1")).toBe(false);
  });

  it("uses a sliding window", () => {
    fail(3);
    now += 10 * 60 * 1000;
    fail(2);
    expect(limiter.isBlocked("abc@gmail.com", "1.1.1.1")).toBe(true);

    now += 5 * 60 * 1000 + 1;

    expect(limiter.isBlocked("abc@gmail.com", "1.1.1.1")).toBe(false);
  });

  it("clears failures on reset", () => {
    fail(5);

    limiter.reset("abc@gmail.com", "1.1.1.1");

    expect(limiter.isBlocked("abc@gmail.com", "1.1.1.1")).toBe(false);
  });

  it("does not keep the email in memory as plain text", () => {
    fail(1);

    const keys = [...(limiter as any).failures.keys()];
    expect(keys.join()).not.toContain("abc@gmail.com");
  });

  it("drops expired entries during a sweep", () => {
    fail(1, "a@gmail.com");
    fail(1, "b@gmail.com");

    now += 16 * 60 * 1000;
    limiter.isBlocked("c@gmail.com", "1.1.1.1");

    expect((limiter as any).failures.size).toBe(0);
  });
});
