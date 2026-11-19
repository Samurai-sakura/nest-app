import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./entities/user.entity";
import { UsersController } from "./controllers/users.controller";
import { UsersService } from "./services/users.service";
import { ProfileReadLimiter } from "./services/profile-read-limiter.service";
import { AuthorizationModule } from "../access-control/authorization/authorization.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    AuthorizationModule,
    StorageModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, ProfileReadLimiter],
})
export class UsersModule {}