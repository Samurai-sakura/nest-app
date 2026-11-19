import { HttpException } from "@nestjs/common";
import {
  PROFILE_READ_LIMITS,
  PROFILE_READ_WINDOW_MS,
  ProfileReadLimiter,
} from "./profile-read-limiter.service";

describe("ProfileReadLimiter", () => {
  let now: number;
  let limiter: ProfileReadLimiter;
  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    limiter = new ProfileReadLimiter();
  });

  const consumeTimes = (count: number, user = "user-1", scope: "self" | "foreign" = "self") => {
    for (let i = 0; i < count; i++) {
      limiter.consume(user, scope);
    }
  };

  function rejection(user = "user-1", scope: "self" | "foreign" = "self") {
    try {
      limiter.consume(user, scope);
    } catch (error) {
      return error as HttpException;
    }
    return null;
  }

  it.each(["self", "foreign"] as const)("allows exactly the %s limit per minute", (scope) => {
    consumeTimes(PROFILE_READ_LIMITS[scope], "user-1", scope);

    const error = rejection("user-1", scope);

    expect(error!.getStatus()).toBe(429);
    expect(error!.getResponse()).toEqual({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many profile requests, retry in 60 seconds",
      retryAfterSeconds: 60,
    });
  });

  it("counts own and foreign requests separately", () => {
    consumeTimes(PROFILE_READ_LIMITS.foreign, "user-1", "foreign");

    expect(rejection("user-1", "self")).toBeNull();
    expect(rejection("user-1", "foreign")).not.toBeNull();
  });

  it("counts every user separately", () => {
    consumeTimes(PROFILE_READ_LIMITS.self);

    expect(rejection("user-2")).toBeNull();
  });

  it("frees a slot when the oldest request leaves the window", () => {
    consumeTimes(1);
    now += 30_000;
    consumeTimes(PROFILE_READ_LIMITS.self - 1);
    expect(rejection()!.getResponse()).toMatchObject({ retryAfterSeconds: 30 });

    now += 30_001;

    expect(rejection()).toBeNull();
    expect(rejection()).not.toBeNull();
  });

  it("does not count rejected requests", () => {
    consumeTimes(PROFILE_READ_LIMITS.self);
    for (let i = 0; i < 10; i++) {
      rejection();
    }

    now += PROFILE_READ_WINDOW_MS + 1;

    consumeTimes(PROFILE_READ_LIMITS.self);
    expect(rejection()).not.toBeNull();
  });

  it("forgets users without requests in the window", () => {
    consumeTimes(5, "user-1");
    now += PROFILE_READ_WINDOW_MS * 2;

    consumeTimes(1, "user-2");

    expect((limiter as unknown as { requests: Map<string, number[]> }).requests.has("user-1:self")).toBe(false);
  });
});
