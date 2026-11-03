import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [
    AuthModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: "registration",
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
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
