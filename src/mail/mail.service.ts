import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, Transporter } from "nodemailer";

@Injectable()
export class MailService {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    this.transporter = createTransport({
      host: config.get("SMTP_HOST"),
      port: Number(config.get("SMTP_PORT")),
      secure: false,
    });
    this.from = config.getOrThrow("MAIL_FROM");
  }

  public async sendOtp(to: string, code: string) {
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: "Код подтверждения регистрации",
      text: `Ваш код: ${code}. Действует 10 минут.`,
    });
  }

  public async sendMagicLink(to: string, link: string) {
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject: "Подтверждение регистрации",
      text: `Перейдите по ссылке, чтобы подтвердить email: ${link}\nСсылка действует 10 минут.`,
    });
  }
}
