import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { RBAC_NAME_PATTERN } from "../helpers/rbac-name";
import { normalizeName, trimText } from "../helpers/normalize";

export const NAME_FORMAT_MESSAGE = "must match ^[a-z][a-z0-9._-]{0,63}$ after trimming and lowercasing";

export class RoleBodyDto {
  @ApiProperty({ example: "editor", description: "Обрезается и приводится к нижнему регистру" })
  @Transform(normalizeName)
  @IsString()
  @Matches(RBAC_NAME_PATTERN, { message: `name ${NAME_FORMAT_MESSAGE}` })
  name: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    example: "Редактирует отчёты",
    description: "Пустая строка сохраняется как null",
  })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

export class RoleResponse {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ example: "editor" })
  name: string;

  @ApiProperty({ nullable: true, type: String, example: "Редактирует отчёты" })
  description: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt: Date;

  @ApiProperty({ format: "date-time" })
  updatedAt: Date;
}
