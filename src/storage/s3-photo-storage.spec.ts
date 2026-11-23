import { Logger } from "@nestjs/common";
import { Readable } from "stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));

import { S3PhotoStorage } from "./s3-photo-storage";

const SECRET = "BACKENDAPPDEVSECRET2026";

function s3Error(name: string, httpStatusCode = 500) {
  return Object.assign(new Error(`${name} for photo-key with ${SECRET}`), {
    name,
    $metadata: { httpStatusCode },
  });
}

describe("S3PhotoStorage", () => {
  const config: Record<string, string> = {};
  let send: jest.Mock;
  let storage: S3PhotoStorage;
  let error: jest.SpyInstance;

  beforeAll(() => {
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  const configService = {
    get: (key: string) => config[key],
    getOrThrow: (key: string) => config[key],
  };

  beforeEach(() => {
    Object.assign(config, {
      S3_ENDPOINT: "http://localhost:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "photos",
      S3_ACCESS_KEY_ID: "BACKENDAPPDEV",
      S3_SECRET_ACCESS_KEY: SECRET,
      S3_CREATE_BUCKET: "false",
    });
    send = jest.fn().mockResolvedValue({});
    storage = new S3PhotoStorage(configService as any, { send } as any);
    error.mockClear();
  });

  const sent = (index = 0) => send.mock.calls[index][0];

  it("builds a path-style client for the configured endpoint", async () => {
    const real = new S3PhotoStorage(configService as any);
    const client = (real as unknown as { client: { config: Record<string, any> } }).client;

    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe("us-east-1");
    expect(await client.config.credentials()).toMatchObject({ accessKeyId: "BACKENDAPPDEV" });
  });

  describe("read", () => {
    it("streams the object with its size", async () => {
      const body = Readable.from([Buffer.from("webp")]);
      send.mockResolvedValue({ Body: body, ContentLength: 4 });

      await expect(storage.read("photo-key")).resolves.toEqual({
        status: "found",
        stream: body,
        size: 4,
      });
      expect(sent()).toBeInstanceOf(GetObjectCommand);
      expect(sent().input).toEqual({ Bucket: "photos", Key: "photo-key" });
    });

    it.each([
      ["NoSuchKey", 404],
      ["NotFound", 404],
      ["UnknownError", 404],
    ])("reports %s as not_found", async (name, status) => {
      send.mockRejectedValue(s3Error(name, status));

      await expect(storage.read("photo-key")).resolves.toEqual({ status: "not_found" });
      expect(error).not.toHaveBeenCalled();
    });

    it("reports other failures as unavailable without the key or the secret", async () => {
      send.mockRejectedValue(s3Error("ServiceUnavailable", 503));

      await expect(storage.read("photo-key")).resolves.toEqual({ status: "unavailable" });
      expect(error).toHaveBeenCalledWith(
        "Photo storage unavailable operation=read code=ServiceUnavailable",
      );
    });
  });

  describe("write", () => {
    it("puts a WebP object under the key", async () => {
      const data = Buffer.from("webp");

      await expect(storage.write("photo-key", data)).resolves.toEqual({ status: "written" });
      expect(sent()).toBeInstanceOf(PutObjectCommand);
      expect(sent().input).toEqual({
        Bucket: "photos",
        Key: "photo-key",
        Body: data,
        ContentType: "image/webp",
      });
    });

    it("reports a failed write as unavailable", async () => {
      send.mockRejectedValue(s3Error("AccessDenied", 403));

      await expect(storage.write("photo-key", Buffer.from("x"))).resolves.toEqual({
        status: "unavailable",
      });
      expect(error).toHaveBeenCalledWith(
        "Photo storage unavailable operation=write code=AccessDenied",
      );
    });
  });

  describe("delete", () => {
    it("deletes the object", async () => {
      await expect(storage.delete("photo-key")).resolves.toEqual({ status: "deleted" });
      expect(sent()).toBeInstanceOf(DeleteObjectCommand);
      expect(sent().input).toEqual({ Bucket: "photos", Key: "photo-key" });
    });

    it("treats a missing bucket object as not_found", async () => {
      send.mockRejectedValue(s3Error("NoSuchKey", 404));

      await expect(storage.delete("photo-key")).resolves.toEqual({ status: "not_found" });
    });

    it("reports a failed delete as unavailable", async () => {
      send.mockRejectedValue(s3Error("SlowDown", 503));

      await expect(storage.delete("photo-key")).resolves.toEqual({ status: "unavailable" });
    });
  });

  describe("list", () => {
    const cutoff = new Date("2026-01-01T01:00:00Z");

    it("follows pages and keeps only objects older than the cutoff", async () => {
      send
        .mockResolvedValueOnce({
          Contents: [
            { Key: "old-1", LastModified: new Date("2026-01-01T00:00:00Z") },
            { Key: "fresh", LastModified: new Date("2026-01-01T02:00:00Z") },
          ],
          IsTruncated: true,
          NextContinuationToken: "page-2",
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: "old-2", LastModified: new Date("2025-12-31T00:00:00Z") }],
          IsTruncated: false,
        });

      await expect(storage.list(cutoff)).resolves.toEqual({
        status: "listed",
        keys: ["old-1", "old-2"],
      });
      expect(sent(0)).toBeInstanceOf(ListObjectsV2Command);
      expect(sent(0).input).toEqual({ Bucket: "photos", ContinuationToken: undefined });
      expect(sent(1).input).toEqual({ Bucket: "photos", ContinuationToken: "page-2" });
    });

    it("lists an empty bucket", async () => {
      send.mockResolvedValue({ IsTruncated: false });

      await expect(storage.list(cutoff)).resolves.toEqual({ status: "listed", keys: [] });
    });

    it("reports a failed listing as unavailable", async () => {
      send.mockRejectedValue(s3Error("InternalError", 500));

      await expect(storage.list(cutoff)).resolves.toEqual({ status: "unavailable" });
      expect(error).toHaveBeenCalledWith(
        "Photo storage unavailable operation=list code=InternalError",
      );
    });
  });

  describe("bucket on startup", () => {
    it("does nothing unless S3_CREATE_BUCKET is true", async () => {
      await storage.onModuleInit();

      expect(send).not.toHaveBeenCalled();
    });

    it("keeps an existing bucket", async () => {
      config.S3_CREATE_BUCKET = "true";
      storage = new S3PhotoStorage(configService as any, { send } as any);

      await storage.onModuleInit();

      expect(send).toHaveBeenCalledTimes(1);
      expect(sent()).toBeInstanceOf(HeadBucketCommand);
    });

    it("creates a missing bucket", async () => {
      config.S3_CREATE_BUCKET = "true";
      storage = new S3PhotoStorage(configService as any, { send } as any);
      send.mockRejectedValueOnce(s3Error("NotFound", 404)).mockResolvedValueOnce({});

      await storage.onModuleInit();

      expect(sent(1)).toBeInstanceOf(CreateBucketCommand);
      expect(sent(1).input).toEqual({ Bucket: "photos" });
    });

    it("fails the startup when the bucket cannot be checked", async () => {
      config.S3_CREATE_BUCKET = "true";
      storage = new S3PhotoStorage(configService as any, { send } as any);
      send.mockRejectedValue(s3Error("AccessDenied", 403));

      await expect(storage.onModuleInit()).rejects.toMatchObject({ name: "AccessDenied" });
    });
  });

  it("never logs keys or credentials", async () => {
    send.mockRejectedValue(s3Error("ServiceUnavailable", 503));

    await storage.read("photo-key");
    await storage.write("photo-key", Buffer.from("x"));
    await storage.list(new Date());

    const text = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).not.toContain("photo-key");
    expect(text).not.toContain(SECRET);
  });
});
