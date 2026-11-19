import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, open, unlink } from "fs/promises";
import { resolve, sep } from "path";
import type { PhotoDeleteResult, PhotoReadResult, PhotoStorage } from "./photo-storage";

const DEFAULT_DIR = "storage/photos";

const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

@Injectable()
export class LocalPhotoStorage implements PhotoStorage, OnModuleInit {
  private readonly logger = new Logger(LocalPhotoStorage.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>("PHOTO_STORAGE_DIR") || DEFAULT_DIR);
  }

  public async onModuleInit() {
    await mkdir(this.root, { recursive: true });
  }

  public async read(key: string): Promise<PhotoReadResult> {
    const path = this.pathOf(key);
    if (!path) {
      return { status: "not_found" };
    }
    try {
      const file = await open(path, "r");
      const stat = await file.stat();
      if (!stat.isFile()) {
        await file.close();
        return { status: "not_found" };
      }
      return { status: "found", stream: file.createReadStream(), size: stat.size };
    } catch (error) {
      return this.failure(error, "read");
    }
  }

  public async delete(key: string): Promise<PhotoDeleteResult> {
    const path = this.pathOf(key);
    if (!path) {
      return { status: "not_found" };
    }
    try {
      await unlink(path);
      return { status: "deleted" };
    } catch (error) {
      return this.failure(error, "delete");
    }
  }

  private pathOf(key: string) {
    if (!KEY_PATTERN.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
      this.logger.warn("Photo storage rejected reason=invalid_key");
      return null;
    }
    const path = resolve(this.root, key);
    return path.startsWith(this.root + sep) ? path : null;
  }

  private failure(error: unknown, operation: string): { status: "not_found" | "unavailable" } {
    const code = (error as { code?: string }).code;
    if (code && MISSING_CODES.has(code)) {
      return { status: "not_found" };
    }
    this.logger.error(`Photo storage unavailable operation=${operation} code=${code ?? "unknown"}`);
    return { status: "unavailable" };
  }
}
