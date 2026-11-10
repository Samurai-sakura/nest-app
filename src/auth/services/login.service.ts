import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { createHmac, randomBytes } from "crypto";
import * as argon2 from "argon2";
import { UserLoginDto } from "../dto/user-login.dto";
import { User } from "../entities/user.entity";
import { invalidCredentials } from "../helpers/auth-errors";
import { LoginAttemptLimiter } from "./login-attempt-limiter.service";
import { TokenPair, TokenService } from "./token.service";
import {
  LoginChallengeResponse,
  LoginChallengeService,
} from "./login-challenge.service";

export type LoginResult =
  | { tokens: TokenPair }
  | { challenge: LoginChallengeResponse };

@Injectable()
export class LoginService implements OnModuleInit {
  private readonly logger = new Logger(LoginService.name);
  private dummyHash: string;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly config: ConfigService,
    private readonly tokenService: TokenService,
    private readonly limiter: LoginAttemptLimiter,
    private readonly challenges: LoginChallengeService,
  ) {}

  public async onModuleInit() {
    this.dummyHash = await argon2.hash(randomBytes(32).toString("hex"));
  }

  public async login(dto: UserLoginDto, ip: string): Promise<LoginResult> {
    const { email, password } = dto;

    if (this.limiter.isBlocked(email, ip)) {
      this.logger.warn(
        `Login rejected reason=too_many_failures emailRef=${this.emailRef(email)}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: "too_many_attempts",
          message: "Too many failed login attempts",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.findUser(email);
    const passwordMatches = await this.verifyPassword(
      user?.passwordHash ?? this.dummyHash,
      password,
    );

    if (!user || !passwordMatches || user.status !== "active") {
      this.limiter.recordFailure(email, ip);
      this.logFailure(email, user, passwordMatches);
      throw invalidCredentials();
    }

    if (this.config.get("LOGIN_EMAIL_CONFIRMATION_ENABLED") === "true") {
      this.limiter.reset(email, ip);
      this.logger.log(`Login password verified, confirmation required userId=${user.id}`);
      return { challenge: await this.challenges.start(user.id) };
    }

    let tokens: TokenPair;
    try {
      tokens = this.tokenService.signPair(user.id);
    } catch (error) {
      this.logger.error(
        `Login failed reason=token_signing userId=${user.id}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException("Login is temporarily unavailable");
    }

    this.limiter.reset(email, ip);
    this.logger.log(`Login succeeded userId=${user.id}`);
    return { tokens };
  }

  private async findUser(email: string) {
    try {
      return await this.userRepository.findOne({
        where: { email },
        select: { id: true, status: true, passwordHash: true },
      });
    } catch (error) {
      this.logger.error(`Login failed reason=database: ${(error as Error).message}`);
      throw new ServiceUnavailableException("Login is temporarily unavailable");
    }
  }

  private async verifyPassword(hash: string, password: string) {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  private logFailure(email: string, user: User | null, passwordMatches: boolean) {
    if (!user) {
      this.logger.warn(
        `Login failed reason=unknown_email emailRef=${this.emailRef(email)}`,
      );
    } else if (!passwordMatches) {
      this.logger.warn(`Login failed reason=wrong_password userId=${user.id}`);
    } else {
      this.logger.warn(
        `Login failed reason=user_inactive status=${user.status} userId=${user.id}`,
      );
    }
  }

  // необратимый идентификатор: позволяет сопоставлять попытки, не записывая адрес
  private emailRef(email: string) {
    return createHmac("sha256", this.config.getOrThrow<string>("LOG_EMAIL_HMAC_KEY"))
      .update(email)
      .digest("hex")
      .slice(0, 16);
  }
}
