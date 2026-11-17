import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEmail, IsNotEmpty, IsString, MaxLength } from "class-validator";

export class UserLoginDto {
  @ApiProperty({ example: "abc@gmail.com" })
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ example: "Passw0rd" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
