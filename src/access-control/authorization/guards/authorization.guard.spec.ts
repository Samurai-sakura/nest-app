import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("../../../identity/authentication/services/session.service", () => ({ SessionService: class {} }));
jest.mock("../../rbac/services/rbac-policy.service", () => ({ RbacPolicyService: class {} }));

import { AuthenticatedRequest, AuthorizationGuard } from "./authorization.guard";
import { Public } from "../decorators/public.decorator";
import { Receipt } from "../decorators/receipt.decorator";
import { RequirePermission } from "../decorators/require-permission.decorator";

@Controller()
class RoutesController {
  @Public()
  open() {}

  @RequirePermission("reports", "read")
  protectedRoute() {}

  @RequirePermission("users", "delete", { audit: true })
  criticalRoute() {}

  @Receipt("Deletion-Receipt")
  receiptOnly() {}

  @Receipt("Deletion-Receipt")
  @RequirePermission("users", "delete")
  receiptOrPermission() {}

  forgotten() {}
}

type Route = keyof RoutesController;

function contextFor(route: Route, request: Partial<AuthenticatedRequest>) {
  return {
    getHandler: () => RoutesController.prototype[route],
    getClass: () => RoutesController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error("expected promise to reject");
}

describe("AuthorizationGuard", () => {
  const calls: string[] = [];
  let sessionService: { authenticate: jest.Mock };
  let csrfPolicy: { check: jest.Mock };
  let rbac: { authorize: jest.Mock };
  let guard: AuthorizationGuard;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeAll(() => {
    log = jest.spyOn(Logger.prototype, "log").mockImplementation();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    calls.length = 0;
    sessionService = {
      authenticate: jest.fn(async () => {
        calls.push("access");
        return "user-1";
      }),
    };
    csrfPolicy = { check: jest.fn(() => calls.push("csrf")) };
    rbac = {
      authorize: jest.fn(async () => {
        calls.push("rbac");
        return { allowed: true, version: 3 };
      }),
    };
    guard = new AuthorizationGuard(
      new Reflector(),
      sessionService as any,
      csrfPolicy as any,
      rbac as any,
    );
    warn.mockClear();
    error.mockClear();
    log.mockClear();
  });

  const request = (overrides: Partial<AuthenticatedRequest> = {}) =>
    ({
      method: "POST",
      path: "/reports",
      headers: {},
      cookies: { access_token: "access-jwt" },
      ...overrides,
    }) as Partial<AuthenticatedRequest>;

  describe("protected route", () => {
    it("checks access, then CSRF, then RBAC and stores the user id", async () => {
      const req = request();

      await expect(guard.canActivate(contextFor("protectedRoute", req))).resolves.toBe(true);

      expect(calls).toEqual(["access", "csrf", "rbac"]);
      expect(sessionService.authenticate).toHaveBeenCalledWith("access-jwt");
      expect(rbac.authorize).toHaveBeenCalledWith("user-1", "reports", "read");
      expect(req.userId).toBe("user-1");
    });

    it("reads the token only from the cookie", async () => {
      await guard.canActivate(
        contextFor(
          "protectedRoute",
          request({ cookies: {}, headers: { authorization: "Bearer access-jwt" } }),
        ),
      );

      expect(sessionService.authenticate).toHaveBeenCalledWith(undefined);
    });

    it("works without cookie-parser", async () => {
      await guard.canActivate(contextFor("protectedRoute", request({ cookies: undefined })));

      expect(sessionService.authenticate).toHaveBeenCalledWith(undefined);
    });

    it("stops at 401 before CSRF and RBAC", async () => {
      const req = request();
      sessionService.authenticate.mockRejectedValue(new UnauthorizedException());

      await expect(guard.canActivate(contextFor("protectedRoute", req))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(csrfPolicy.check).not.toHaveBeenCalled();
      expect(rbac.authorize).not.toHaveBeenCalled();
      expect(req.userId).toBeUndefined();
    });

    it("stops at a CSRF rejection before RBAC", async () => {
      csrfPolicy.check.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(
        guard.canActivate(contextFor("protectedRoute", request())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rbac.authorize).not.toHaveBeenCalled();
    });

    it("returns permission_denied and logs the server requirement", async () => {
      const req = request();
      rbac.authorize.mockResolvedValue({ allowed: false, version: 3 });

      expect(await errorOf(guard.canActivate(contextFor("protectedRoute", req)))).toEqual({
        status: 403,
        body: { statusCode: 403, code: "permission_denied", message: "Permission denied" },
      });
      expect(warn).toHaveBeenCalledWith(
        "Request rejected reason=permission_denied actorUserId=user-1 operation=RoutesController.protectedRoute route=POST /reports required=reports@read policyVersion=3",
      );
      expect(req.userId).toBeUndefined();
    });

    it("logs a granted critical operation", async () => {
      await guard.canActivate(contextFor("criticalRoute", request()));

      expect(rbac.authorize).toHaveBeenCalledWith("user-1", "users", "delete");
      expect(log).toHaveBeenCalledWith(
        "Access granted actorUserId=user-1 operation=RoutesController.criticalRoute route=POST /reports required=users@delete policyVersion=3",
      );
    });

    it("does not log a granted ordinary operation", async () => {
      await guard.canActivate(contextFor("protectedRoute", request()));

      expect(log).not.toHaveBeenCalled();
    });

    it("lets an RBAC failure through", async () => {
      rbac.authorize.mockRejectedValue(new HttpException("unavailable", 503));

      expect(
        (await errorOf(guard.canActivate(contextFor("protectedRoute", request())))).status,
      ).toBe(503);
    });
  });

  describe("public route", () => {
    it("skips access and RBAC but checks CSRF", async () => {
      await expect(
        guard.canActivate(contextFor("open", request({ cookies: { access_token: "garbage" } }))),
      ).resolves.toBe(true);

      expect(calls).toEqual(["csrf"]);
    });
  });

  describe("receipt route", () => {
    const withReceipt = request({ cookies: {}, headers: { "deletion-receipt": "receipt" } });

    it.each(["receiptOnly", "receiptOrPermission"] as const)(
      "lets %s through to the handler when the header is present",
      async (route) => {
        await expect(guard.canActivate(contextFor(route, withReceipt))).resolves.toBe(true);

        expect(calls).toEqual(["csrf"]);
      },
    );

    it("uses the normal chain without the header when a pair is declared", async () => {
      await expect(
        guard.canActivate(contextFor("receiptOrPermission", request())),
      ).resolves.toBe(true);

      expect(calls).toEqual(["access", "csrf", "rbac"]);
      expect(rbac.authorize).toHaveBeenCalledWith("user-1", "users", "delete");
    });

    it("returns invalid_session without the header when no pair is declared", async () => {
      expect(await errorOf(guard.canActivate(contextFor("receiptOnly", request())))).toEqual({
        status: 401,
        body: {
          statusCode: 401,
          code: "invalid_session",
          message: "Session is invalid or expired",
        },
      });
      expect(calls).toEqual([]);
    });
  });

  it("closes a route without a declaration with 503", async () => {
    expect(await errorOf(guard.canActivate(contextFor("forgotten", request())))).toEqual({
      status: 503,
      body: {
        statusCode: 503,
        code: "authorization_unavailable",
        message: "Authorization is temporarily unavailable",
      },
    });
    expect(calls).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "Authorization unavailable reason=route_configuration route=POST /reports: route has no authorization declaration",
    );
  });
});
