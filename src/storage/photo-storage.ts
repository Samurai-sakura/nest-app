import type { Readable } from "stream";

export type PhotoReadResult =
  | { status: "found"; stream: Readable; size: number }
  | { status: "not_found" }
  | { status: "unavailable" };

export type PhotoDeleteResult = { status: "deleted" | "not_found" | "unavailable" };
export type PhotoWriteResult = { status: "written" | "unavailable" };
export type PhotoListResult = { status: "listed"; keys: string[] } | { status: "unavailable" };

export interface PhotoStorage {
  read(key: string): Promise<PhotoReadResult>;
  write(key: string, data: Buffer): Promise<PhotoWriteResult>;
  delete(key: string): Promise<PhotoDeleteResult>;
  list(olderThan: Date): Promise<PhotoListResult>;
}

export const PHOTO_STORAGE = Symbol("PHOTO_STORAGE");
