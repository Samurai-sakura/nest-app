import { Module } from '@nestjs/common';
import { AuthService } from './services/auth.service';
import { AuthController } from './auth.controller';
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./entities/user.entity";
import { RegistrationConfirmation } from "./entities/registration-confirmation.entity";
import { LoginChallenge } from "./entities/login-challenge.entity";
import { MailModule } from "../mail/mail.module";
import { TokenService } from "./services/token.service";
import { LoginService } from "./services/login.service";
import { LoginAttemptLimiter } from "./services/login-attempt-limiter.service";
import { LoginChallengeService } from "./services/login-challenge.service";
import { LoginController } from "./login.controller";
import { SessionService } from "./services/session.service";
import { SessionController } from "./session.controller";
import { AccessGuard } from "./guards/access.guard";
import { CsrfGuard } from "./guards/csrf.guard";
import { APP_GUARD } from "@nestjs/core";

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RegistrationConfirmation, LoginChallenge]),
    MailModule,
  ],
  controllers: [AuthController, LoginController, SessionController],
  providers: [
    AuthService,
    TokenService,
    LoginService,
    LoginAttemptLimiter,
    LoginChallengeService,
    SessionService,
    AccessGuard,
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [TokenService, SessionService, AccessGuard],
})
export class AuthModule {}
