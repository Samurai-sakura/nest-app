import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { HttpExceptionFilter } from "./http-exception.filter";

function run(exception: unknown) {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: "POST", path: "/auth/login" }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return { status: response.status.mock.calls[0][0], body: response.json.mock.calls[0][0] };
}

describe("HttpExceptionFilter", () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    warn.mockClear();
    error.mockClear();
  });

  it.each([
    [new BadRequestException("Bad input"), 400, "bad_request"],
    [new ConflictException("Taken"), 409, "conflict"],
    [new ServiceUnavailableException("Down"), 503, "service_unavailable"],
    [new HttpException("Teapot", 418), 418, "error"],
  ])("adds a default code by status to %p", (exception, status, code) => {
    const result = run(exception);

    expect(result.status).toBe(status);
    expect(result.body).toEqual({
      statusCode: status,
      code,
      message: (exception as HttpException).message,
    });
  });

  it("keeps an explicit code and the extra fields of the operation", () => {
    const result = run(
      new ServiceUnavailableException({
        statusCode: 503,
        code: "email_delivery_failed",
        message: "Failed to send confirmation email",
        attemptId: "attempt-1",
      }),
    );

    expect(result.body).toEqual({
      statusCode: 503,
      code: "email_delivery_failed",
      message: "Failed to send confirmation email",
      attemptId: "attempt-1",
    });
  });

  it("drops the Nest error field", () => {
    expect(run(new BadRequestException("x")).body).not.toHaveProperty("error");
  });

  it("marks ValidationPipe errors and logs the details", () => {
    const result = run(
      new BadRequestException(["email must be an email", "password should not be empty"]),
    );

    expect(result.body).toEqual({
      statusCode: 400,
      code: "validation_failed",
      message: ["email must be an email", "password should not be empty"],
    });
    expect(warn).toHaveBeenCalledWith(
      "Request rejected reason=validation route=POST /auth/login details=email must be an email; password should not be empty",
    );
  });

  it("does not log a 400 thrown by a service", () => {
    run(new BadRequestException("Invalid or expired confirmation code"));

    expect(warn).not.toHaveBeenCalled();
  });

  it("marks and logs the throttler", () => {
    const result = run(new ThrottlerException());

    expect(result.status).toBe(429);
    expect(result.body.code).toBe("rate_limited");
    expect(warn).toHaveBeenCalledWith("Request rejected reason=rate_limit route=POST /auth/login");
  });

  it("hides an unexpected error behind a generic 500", () => {
    const result = run(new Error("column users.secret does not exist"));

    expect(result).toEqual({
      status: 500,
      body: { statusCode: 500, code: "internal_error", message: "Internal server error" },
    });
    expect(error.mock.calls[0][0]).toContain("column users.secret does not exist");
  });
});
