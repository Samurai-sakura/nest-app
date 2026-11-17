import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;
const ALGORITHM = "HS256";

export type TokenUse = "access" | "refresh";

export type TokenFailure =
  | "missing"
  | "malformed"
  | "signature"
  | "expired"
  | "claims"
  | "token_use";

export type TokenCheck =
  | { valid: true; userId: string }
  | { valid: false; reason: TokenFailure };

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class TokenService {
  private readonly secrets: Record<TokenUse, string>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: ConfigService) {
    this.secrets = {
      access: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
      refresh: config.getOrThrow<string>("JWT_REFRESH_SECRET"),
    };
    this.issuer = config.getOrThrow<string>("JWT_ISSUER");
    this.audience = config.getOrThrow<string>("JWT_AUDIENCE");
  }

  // обе подписи выполняются до ответа: при ошибке вызывающий код не ставит ни одной cookie
  public signPair(userId: string): TokenPair {
    return {
      accessToken: this.sign(userId, "access", ACCESS_TTL_SECONDS),
      refreshToken: this.sign(userId, "refresh", REFRESH_TTL_SECONDS),
    };
  }

  public verify(token: string | undefined, use: TokenUse): TokenCheck {
    if (!token) {
      return { valid: false, reason: "missing" };
    }

    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded.payload !== "object") {
      return { valid: false, reason: "malformed" };
    }
    if (decoded.header.alg !== ALGORITHM) {
      return { valid: false, reason: "signature" };
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.secrets[use], {
        algorithms: [ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }) as jwt.JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return { valid: false, reason: "expired" };
      }
      if ((error as Error).message === "invalid signature") {
        return { valid: false, reason: "signature" };
      }
      return { valid: false, reason: "claims" };
    }

    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > now + CLOCK_TOLERANCE_SECONDS
    ) {
      return { valid: false, reason: "claims" };
    }
    if (payload.token_use !== use) {
      return { valid: false, reason: "token_use" };
    }

    return { valid: true, userId: payload.sub };
  }

  private sign(userId: string, use: TokenUse, ttlSeconds: number) {
    return jwt.sign({ token_use: use }, this.secrets[use], {
      algorithm: ALGORITHM,
      subject: userId,
      issuer: this.issuer,
      audience: this.audience,
      expiresIn: ttlSeconds,
    });
  }
}
