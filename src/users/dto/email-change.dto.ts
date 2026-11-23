import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, MaxLength } from "class-validator";

export class EmailChangeDto {
  @ApiProperty({
    example: "new@gmail.com",
    description:
      "Новый адрес; обрезается и приводится к нижнему регистру, +tag сохраняется. Текущий или занятый адрес даёт 409, письмо уходит только на него",
  })
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  newEmail: string;
}
