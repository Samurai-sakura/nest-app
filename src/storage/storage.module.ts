import { Module } from "@nestjs/common";
import { LocalPhotoStorage } from "./local-photo-storage";
import { PHOTO_STORAGE } from "./photo-storage";

@Module({
  providers: [{ provide: PHOTO_STORAGE, useClass: LocalPhotoStorage }],
  exports: [PHOTO_STORAGE],
})
export class StorageModule {}
