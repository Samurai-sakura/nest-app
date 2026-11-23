import { Logger } from "@nestjs/common";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Readable } from "stream";

jest.mock("@nestjs/config", () => ({ ConfigService: class {} }));

import { LocalPhotoStorage } from "./local-photo-storage";

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("LocalPhotoStorage", () => {
  let base: string;
  let root: string;
  let storage: LocalPhotoStorage;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "photo-storage-"));
    root = join(base, "photos");
    storage = new LocalPhotoStorage({ get: () => root } as any);
    await storage.onModuleInit();
    warn.mockClear();
    error.mockClear();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const put = async (key: string, content: string) => {
    const path = join(root, key);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  };

  it("creates the folder on startup", async () => {
    await expect(readFile(join(root, "missing.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storage.read("missing.webp")).resolves.toEqual({ status: "not_found" });
  });

  it("streams a stored object with its size", async () => {
    await put("user-1/photo.webp", "webp-bytes");

    const result = await storage.read("user-1/photo.webp");

    expect(result).toMatchObject({ status: "found", size: 10 });
    expect((await readAll((result as { stream: Readable }).stream)).toString()).toBe("webp-bytes");
  });

  it("reports a missing object as not_found", async () => {
    await expect(storage.read("user-1/missing.webp")).resolves.toEqual({ status: "not_found" });
    expect(error).not.toHaveBeenCalled();
  });

  it("does not treat a folder as an object", async () => {
    await put("user-1/photo.webp", "webp-bytes");

    await expect(storage.read("user-1")).resolves.toEqual({ status: "not_found" });
  });

  it.each(["../secret.txt", "user-1/../../secret.txt", "/etc/passwd", "user-1/./photo.webp", "", "a\\b"])(
    "never leaves the folder for the key %p",
    async (key) => {
      await writeFile(join(base, "secret.txt"), "secret");

      await expect(storage.read(key)).resolves.toEqual({ status: "not_found" });
      await expect(storage.delete(key)).resolves.toEqual({ status: "not_found" });
      expect(await readFile(join(base, "secret.txt"), "utf8")).toBe("secret");
      expect(warn).toHaveBeenCalledWith("Photo storage rejected reason=invalid_key");
    },
  );

  it("reports an unreadable object as unavailable without the key", async () => {
    const path = await put("user-1/photo.webp", "webp-bytes");
    await chmod(path, 0o000);

    await expect(storage.read("user-1/photo.webp")).resolves.toEqual({ status: "unavailable" });
    expect(error).toHaveBeenCalledWith("Photo storage unavailable operation=read code=EACCES");
    await chmod(path, 0o600);
  });

  it("deletes an object once", async () => {
    await put("user-1/photo.webp", "webp-bytes");

    await expect(storage.delete("user-1/photo.webp")).resolves.toEqual({ status: "deleted" });
    await expect(storage.delete("user-1/photo.webp")).resolves.toEqual({ status: "not_found" });
    await expect(storage.read("user-1/photo.webp")).resolves.toEqual({ status: "not_found" });
  });

  it("reports a failed delete as unavailable", async () => {
    await put("user-1/photo.webp", "webp-bytes");
    await chmod(join(root, "user-1"), 0o500);

    await expect(storage.delete("user-1/photo.webp")).resolves.toEqual({ status: "unavailable" });
    await chmod(join(root, "user-1"), 0o700);
  });

  describe("write", () => {
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10]);

    it("stores the bytes so that read returns them with their size", async () => {
      await expect(storage.write("photo-key", bytes)).resolves.toEqual({ status: "written" });

      const result = await storage.read("photo-key");

      expect(result).toMatchObject({ status: "found", size: bytes.length });
      expect(await readAll((result as { stream: Readable }).stream)).toEqual(bytes);
    });

    it("leaves no temporary files behind", async () => {
      await storage.write("photo-key", bytes);

      expect(await readdir(root)).toEqual(["photo-key"]);
    });

    it.each(["../escape", "/etc/escape", "a/../../escape", ""])(
      "never writes outside the folder for the key %p",
      async (key) => {
        await expect(storage.write(key, bytes)).resolves.toEqual({ status: "unavailable" });

        expect(await readdir(base)).toEqual(["photos"]);
        expect(await readdir(root)).toEqual([]);
      },
    );

    it("reports a failed write as unavailable without the key or a temporary file", async () => {
      await chmod(root, 0o500);

      await expect(storage.write("photo-key", bytes)).resolves.toEqual({ status: "unavailable" });

      expect(error).toHaveBeenCalledWith("Photo storage unavailable operation=write code=EACCES");
      expect(error.mock.calls.join("\n")).not.toContain("photo-key");
      await chmod(root, 0o700);
      expect(await readdir(root)).toEqual([]);
    });
  });

  describe("list", () => {
    const hourAgo = () => new Date(Date.now() - 60 * 60_000);
    const age = (path: string, minutes: number) => {
      const time = new Date(Date.now() - minutes * 60_000);
      return utimes(path, time, time);
    };

    it("lists only files older than the cutoff, with / in nested keys", async () => {
      await age(await put("old-key", "a"), 61);
      await age(await put("user-1/old.webp", "b"), 120);
      await put("fresh-key", "c");

      const result = await storage.list(hourAgo());

      expect(result.status).toBe("listed");
      expect((result as { keys: string[] }).keys.sort()).toEqual(["old-key", "user-1/old.webp"]);
    });

    it("returns keys that read and delete accept", async () => {
      await age(await put("user-1/old.webp", "b"), 61);

      const { keys } = (await storage.list(hourAgo())) as { keys: string[] };

      await expect(storage.delete(keys[0])).resolves.toEqual({ status: "deleted" });
    });

    it("lists an empty folder", async () => {
      await expect(storage.list(hourAgo())).resolves.toEqual({ status: "listed", keys: [] });
    });

    it("reports an unreadable folder as unavailable", async () => {
      await rm(root, { recursive: true });

      await expect(storage.list(hourAgo())).resolves.toEqual({ status: "unavailable" });
      expect(error).toHaveBeenCalledWith("Photo storage unavailable operation=list code=ENOENT");
    });
  });

  it("uses storage/photos when the variable is not set", () => {
    const fallback = new LocalPhotoStorage({ get: () => undefined } as any);

    expect((fallback as unknown as { root: string }).root).toBe(join(process.cwd(), "storage/photos"));
  });
});
