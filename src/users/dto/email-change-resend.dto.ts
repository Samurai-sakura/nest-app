import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class EmailChangeResendDto {
  @ApiProperty({
    format: "uuid",
    description: "challengeId из ответа email-change; способ и адрес при resend не меняются",
  })
  @IsUUID()
  challengeId: string;
}
