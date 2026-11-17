import { ApiProperty } from "@nestjs/swagger";

export class ConfirmationRequiredResponse {
  @ApiProperty({ example: true })
  confirmationRequired: true;

  @ApiProperty({ enum: ["otp", "magic_link"], example: "otp" })
  method: "otp" | "magic_link";

  @ApiProperty({ format: "uuid" })
  attemptId: string;

  @ApiProperty({ example: 600 })
  expiresInSeconds: number;

  @ApiProperty({ example: 60 })
  resendAfterSeconds: number;
}
