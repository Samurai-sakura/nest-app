import { HttpException, Logger } from "@nestjs/common";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("@nestjs/typeorm", () => ({ InjectRepository: () => () => undefined }));

import { UsersService } from "./users.service";

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("UsersService", () => {
  let userRepository: { findOne: jest.Mock };
  let service: UsersService;
  let error: jest.SpyInstance;

  beforeAll(() => {
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    userRepository = { findOne: jest.fn() };
    service = new UsersService(
      userRepository as any,
      { read: jest.fn() } as any,
      { getOrThrow: () => "http://localhost:3200" } as any,
    );
    error.mockClear();
  });

  const connectionRefused = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

  it.each([
    ["profile", (s: UsersService) => s.findProfile("user-1")],
    ["photo", (s: UsersService) => s.findPhoto("user-1")],
  ])("answers 503 when the database is unavailable for the %s", async (_case, call) => {
    userRepository.findOne.mockRejectedValue(connectionRefused());

    const failure = (await errorOf(call(service))) as HttpException;

    expect(failure.getStatus()).toBe(503);
    expect(failure.getResponse()).toEqual({
      statusCode: 503,
      code: "users_unavailable",
      message: "User data is temporarily unavailable",
    });
    expect(error).toHaveBeenCalledWith("User data unavailable reason=database userId=user-1");
  });

  it("keeps an unexpected error as it is", async () => {
    const bug = new TypeError("unexpected");
    userRepository.findOne.mockRejectedValue(bug);

    expect(await errorOf(service.findProfile("user-1"))).toBe(bug);
  });
});
