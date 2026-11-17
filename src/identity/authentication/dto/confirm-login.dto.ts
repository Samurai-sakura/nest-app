import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsUUID, Matches, ValidateIf } from "class-validator";

export const LOGIN_LINK_TOKEN_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export class ConfirmLoginDto {
  @ApiPropertyOptional({
    format: "uuid",
    description: "Для кода: attemptId из ответа входа",
  })
  @ValidateIf((dto) => dto.token === undefined)
  @IsUUID()
  attemptId?: string;

  @ApiPropertyOptional({ example: "123456", description: "Для кода: 6 цифр из письма" })
  @ValidateIf((dto) => dto.token === undefined)
  @Matches(/^\d{6}$/, { message: "code must be 6 digits" })
  code?: string;

  @ApiPropertyOptional({
    description: "Для ссылки: token из письма в формате attemptId.secret",
  })
  @ValidateIf(
    (dto) =>
      dto.token !== undefined ||
      (dto.attemptId === undefined && dto.code === undefined),
  )
  @Matches(LOGIN_LINK_TOKEN_PATTERN, { message: "token has an invalid format" })
  token?: string;
}
