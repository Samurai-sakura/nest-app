import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
} from "class-validator";
import { RBAC_NAME_PATTERN } from "../helpers/rbac-name";
import { normalizeNames } from "../helpers/normalize";
import { NAME_FORMAT_MESSAGE, RoleBodyDto, RoleResponse } from "./role.dto";

export class PermissionBodyDto extends RoleBodyDto {
  @ApiProperty({
    example: ["read", "update"],
    description: "От 1 до 64 уникальных действий после нормализации; набор заменяется целиком",
  })
  @Transform(normalizeNames)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Matches(RBAC_NAME_PATTERN, { each: true, message: `each action ${NAME_FORMAT_MESSAGE}` })
  @ArrayUnique({ message: "actions must not contain duplicates" })
  actions: string[];
}

export class PermissionResponse extends RoleResponse {
  @ApiProperty({ example: ["read", "update"] })
  actions: string[];
}
