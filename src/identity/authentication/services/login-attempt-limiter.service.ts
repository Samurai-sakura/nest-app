import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";

export const MAX_FAILED_LOGINS = 5;
export const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class LoginAttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  private lastSweep = Date.now();

  public isBlocked(email: string, ip: string) {
    return this.recent(this.key(email, ip)).length >= MAX_FAILED_LOGINS;
  }

  public recordFailure(email: string, ip: string) {
    const key = this.key(email, ip);
    this.failures.set(key, [...this.recent(key), Date.now()]);
  }

  public reset(email: string, ip: string) {
    this.failures.delete(this.key(email, ip));
  }

  private recent(key: string) {
    this.sweep();
    const since = Date.now() - FAILED_LOGIN_WINDOW_MS;
    const recent = (this.failures.get(key) ?? []).filter((at) => at > since);
    if (recent.length === 0) {
      this.failures.delete(key);
    }
    return recent;
  }

  private sweep() {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [key, times] of this.failures) {
      if (times.every((at) => at <= now - FAILED_LOGIN_WINDOW_MS)) {
        this.failures.delete(key);
      }
    }
  }

  private key(email: string, ip: string) {
    return createHash("sha256").update(`${email}\n${ip}`).digest("hex");
  }
}
