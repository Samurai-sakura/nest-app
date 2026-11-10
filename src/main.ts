import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { existsSync } from "fs";
import { validateEnv } from "./config/env.validation";
import { setupApp } from "./app.setup";

async function bootstrap() {
  // не через validate в ConfigModule: тогда ConfigService читает снимок
  // со старта и не видит process.env, который меняют e2e-тесты
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  validateEnv(process.env);

  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Backend API')
    .setVersion('1.0')
    .addTag("Register", "Регистрация и подтверждение почты")
    .addTag("Authentication", "Вход, подтверждение входа, refresh и выход")
    .addCookieAuth("access_token")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  setupApp(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
