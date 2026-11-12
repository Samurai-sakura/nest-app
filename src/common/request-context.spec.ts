import { ConsoleLogger } from "@nestjs/common";
import {
  RequestAwareLogger,
  currentRequestId,
  requestIdMiddleware,
} from "./request-context";

function handle(incoming?: string) {
  const headers: Record<string, string> = {};
  const req = { header: () => incoming } as any;
  const res = { setHeader: (name: string, value: string) => (headers[name] = value) } as any;
  let seen: string | undefined;
  requestIdMiddleware(req, res, () => {
    seen = currentRequestId();
  });
  return { header: headers["X-Request-Id"], seen };
}

describe("requestIdMiddleware", () => {
  it("generates an id, returns it in the header and keeps it for the request", () => {
    const { header, seen } = handle();

    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toBe(header);
  });

  it("reuses a well-formed incoming id", () => {
    expect(handle("trace-123.ab_C").header).toBe("trace-123.ab_C");
  });

  it.each([
    ["a line break", "abc\nLogin succeeded userId=admin"],
    ["spaces", "abc def"],
    ["a too long value", "a".repeat(65)],
    ["an empty value", ""],
  ])("replaces an incoming id with %s", (_case, incoming) => {
    const { header } = handle(incoming);

    expect(header).not.toBe(incoming);
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("has no id outside a request", () => {
    expect(currentRequestId()).toBeUndefined();
  });
});

describe("RequestAwareLogger", () => {
  let written: jest.SpyInstance;

  beforeEach(() => {
    written = jest.spyOn(ConsoleLogger.prototype, "warn").mockImplementation();
  });

  afterEach(() => written.mockRestore());

  it("appends the request id to messages written during a request", () => {
    const logger = new RequestAwareLogger();
    const req = { header: () => "req-1" } as any;
    const res = { setHeader: jest.fn() } as any;

    requestIdMiddleware(req, res, () => logger.warn("Login failed reason=wrong_password", "LoginService"));

    expect(written).toHaveBeenCalledWith(
      "Login failed reason=wrong_password requestId=req-1",
      "LoginService",
    );
  });

  it("leaves messages outside a request unchanged", () => {
    new RequestAwareLogger().warn("Starting", "Bootstrap");

    expect(written).toHaveBeenCalledWith("Starting", "Bootstrap");
  });
});
