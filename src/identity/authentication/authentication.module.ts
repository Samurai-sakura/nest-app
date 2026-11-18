import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "../../users/entities/user.entity";
import { LoginChallenge } from "./entities/login-challenge.entity";
import { MailModule } from "../../mail/mail.module";
import { TokenService } from "./services/token.service";
import { LoginService } from "./services/login.service";
import { LoginAttemptLimiter } from "./services/login-attempt-limiter.service";
import { LoginChallengeService } from "./services/login-challenge.service";
import { LoginController } from "./controllers/login.controller";
import { SessionService } from "./services/session.service";
import { SessionController } from "./controllers/session.controller";

@Module({
  imports: [TypeOrmModule.forFeature([User, LoginChallenge]), MailModule],
  controllers: [LoginController, SessionController],
  providers: [
    TokenService,
    LoginService,
    LoginAttemptLimiter,
    LoginChallengeService,
    SessionService,
  ],
  exports: [TokenService, SessionService],
})
export class AuthenticationModule {}
