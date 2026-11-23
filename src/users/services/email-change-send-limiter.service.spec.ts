import { HttpException, Logger } from "@nestjs/common";
import {
  EMAIL_CHANGE_SEND_LIMIT,
  EMAIL_CHANGE_SEND_WINDOW_MS,
  EmailChangeSendLimiter,
} from "./email-change-send-limiter.service";

describe("EmailChangeSendLimiter", () => {
  let now: number;
  let limiter: EmailChangeSendLimiter;
  let warn: jest.SpyInstance;

  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    limiter = new EmailChangeSendLimiter();
  });

  const recordTimes = (count: number, user = "user-1") => {
    for (let i = 0; i < count; i++) {
      limiter.check(user);
      limiter.record(user);
    }
  };

  function rejection(user = "user-1") {
    try {
      limiter.check(user);
    } catch (error) {
      return error as HttpException;
    }
    return null;
  }

  it("allows exactly 5 emails per hour", () => {
    recordTimes(EMAIL_CHANGE_SEND_LIMIT);

    const error = rejection();

    expect(error!.getStatus()).toBe(429);
    expect(error!.getResponse()).toEqual({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many email change requests, retry in 3600 seconds",
      retryAfterSeconds: 3600,
    });
  });

  it("does not spend the limit on a check without a record", () => {
    for (let i = 0; i < EMAIL_CHANGE_SEND_LIMIT * 2; i++) {
      limiter.check("user-1");
    }

    expect(rejection()).toBeNull();
  });

  it("counts every user separately", () => {
    recordTimes(EMAIL_CHANGE_SEND_LIMIT);

    expect(rejection("user-2")).toBeNull();
  });

  it("frees a slot when the oldest email leaves the window", () => {
    recordTimes(1);
    now += 10_000;
    recordTimes(EMAIL_CHANGE_SEND_LIMIT - 1);

    now += EMAIL_CHANGE_SEND_WINDOW_MS - 10_000;
    expect(rejection()).toBeNull();
  });

  it("reports the time until the oldest email leaves the window", () => {
    recordTimes(EMAIL_CHANGE_SEND_LIMIT);
    now += 1_000_000;

    expect(rejection()!.getResponse()).toMatchObject({ retryAfterSeconds: 2600 });
  });

  it("logs the rejection without an address", () => {
    recordTimes(EMAIL_CHANGE_SEND_LIMIT);

    rejection();

    expect(warn).toHaveBeenCalledWith(
      "Email change challenge rejected reason=rate_limited userId=user-1 retryAfterSeconds=3600",
    );
  });
});
