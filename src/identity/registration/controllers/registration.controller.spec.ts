import {
  BadRequestException,
  INestApplication,
  Logger,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ThrottlerException, ThrottlerGuard } from "@nestjs/throttler";
import { APP_FILTER } from "@nestjs/core";
import { HttpExceptionFilter } from "../../../common/filters/http-exception.filter";
import request from "supertest";

jest.mock("../services/registration.service", () => ({ RegistrationService: class {} }));

import { RegistrationController } from "./registration.controller";
import { RegistrationService } from "../services/registration.service";

const attemptId = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";

describe("RegistrationController", () => {
  let app: INestApplication;
  let registrationService: { confirm: jest.Mock };
  let guard: { canActivate: jest.Mock };
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    registrationService = { confirm: jest.fn() };
    guard = { canActivate: jest.fn(() => true) };
    const moduleRef = await Test.createTestingModule({
      controllers: [RegistrationController],
      providers: [
        { provide: RegistrationService, useValue: registrationService },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue(guard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    warn.mockClear();
    registrationService.confirm.mockReset();
    registrationService.confirm.mockResolvedValue({
      id: "user-1",
      email: "abc@gmail.com",
      status: "active",
    });
  });

  describe("POST /auth/register/confirm", () => {
    it("confirms by attemptId and code", async () => {
      const body = { attemptId, code: "123456" };

      await request(app.getHttpServer())
        .post("/auth/register/confirm")
        .send(body)
        .expect(200, { id: "user-1", email: "abc@gmail.com", status: "active" });

      expect(registrationService.confirm).toHaveBeenCalledWith(
        expect.objectContaining(body),
      );
    });

    it("confirms by token", async () => {
      await request(app.getHttpServer())
        .post("/auth/register/confirm")
        .send({ token: "some-token" })
        .expect(200);

      expect(registrationService.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ token: "some-token" }),
      );
    });

    it("returns 400 for an empty body", async () => {
      await request(app.getHttpServer())
        .post("/auth/register/confirm")
        .send({})
        .expect(400);

      expect(registrationService.confirm).not.toHaveBeenCalled();
    });
  });

  describe("GET /auth/register/confirm", () => {
    it("returns a page and does not confirm anything", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/register/confirm?token=some-token")
        .expect(200)
        .expect("Content-Type", /text\/html/)
        .expect("Cache-Control", "no-store")
        .expect("Referrer-Policy", "no-referrer");

      expect(registrationService.confirm).not.toHaveBeenCalled();
      expect(response.text).toContain('method: "POST"');
    });

    it("does not reflect the token into the page", async () => {
      const token = "<script>alert(1)</script>";

      const response = await request(app.getHttpServer())
        .get("/auth/register/confirm")
        .query({ token })
        .expect(200);

      expect(response.text).not.toContain(token);
    });
  });

  describe("rejection log", () => {
    it("records validation errors without the submitted values", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email: "not-an-email", password: "weak-secret" })
        .expect(400);

      expect(response.body.statusCode).toBe(400);
      expect(response.body.message).toContain("email must be an email");
      const entry = warn.mock.calls[0][0];
      expect(entry).toContain("reason=validation route=POST /auth/register");
      expect(entry).not.toContain("weak-secret");
      expect(entry).not.toContain("not-an-email");
    });

    it("records rate limiting and keeps the usual 429 body", async () => {
      guard.canActivate.mockImplementationOnce(() => {
        throw new ThrottlerException();
      });

      const response = await request(app.getHttpServer())
        .post("/auth/register")
        .send({})
        .expect(429);

      expect(response.body.statusCode).toBe(429);
      expect(warn).toHaveBeenCalledWith(
        "Request rejected reason=rate_limit route=POST /auth/register",
      );
    });

    it("does not duplicate a 400 already logged by the service", async () => {
      registrationService.confirm.mockRejectedValue(
        new BadRequestException("Invalid or expired confirmation code"),
      );

      await request(app.getHttpServer())
        .post("/auth/register/confirm")
        .send({ token: "some-token" })
        .expect(400);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it.each(["otp", "link"])("no longer serves /confirm/%s", async (path) => {
    await request(app.getHttpServer())
      .post(`/auth/register/confirm/${path}`)
      .send({ token: "some-token" })
      .expect(404);
  });
});
