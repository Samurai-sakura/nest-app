import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import cookieParser from "cookie-parser";
import type { Request } from "express";
import { CSRF_HEADER } from "./auth/guards/csrf.guard";
import { RequestAwareLogger, requestIdMiddleware } from "./common/request-context";

// общая настройка для main.ts и e2e-тестов
export function setupApp(app: INestApplication) {
  const config = app.get(ConfigService);

  app.useLogger(new RequestAwareLogger());
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // точный origin вместо *: с credentials браузер wildcard не принимает.
  // Другим origin не отдаём ни одного CORS-заголовка, включая Allow-Credentials
  const trustedOrigin = config.getOrThrow<string>("FRONTEND_ORIGIN");
  app.enableCors((req: Request, callback) => {
    if (req.headers.origin !== trustedOrigin) {
      return callback(null, { origin: false });
    }
    callback(null, {
      origin: trustedOrigin,
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", CSRF_HEADER],
      maxAge: 600,
    });
  });
}
