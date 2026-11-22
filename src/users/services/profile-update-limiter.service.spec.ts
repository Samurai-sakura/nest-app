import { HttpException } from "@nestjs/common";
import {
  PROFILE_UPDATE_LIMIT,
  PROFILE_UPDATE_WINDOW_MS,
  ProfileUpdateLimiter,
} from "./profile-update-limiter.service";

describe("ProfileUpdateLimiter", () => {
  let now: number;
  let limiter: ProfileUpdateLimiter;
  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    limiter = new ProfileUpdateLimiter();
  });

  const consumeTimes = (count: number, user = "user-1") => {
    for (let i = 0; i < count; i++) {
      limiter.consume(user);
    }
  };

  function rejection(user = "user-1") {
    try {
      limiter.consume(user);
    } catch (error) {
      return error as HttpException;
    }
    return null;
  }

  it("allows exactly 30 changes per hour", () => {
    consumeTimes(PROFILE_UPDATE_LIMIT);

    const error = rejection();

    expect(error!.getStatus()).toBe(429);
    expect(error!.getResponse()).toEqual({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many profile changes, retry in 3600 seconds",
      retryAfterSeconds: 3600,
    });
  });

  it("counts every user separately", () => {
    consumeTimes(PROFILE_UPDATE_LIMIT);

    expect(rejection("user-2")).toBeNull();
  });

  it("frees a slot when the oldest change leaves the window", () => {
    consumeTimes(1);
    now += 30 * 60 * 1000;
    consumeTimes(PROFILE_UPDATE_LIMIT - 1);
    expect(rejection()!.getResponse()).toMatchObject({ retryAfterSeconds: 1800 });

    now += 30 * 60 * 1000 + 1;

    expect(rejection()).toBeNull();
    expect(rejection()).not.toBeNull();
  });

  it("does not count rejected changes", () => {
    consumeTimes(PROFILE_UPDATE_LIMIT);
    for (let i = 0; i < 10; i++) {
      rejection();
    }

    now += PROFILE_UPDATE_WINDOW_MS + 1;

    consumeTimes(PROFILE_UPDATE_LIMIT);
    expect(rejection()).not.toBeNull();
  });

  it("forgets users without changes in the window", () => {
    consumeTimes(5, "user-1");
    now += PROFILE_UPDATE_WINDOW_MS * 2;

    consumeTimes(1, "user-2");

    expect((limiter as unknown as { requests: Map<string, number[]> }).requests.has("user-1")).toBe(false);
  });
});
