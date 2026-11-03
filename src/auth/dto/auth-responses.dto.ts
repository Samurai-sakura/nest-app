import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisteredUserResponse {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiPropertyOptional({ nullable: true, example: "Alex" })
  name?: string | null;

  @ApiProperty({ example: "abc@gmail.com" })
  email: string;

  @ApiProperty({ enum: ["active"], example: "active" })
  status: "active";
}

export class ConfirmedUserResponse {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ example: "abc@gmail.com" })
  email: string;

  @ApiProperty({ enum: ["active"], example: "active" })
  status: "active";
}

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

export class ErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    example: "Invalid or expired confirmation code",
  })
  message: string | string[];

  @ApiProperty({ example: "Bad Request" })
  error: string;
}
