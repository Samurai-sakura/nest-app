import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { LocalPhotoStorage } from "./local-photo-storage";
import { S3PhotoStorage } from "./s3-photo-storage";
import { PHOTO_STORAGE } from "./photo-storage";
import { StorageCleanupJob } from "./entities/storage-cleanup-job.entity";
import { StorageCleanupWorker } from "./storage-cleanup.worker";

@Module({
  imports: [TypeOrmModule.forFeature([StorageCleanupJob])],
  providers: [
    {
      provide: PHOTO_STORAGE,
      useFactory: (config: ConfigService) =>
        config.get<string>("PHOTO_STORAGE_DRIVER") === "s3"
          ? new S3PhotoStorage(config)
          : new LocalPhotoStorage(config),
      inject: [ConfigService],
    },
    StorageCleanupWorker,
  ],
  exports: [PHOTO_STORAGE],
})
export class StorageModule {}
