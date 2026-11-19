import { ApiProperty } from "@nestjs/swagger";
import type { UserStatus } from "../entities/user.entity";

const USER_STATUSES: UserStatus[] = ["pending", "active", "blocked", "deleting", "deleted"];

export class UserProfileResponse {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ example: "abc@gmail.com", description: "Полный нормализованный email" })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: "Alex" })
  displayName: string | null;

  @ApiProperty({
    type: String,
    format: "uri",
    nullable: true,
    example: "https://api.example.com/users/3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c/photo",
    description: "null, если фотографии нет или статус deleting / deleted",
  })
  photoUrl: string | null;

  @ApiProperty({ enum: USER_STATUSES, example: "active" })
  status: UserStatus;

  @ApiProperty({ format: "date-time" })
  createdAt: Date;

  @ApiProperty({ format: "date-time" })
  updatedAt: Date;
}
