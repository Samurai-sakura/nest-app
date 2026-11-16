import { Controller, Get, Logger, Post } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));

import { Public } from "./decorators/public.decorator";
import { RequirePermission } from "./decorators/require-permission.decorator";
import { RouteConfigurationService } from "./route-configuration.service";

@Public()
@Controller("health")
class HealthController {
  @Get("live")
  live() {}
}

@Controller("/reports/")
class ReportsController {
  @Get(":id")
  @RequirePermission("reports", "read")
  read() {}

  @Post()
  create() {}

  @Get(["export", "export.csv"])
  @Public()
  @RequirePermission("reports", "export")
  export() {}

  // не маршрут: декларация не нужна
  helper() {}
}

async function check(...controllers: (new () => unknown)[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers,
    providers: [RouteConfigurationService],
  }).compile();
  await moduleRef.init();
  return moduleRef.get(RouteConfigurationService);
}

describe("RouteConfigurationService", () => {
  let error: jest.SpyInstance;

  beforeAll(() => {
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => error.mockClear());

  it("is ready when every route is declared", async () => {
    const service = await check(HealthController);

    expect(service.ready).toBe(true);
    expect(service.invalidRoutes).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("finds undeclared and conflicting routes and logs each of them", async () => {
    const service = await check(HealthController, ReportsController);

    expect(service.ready).toBe(false);
    expect(service.invalidRoutes).toEqual([
      { route: "POST /reports", reason: "route has no authorization declaration" },
      {
        route: "GET /reports/export",
        reason: "public route also declares a permission or a receipt",
      },
    ]);
    expect(error).toHaveBeenCalledWith(
      "Route configuration invalid reason=route_configuration route=POST /reports: route has no authorization declaration",
    );
    expect(error).toHaveBeenCalledTimes(2);
  });
});
