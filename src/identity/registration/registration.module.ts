import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "../../users/entities/user.entity";
import { RegistrationConfirmation } from "./entities/registration-confirmation.entity";
import { MailModule } from "../../mail/mail.module";
import { RegistrationService } from "./services/registration.service";
import { RegistrationController } from "./registration.controller";

@Module({
  imports: [TypeOrmModule.forFeature([User, RegistrationConfirmation]), MailModule],
  controllers: [RegistrationController],
  providers: [RegistrationService],
})
export class RegistrationModule {}
