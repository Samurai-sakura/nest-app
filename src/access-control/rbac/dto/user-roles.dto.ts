import { ApiProperty } from "@nestjs/swagger";
import { ArrayUnique, IsArray, IsUUID } from "class-validator";

export class UserRolesBodyDto {
  @ApiProperty({
    type: [String],
    format: "uuid",
    description: "Полностью заменяет роли пользователя; пустой массив снимает все роли",
  })
  @IsArray()
  @IsUUID("all", { each: true })
  @ArrayUnique({ message: "roleIds must not contain duplicates" })
  roleIds: string[];
}

export class UserRolesResponse {
  @ApiProperty({ format: "uuid" })
  userId: string;

  @ApiProperty({ type: [String], format: "uuid" })
  roleIds: string[];
}
