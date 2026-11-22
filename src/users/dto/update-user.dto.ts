import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, MaxLength, ValidateIf } from "class-validator";
import { Transform } from "class-transformer";
import { IsDisplayName, normalizeDisplayName } from "../helpers/display-name";

export const UPDATABLE_STATUSES = ["active", "blocked"] as const;
export type UpdatableStatus = (typeof UPDATABLE_STATUSES)[number];

export class UpdateUserDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: "Alex",
    description: "null очищает имя; строка обрезается, приводится к NFC и содержит 1–80 символов",
  })
  @Transform(({ value }) => (typeof value === "string" ? normalizeDisplayName(value) : value))
  @IsOptional()
  @IsDisplayName()
  displayName?: string | null;

  @ApiPropertyOptional({
    example: "abc@gmail.com",
    description: "Только с users@update_any; null недопустим",
  })
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @ValidateIf((_, value) => value !== undefined)
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({
    enum: UPDATABLE_STATUSES,
    description: "Только с users@update_any; null недопустим",
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(UPDATABLE_STATUSES)
  status?: UpdatableStatus;
}
