const sendMail = jest.fn();
const createTransport = jest.fn((_options: unknown) => ({ sendMail }));

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));
jest.mock("nodemailer", () => ({ createTransport }));

import { MailService } from "./mail.service";

const env: Record<string, string> = {
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  MAIL_FROM: "no-reply@backend-app.local",
};
const config = {
  get: (key: string) => env[key],
  getOrThrow: (key: string) => {
    if (env[key] === undefined) throw new Error(`missing ${key}`);
    return env[key];
  },
};

describe("MailService", () => {
  let service: MailService;

  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
    service = new MailService(config as any);
  });

  it("connects to the configured SMTP server", () => {
    expect(createTransport).toHaveBeenCalledWith({
      host: "localhost",
      port: 1025,
      secure: false,
    });
  });

  it("fails at startup without MAIL_FROM", () => {
    const { MAIL_FROM, ...rest } = env;
    const incomplete = { ...config, getOrThrow: (key: string) => {
      if (!(key in rest)) throw new Error(`missing ${key}`);
      return rest[key as keyof typeof rest];
    } };

    expect(() => new MailService(incomplete as any)).toThrow("missing MAIL_FROM");
    expect(MAIL_FROM).toBeDefined();
  });

  it.each([
    ["sendOtp", "123456", "Код подтверждения регистрации"],
    ["sendMagicLink", "http://localhost:3200/auth/register/confirm?token=abc", "Подтверждение регистрации"],
    ["sendLoginOtp", "654321", "Код для входа"],
    ["sendLoginMagicLink", "http://localhost:3200/auth/login/confirm#token=id.secret", "Ссылка для входа"],
  ] as const)("%s sends the secret only in the message body", async (method, secret, subject) => {
    await service[method]("abc@gmail.com", secret);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0][0];
    expect(message).toMatchObject({
      from: "no-reply@backend-app.local",
      to: "abc@gmail.com",
      subject,
    });
    expect(message.text).toContain(secret);
    expect(message.text).toContain("10 минут");
    expect(message.subject).not.toContain(secret);
  });

  it("passes a delivery failure to the caller", async () => {
    sendMail.mockRejectedValue(new Error("smtp down"));

    await expect(service.sendLoginOtp("abc@gmail.com", "123456")).rejects.toThrow("smtp down");
  });
});
