import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisteredUserResponse {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiPropertyOptional({ nullable: true, example: "Alex" })
  name?: string | null;

  @ApiProperty({ example: "abc@gmail.com" })
  email: string;

  @ApiProperty({ enum: ["active"], example: "active" })
  status: "active";
}

export class ConfirmedUserResponse {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ example: "abc@gmail.com" })
  email: string;

  @ApiProperty({ enum: ["active"], example: "active" })
  status: "active";
}
