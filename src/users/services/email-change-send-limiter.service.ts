import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";

export const EMAIL_CHANGE_SEND_LIMIT = 5;
export const EMAIL_CHANGE_SEND_WINDOW_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class EmailChangeSendLimiter {
  private readonly logger = new Logger(EmailChangeSendLimiter.name);
  private readonly sends = new Map<string, number[]>();
  private lastSweep = Date.now();

  public check(userId: string) {
    const now = Date.now();
    const recent = this.recent(userId, now);

    if (recent.length >= EMAIL_CHANGE_SEND_LIMIT) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((recent[0] + EMAIL_CHANGE_SEND_WINDOW_MS - now) / 1000),
      );
      this.logger.warn(
        `Email change challenge rejected reason=rate_limited userId=${userId} retryAfterSeconds=${retryAfterSeconds}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: "rate_limited",
          message: `Too many email change requests, retry in ${retryAfterSeconds} seconds`,
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  public record(userId: string) {
    const now = Date.now();
    const recent = this.recent(userId, now);
    recent.push(now);
    this.sends.set(userId, recent);
  }

  private recent(key: string, now: number) {
    this.sweep(now);
    const since = now - EMAIL_CHANGE_SEND_WINDOW_MS;
    return (this.sends.get(key) ?? []).filter((at) => at > since);
  }

  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [key, times] of this.sends) {
      if (times.every((at) => at <= now - EMAIL_CHANGE_SEND_WINDOW_MS)) {
        this.sends.delete(key);
      }
    }
  }
}
