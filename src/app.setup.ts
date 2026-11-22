import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { Request } from "express";
import { CSRF_HEADER } from "./access-control/authorization/services/csrf-policy.service";
import { RequestAwareLogger, requestIdMiddleware } from "./common/request-context";

export function setupApp(app: INestApplication) {
  const config = app.get(ConfigService);

  app.useLogger(new RequestAwareLogger());
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  (app as NestExpressApplication).useBodyParser("json", {
    verify: (req: Request & { rawBody?: Buffer }, _res, buffer: Buffer) => {
      req.rawBody = buffer;
    },
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

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
