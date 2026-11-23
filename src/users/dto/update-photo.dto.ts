import { ApiProperty } from "@nestjs/swagger";

export class UpdatePhotoDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description:
      "Ровно один файл JPEG, PNG или WebP до 5 МиБ, от 64×64 до 4096×4096, без анимации; других полей быть не должно",
  })
  file: Express.Multer.File;
}
