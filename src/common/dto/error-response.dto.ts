import { ApiProperty } from "@nestjs/swagger";

export class ErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({
    example: "invalid_confirmation",
    description:
      "Машиночитаемый код: validation_failed, invalid_credentials, invalid_session, csrf_rejected, rate_limited и другие",
  })
  code: string;

  @ApiProperty({
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    example: "Invalid or expired confirmation code",
  })
  message: string | string[];
}
