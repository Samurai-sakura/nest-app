import type { Readable } from "stream";

export type PhotoReadResult =
  | { status: "found"; stream: Readable; size: number }
  | { status: "not_found" }
  | { status: "unavailable" };

export type PhotoDeleteResult = { status: "deleted" | "not_found" | "unavailable" };

export interface PhotoStorage {
  read(key: string): Promise<PhotoReadResult>;
  delete(key: string): Promise<PhotoDeleteResult>;
}

export const PHOTO_STORAGE = Symbol("PHOTO_STORAGE");
