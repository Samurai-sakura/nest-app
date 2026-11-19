import { HttpException, HttpStatus, Injectable } from "@nestjs/common";

export type ProfileReadScope = "self" | "foreign";

export const PROFILE_READ_LIMITS: Record<ProfileReadScope, number> = { self: 120, foreign: 60 };
export const PROFILE_READ_WINDOW_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class ProfileReadLimiter {
  private readonly requests = new Map<string, number[]>();
  private lastSweep = Date.now();

  public consume(actorUserId: string, scope: ProfileReadScope) {
    const key = `${actorUserId}:${scope}`;
    const now = Date.now();
    const recent = this.recent(key, now);

    if (recent.length >= PROFILE_READ_LIMITS[scope]) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((recent[0] + PROFILE_READ_WINDOW_MS - now) / 1000),
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: "rate_limited",
          message: `Too many profile requests, retry in ${retryAfterSeconds} seconds`,
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.requests.set(key, recent);
  }

  private recent(key: string, now: number) {
    this.sweep(now);
    const since = now - PROFILE_READ_WINDOW_MS;
    return (this.requests.get(key) ?? []).filter((at) => at > since);
  }

  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [key, times] of this.requests) {
      if (times.every((at) => at <= now - PROFILE_READ_WINDOW_MS)) {
        this.requests.delete(key);
      }
    }
  }
}
