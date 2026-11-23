import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerModule } from "@nestjs/throttler";
import { RegistrationModule } from "./identity/registration/registration.module";
import { AuthenticationModule } from "./identity/authentication/authentication.module";
import { RbacModule } from "./access-control/rbac/rbac.module";
import { AuthorizationModule } from "./access-control/authorization/authorization.module";
import { HealthModule } from "./health/health.module";
import { APP_FILTER } from "@nestjs/core";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { UsersModule } from "./users/users.module";
import { ScheduleModule } from "@nestjs/schedule";

@Module({
  imports: [
    RegistrationModule,
    AuthenticationModule,
    UsersModule,
    RbacModule,
    AuthorizationModule,
    HealthModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: "default",
          ttl: Number(config.getOrThrow("REGISTRATION_RATE_TTL_SECONDS")) * 1000,
          limit: Number(config.getOrThrow("REGISTRATION_RATE_LIMIT")),
        },
      ],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        host: config.get("DB_HOST"),
        port: Number(config.get("POSTGRES_PORT")),
        username: config.get("POSTGRES_USER"),
        password: config.get("POSTGRES_PASSWORD"),
        database: config.get("POSTGRES_DB"),
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule {}
