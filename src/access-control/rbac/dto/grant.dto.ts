import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from "class-validator";
import { RBAC_NAME_PATTERN } from "../helpers/rbac-name";
import { normalizeNames } from "../helpers/normalize";
import { NAME_FORMAT_MESSAGE } from "./role.dto";

export class GrantBodyDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  roleId: string;

  @ApiProperty({ format: "uuid" })
  @IsUUID()
  permissionId: string;

  @ApiPropertyOptional({
    example: ["read"],
    description: "Отсутствует или пустой — все текущие и будущие действия разрешения",
  })
  @IsOptional()
  @Transform(normalizeNames)
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Matches(RBAC_NAME_PATTERN, { each: true, message: `each action ${NAME_FORMAT_MESSAGE}` })
  @ArrayUnique({ message: "actions must not contain duplicates" })
  actions?: string[];
}

export class GrantResponse {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ format: "uuid" })
  roleId: string;

  @ApiProperty({ format: "uuid" })
  permissionId: string;

  @ApiProperty({ description: "true — все действия, тогда actions пустой" })
  allActions: boolean;

  @ApiProperty({ example: ["read"] })
  actions: string[];

  @ApiProperty({ format: "date-time" })
  createdAt: Date;

  @ApiProperty({ format: "date-time" })
  updatedAt: Date;
}
