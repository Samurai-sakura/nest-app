import { INestApplication, Logger } from "@nestjs/common";
import { RouteConfigurationService } from "../src/access-control/authorization/services/route-configuration.service";
import { createTestApp } from "./helpers/create-test-app";

// ловит маршрут приложения, которому забыли поставить @Public() или @RequirePermission()
describe("Route configuration (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    for (const level of ["log", "warn", "error"] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it("declares every route of the application", () => {
    const routes = app.get(RouteConfigurationService);

    expect(routes.invalidRoutes).toEqual([]);
    expect(routes.ready).toBe(true);
  });
});
