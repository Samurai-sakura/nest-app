import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./entities/user.entity";
import { RegistrationConfirmation } from "./entities/registration-confirmation.entity";
import { MailModule } from "../mail/mail.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RegistrationConfirmation]),
    MailModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
