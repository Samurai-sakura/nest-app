import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { User } from "../entities/user.entity";
import { invalidSession } from "../helpers/auth-errors";
import { TokenPair, TokenService, TokenUse } from "./token.service";

const EVENT: Record<TokenUse, string> = {
  access: "Access rejected",
  refresh: "Refresh failed",
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly tokenService: TokenService,
  ) {}

  // роли из токена не читаются: дальше передаётся только userId
  public async authenticate(accessToken: string | undefined): Promise<string> {
    return this.activeUserId(accessToken, "access");
  }

  // прежний refresh не сохраняется и не отзывается: его копия действует до своего exp
  public async refresh(refreshToken: string | undefined): Promise<TokenPair> {
    const userId = await this.activeUserId(refreshToken, "refresh");

    let tokens: TokenPair;
    try {
      tokens = this.tokenService.signPair(userId);
    } catch (error) {
      this.logger.error(
        `Refresh failed reason=token_signing userId=${userId}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException("Session refresh is temporarily unavailable");
    }

    this.logger.log(`Refresh succeeded userId=${userId}`);
    return tokens;
  }

  private async activeUserId(token: string | undefined, use: TokenUse) {
    const check = this.tokenService.verify(token, use);
    if (!check.valid) {
      this.logger.warn(`${EVENT[use]} reason=${check.reason}`);
      throw invalidSession();
    }

    let user: Pick<User, "id" | "status"> | null;
    try {
      user = await this.userRepository.findOne({
        where: { id: check.userId },
        select: { id: true, status: true },
      });
    } catch (error) {
      this.logger.error(`${EVENT[use]} reason=database: ${(error as Error).message}`);
      throw new ServiceUnavailableException("Session check is temporarily unavailable");
    }

    if (!user || user.status !== "active") {
      this.logger.warn(
        `${EVENT[use]} reason=user_inactive userId=${check.userId} status=${user?.status ?? "missing"}`,
      );
      throw invalidSession();
    }
    return user.id;
  }
}
