import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from "class-validator";

export class ConfirmRegistrationDto {
  @ApiPropertyOptional({
    format: "uuid",
    description: "Для кода: attemptId из ответа регистрации",
  })
  @ValidateIf((dto) => dto.token === undefined)
  @IsUUID()
  attemptId?: string;

  @ApiPropertyOptional({
    example: "123456",
    description: "Для кода: 6 цифр из письма",
  })
  @ValidateIf((dto) => dto.token === undefined)
  @Matches(/^\d{6}$/, { message: "code must be 6 digits" })
  code?: string;

  @ApiPropertyOptional({ description: "Для ссылки: token из письма" })
  @ValidateIf(
    (dto) =>
      dto.token !== undefined ||
      (dto.attemptId === undefined && dto.code === undefined),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  token?: string;
}
