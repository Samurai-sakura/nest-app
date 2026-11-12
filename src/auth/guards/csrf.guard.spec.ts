import { ExecutionContext, ForbiddenException, Logger } from "@nestjs/common";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));

import { CsrfGuard } from "./csrf.guard";

const env: Record<string, string> = {
  APP_URL: "https://api.example.com",
  FRONTEND_ORIGIN: "https://app.example.com",
};
const config = {
  get: (key: string) => env[key],
  getOrThrow: (key: string) => env[key],
};

function contextFor(method: string, headers: Record<string, string> = {}) {
  const request = { method, path: "/auth/login", headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function rejection(method: string, headers: Record<string, string>) {
  try {
    new CsrfGuard(config as any).canActivate(contextFor(method, headers));
  } catch (error) {
    return error as ForbiddenException;
  }
  return null;
}

describe("CsrfGuard", () => {
  let warn: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => warn.mockClear());

  it.each(["GET", "HEAD", "OPTIONS"])("lets a %s request from any origin through", (method) => {
    expect(rejection(method, { origin: "https://evil.example" })).toBeNull();
  });

  it("lets a request without Origin through", () => {
    expect(rejection("POST", {})).toBeNull();
  });

  it("lets a same-origin request through without the header", () => {
    expect(rejection("POST", { origin: "https://api.example.com" })).toBeNull();
  });

  it("lets the trusted frontend through with X-CSRF-Protection: 1", () => {
    expect(
      rejection("POST", {
        origin: "https://app.example.com",
        "x-csrf-protection": "1",
      }),
    ).toBeNull();
  });

  it.each([
    ["the trusted frontend without the header", { origin: "https://app.example.com" }],
    [
      "the trusted frontend with a wrong header value",
      { origin: "https://app.example.com", "x-csrf-protection": "true" },
    ],
    [
      "another origin even with the header",
      { origin: "https://evil.example", "x-csrf-protection": "1" },
    ],
    ["a null origin", { origin: "null", "x-csrf-protection": "1" }],
    [
      "another port of the frontend host",
      { origin: "https://app.example.com:8443", "x-csrf-protection": "1" },
    ],
  ])("rejects %s", (_case, headers) => {
    const error = rejection("POST", headers);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error!.getResponse()).toEqual({
      statusCode: 403,
      code: "csrf_rejected",
      message: "Cross-origin request rejected",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=csrf_rejected route=POST /auth/login"),
    );
  });

  it.each(["PUT", "PATCH", "DELETE"])("checks %s like POST", (method) => {
    expect(rejection(method, { origin: "https://evil.example" })).toBeInstanceOf(
      ForbiddenException,
    );
  });
});
