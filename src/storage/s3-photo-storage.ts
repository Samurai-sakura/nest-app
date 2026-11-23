import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import type {
  PhotoDeleteResult,
  PhotoListResult,
  PhotoReadResult,
  PhotoStorage,
  PhotoWriteResult,
} from "./photo-storage";

const MISSING_ERRORS = new Set(["NoSuchKey", "NotFound", "NoSuchBucket"]);

function errorName(error: unknown) {
  return (error as { name?: string })?.name ?? "unknown";
}

function isMissing(error: unknown) {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return MISSING_ERRORS.has(errorName(error)) || status === 404;
}

@Injectable()
export class S3PhotoStorage implements PhotoStorage, OnModuleInit {
  private readonly logger = new Logger(S3PhotoStorage.name);
  private readonly bucket: string;
  private readonly createBucket: boolean;

  constructor(
    config: ConfigService,
    private readonly client = new S3Client({
      endpoint: config.getOrThrow<string>("S3_ENDPOINT"),
      region: config.getOrThrow<string>("S3_REGION"),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.getOrThrow<string>("S3_ACCESS_KEY_ID"),
        secretAccessKey: config.getOrThrow<string>("S3_SECRET_ACCESS_KEY"),
      },
    }),
  ) {
    this.bucket = config.getOrThrow<string>("S3_BUCKET");
    this.createBucket = config.get<string>("S3_CREATE_BUCKET") === "true";
  }

  public async onModuleInit() {
    if (!this.createBucket) {
      return;
    }
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log("Photo storage bucket created");
    }
  }

  public async read(key: string): Promise<PhotoReadResult> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        status: "found",
        stream: object.Body as Readable,
        size: object.ContentLength ?? 0,
      };
    } catch (error) {
      return isMissing(error) ? { status: "not_found" } : this.unavailable(error, "read");
    }
  }

  public async write(key: string, data: Buffer): Promise<PhotoWriteResult> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: "image/webp",
        }),
      );
      return { status: "written" };
    } catch (error) {
      return this.unavailable(error, "write");
    }
  }

  public async delete(key: string): Promise<PhotoDeleteResult> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return { status: "deleted" };
    } catch (error) {
      return isMissing(error) ? { status: "not_found" } : this.unavailable(error, "delete");
    }
  }

  public async list(olderThan: Date): Promise<PhotoListResult> {
    try {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key && object.LastModified && object.LastModified < olderThan) {
            keys.push(object.Key);
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return { status: "listed", keys };
    } catch (error) {
      return this.unavailable(error, "list");
    }
  }

  private unavailable(error: unknown, operation: string): { status: "unavailable" } {
    this.logger.error(`Photo storage unavailable operation=${operation} code=${errorName(error)}`);
    return { status: "unavailable" };
  }
}
