import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsUUID, Matches, ValidateBy, ValidateIf } from "class-validator";
import { CONFIRMATION_LINK_TOKEN_PATTERN } from "../../identity/confirmation/confirmation-secret";

function IsWithoutOtpFields() {
  return ValidateBy({
    name: "isWithoutOtpFields",
    validator: {
      validate: (_, args) => {
        const dto = args?.object as EmailChangeConfirmDto;
        return dto.challengeId === undefined && dto.code === undefined;
      },
      defaultMessage: () => "token cannot be combined with challengeId or code",
    },
  });
}

export class EmailChangeConfirmDto {
  @ApiPropertyOptional({
    format: "uuid",
    description: "Для OTP: challengeId из ответа email-change",
  })
  @ValidateIf((dto) => dto.token === undefined)
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional({ example: "123456", description: "Для OTP: 6 цифр из письма" })
  @ValidateIf((dto) => dto.token === undefined)
  @Matches(/^\d{6}$/, { message: "code must be 6 digits" })
  code?: string;

  @ApiPropertyOptional({
    description:
      "Для magic link: token из фрагмента ссылки в формате challengeId.secret; не сочетается с challengeId и code",
  })
  @ValidateIf(
    (dto) =>
      dto.token !== undefined ||
      (dto.challengeId === undefined && dto.code === undefined),
  )
  @Matches(CONFIRMATION_LINK_TOKEN_PATTERN, { message: "token has an invalid format" })
  @IsWithoutOtpFields()
  token?: string;
}
