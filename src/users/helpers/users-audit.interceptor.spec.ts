import {
  ConflictException,
  ExecutionContext,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";
import { UsersAuditInterceptor } from "./users-audit.interceptor";

describe("UsersAuditInterceptor", () => {
  const interceptor = new UsersAuditInterceptor();
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    log = jest.spyOn(Logger.prototype, "log").mockImplementation();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    log.mockClear();
    warn.mockClear();
  });

  function contextFor(handler: string, request: object) {
    const named = { [handler]: () => undefined }[handler];
    return {
      getHandler: () => named,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  const photoRequest = { params: { userId: "user-2" }, userId: "user-1", body: undefined };

  it("logs a photo upload with the photo field before multer parses the body", async () => {
    await firstValueFrom(
      interceptor.intercept(contextFor("setPhoto", photoRequest), { handle: () => of({}) }),
    );

    expect(log.mock.calls[0][0]).toMatch(
      /^User update result=success operation=users\.photo\.update scope=foreign actorUserId=user-1 targetUserId=user-2 fields=photo durationMs=\d+$/,
    );
  });

  it.each([
    [new PayloadTooLargeException("File too large"), "too_large", "payload_too_large"],
    [
      new UnsupportedMediaTypeException({ statusCode: 415, code: "unsupported_media_type" }),
      "unsupported",
      "unsupported_media_type",
    ],
  ])("logs a rejected upload %p as a warning", async (error, result, code) => {
    await expect(
      firstValueFrom(
        interceptor.intercept(contextFor("setPhoto", photoRequest), {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);

    expect(warn.mock.calls[0][0]).toContain(
      `User update result=${result} operation=users.photo.update`,
    );
    expect(warn.mock.calls[0][0]).toContain(`fields=photo code=${code}`);
  });

  it("logs a photo removal and its rejection", async () => {
    const request = { params: { userId: "user-1" }, userId: "user-1", body: {} };
    const conflict = new ConflictException({ statusCode: 409, code: "user_state_conflict" });

    await firstValueFrom(
      interceptor.intercept(contextFor("deletePhoto", request), { handle: () => of(undefined) }),
    );
    await expect(
      firstValueFrom(
        interceptor.intercept(contextFor("deletePhoto", request), {
          handle: () => throwError(() => conflict),
        }),
      ),
    ).rejects.toBe(conflict);

    expect(log.mock.calls[0][0]).toMatch(
      /^User update result=success operation=users\.photo\.clear scope=self actorUserId=user-1 targetUserId=user-1 fields=photo durationMs=\d+$/,
    );
    expect(warn.mock.calls[0][0]).toContain(
      "User update result=conflict operation=users.photo.clear scope=self actorUserId=user-1 targetUserId=user-1 fields=photo code=user_state_conflict",
    );
  });

  it("passes routes without an audited operation through untouched", async () => {
    const handled = await firstValueFrom(
      interceptor.intercept(contextFor("updateUserEmail", photoRequest), {
        handle: () => of("result"),
      }),
    );

    expect(handled).toBe("result");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
