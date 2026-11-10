import { INestApplication, ModuleMetadata } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AppModule } from "../../src/app.module";
import { setupApp } from "../../src/app.setup";
import { MailService } from "../../src/mail/mail.service";
import { TEST_DB } from "../setup-env";

interface TestAppOptions {
  mail?: object;
  imports?: ModuleMetadata["imports"];
  controllers?: ModuleMetadata["controllers"];
}

// приложение настраивается так же, как в main.ts; почта подменяется,
// а запуск на любой базе, кроме тестовой, прерывается до первого запроса
export async function createTestApp(options: TestAppOptions = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(MailService)
    .useValue(options.mail ?? {})
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();
  setupApp(app);
  await app.init();

  const db = app.get(DataSource);
  if (db.options.database !== TEST_DB) {
    await app.close();
    throw new Error(`e2e tests must not run on ${db.options.database}`);
  }
  return { app, db };
}
