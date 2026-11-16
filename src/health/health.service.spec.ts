import { Logger } from "@nestjs/common";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({ InjectDataSource: () => () => undefined }));
jest.mock("../rbac/services/rbac-policy.service", () => ({ RbacPolicyService: class {} }));
jest.mock("../authorization/route-configuration.service", () => ({
  RouteConfigurationService: class {},
}));

import { HealthService } from "./health.service";

describe("HealthService", () => {
  let env: Record<string, string | undefined>;
  let dataSource: { query: jest.Mock };
  let rbac: { checkReady: jest.Mock };
  let routes: { ready: boolean };
  let service: HealthService;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    env = { JWT_ACCESS_SECRET: "access", JWT_REFRESH_SECRET: "refresh" };
    dataSource = { query: jest.fn().mockResolvedValue([{ "?column?": 1 }]) };
    rbac = { checkReady: jest.fn().mockResolvedValue(true) };
    routes = { ready: true };
    service = new HealthService(
      dataSource as any,
      rbac as any,
      routes as any,
      { get: (key: string) => env[key] } as any,
    );
    warn.mockClear();
  });

  it("passes when every check passes", async () => {
    await expect(service.failedChecks()).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports every failed check and logs them", async () => {
    dataSource.query.mockRejectedValue(new Error("connection refused"));
    rbac.checkReady.mockResolvedValue(false);
    routes.ready = false;
    env.JWT_REFRESH_SECRET = "";

    await expect(service.failedChecks()).resolves.toEqual([
      "database",
      "rbac_snapshot",
      "route_configuration",
      "jwt_keys",
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Readiness failed checks=database,rbac_snapshot,route_configuration,jwt_keys",
    );
  });
});
