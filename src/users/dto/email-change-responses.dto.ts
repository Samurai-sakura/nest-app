import { ApiProperty } from "@nestjs/swagger";

export class EmailChangeChallengeResponse {
  @ApiProperty({ example: true })
  confirmationRequired: true;

  @ApiProperty({
    enum: ["otp", "magic_link"],
    example: "otp",
    description: "Способ выбирает сервер из EMAIL_CHANGE_METHOD",
  })
  method: "otp" | "magic_link";

  @ApiProperty({
    format: "uuid",
    description: "Идентификатор challenge для resend и confirm",
  })
  challengeId: string;

  @ApiProperty({ example: 600, description: "Срок действия кода или ссылки от последней отправки" })
  expiresInSeconds: number;

  @ApiProperty({ example: 60, description: "Через сколько секунд разрешён resend" })
  resendAfterSeconds: number;
}
