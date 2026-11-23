import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./entities/user.entity";
import { EmailChangeChallenge } from "./entities/email-change-challenge.entity";
import { UsersController } from "./controllers/users.controller";
import { UsersService } from "./services/users.service";
import { ProfileReadLimiter } from "./services/profile-read-limiter.service";
import { ProfileUpdateLimiter } from "./services/profile-update-limiter.service";
import { AuthorizationModule } from "../access-control/authorization/authorization.module";
import { StorageModule } from "../storage/storage.module";
import { MailModule } from "../mail/mail.module";
import { EmailChangeSendLimiter } from "./services/email-change-send-limiter.service";
import { EmailChangeService } from "./services/email-change.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([User, EmailChangeChallenge]),
    AuthorizationModule,
    StorageModule,
    MailModule,
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    ProfileReadLimiter,
    ProfileUpdateLimiter,
    EmailChangeSendLimiter,
    EmailChangeService,
  ],
})
export class UsersModule {}