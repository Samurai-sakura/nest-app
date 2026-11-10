import { ExecutionContext, UnauthorizedException } from "@nestjs/common";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("../services/session.service", () => ({ SessionService: class {} }));

import { AccessGuard, AuthenticatedRequest } from "./access.guard";

function contextFor(request: Partial<AuthenticatedRequest>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("AccessGuard", () => {
  let sessionService: { authenticate: jest.Mock };
  let guard: AccessGuard;

  beforeEach(() => {
    sessionService = { authenticate: jest.fn(async () => "user-1") };
    guard = new AccessGuard(sessionService as any);
  });

  it("checks the access_token cookie and stores the user id on the request", async () => {
    const request: Partial<AuthenticatedRequest> = {
      cookies: { access_token: "access-jwt", refresh_token: "refresh-jwt" },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(sessionService.authenticate).toHaveBeenCalledWith("access-jwt");
    expect(request.userId).toBe("user-1");
  });

  it("ignores the Authorization header", async () => {
    const request: Partial<AuthenticatedRequest> = {
      cookies: {},
      headers: { authorization: "Bearer access-jwt" },
    };

    await guard.canActivate(contextFor(request));

    expect(sessionService.authenticate).toHaveBeenCalledWith(undefined);
  });

  it("works without cookie-parser", async () => {
    await guard.canActivate(contextFor({}));

    expect(sessionService.authenticate).toHaveBeenCalledWith(undefined);
  });

  it("lets the rejection through and sets no user id", async () => {
    const request: Partial<AuthenticatedRequest> = { cookies: {} };
    sessionService.authenticate.mockRejectedValue(new UnauthorizedException());

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.userId).toBeUndefined();
  });
});
