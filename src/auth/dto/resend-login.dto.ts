import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class ResendLoginDto {
  @ApiProperty({ format: "uuid", description: "attemptId из ответа входа" })
  @IsUUID()
  attemptId: string;
}
