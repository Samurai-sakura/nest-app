import sharp from "sharp";
import { normalizePhoto } from "./photo-normalizer";

const RED = { r: 255, g: 0, b: 0 };

function image(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: RED } });
}

async function animatedWebp(frames: number) {
  const u24 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
  const chunk = (fourcc: string, data: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    const padding = Buffer.alloc(data.length % 2);
    return Buffer.concat([Buffer.from(fourcc, "latin1"), size, data, padding]);
  };
  const still = await image(100, 100).webp({ lossless: true }).toBuffer();
  const frame = chunk(
    "ANMF",
    Buffer.concat([u24(0), u24(0), u24(99), u24(99), u24(100), Buffer.from([0]), still.subarray(12)]),
  );
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    chunk("VP8X", Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24(99), u24(99)])),
    chunk("ANIM", Buffer.alloc(6)),
    ...Array.from({ length: frames }, () => frame),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
}

async function outputOf(result: Awaited<ReturnType<typeof normalizePhoto>>) {
  if (result.status !== "ok") {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  }
  return { data: result.data, metadata: await sharp(result.data).metadata() };
}

describe("normalizePhoto", () => {
  it.each([
    ["image/jpeg", () => image(300, 200).jpeg().toBuffer()],
    ["image/png", () => image(300, 200).png().toBuffer()],
    ["image/webp", () => image(300, 200).webp().toBuffer()],
  ])("re-encodes %s as WebP of the same size", async (mime, build) => {
    const { metadata } = await outputOf(await normalizePhoto(await build(), mime));

    expect(metadata).toMatchObject({ format: "webp", width: 300, height: 200 });
  });

  it("shrinks a large image into 1024×1024 keeping proportions", async () => {
    const file = await image(4000, 2000).png().toBuffer();

    const { metadata } = await outputOf(await normalizePhoto(file, "image/png"));

    expect(metadata).toMatchObject({ width: 1024, height: 512 });
  });

  it("does not enlarge a small image", async () => {
    const file = await image(64, 64).png().toBuffer();

    const { metadata } = await outputOf(await normalizePhoto(file, "image/png"));

    expect(metadata).toMatchObject({ width: 64, height: 64 });
  });

  it("applies EXIF orientation and drops all metadata", async () => {
    const file = await image(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(file).metadata()).exif).toBeDefined();

    const { metadata } = await outputOf(await normalizePhoto(file, "image/jpeg"));

    expect(metadata).toMatchObject({ width: 100, height: 200 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it.each([
    ["GIF", "image/gif", () => image(100, 100).gif().toBuffer()],
    ["GIF declared as PNG", "image/png", () => image(100, 100).gif().toBuffer()],
    ["JPEG declared as PNG", "image/png", () => image(100, 100).jpeg().toBuffer()],
    ["PNG without a declared type", "application/octet-stream", () => image(100, 100).png().toBuffer()],
    ["text", "image/png", async () => Buffer.from("not an image at all")],
  ])("answers unsupported to %s", async (_case, mime, build) => {
    expect(await normalizePhoto(await build(), mime)).toEqual({ status: "unsupported" });
  });

  it("answers invalid to a truncated image", async () => {
    const file = (await image(100, 100).png().toBuffer()).subarray(0, 60);

    expect(await normalizePhoto(file, "image/png")).toEqual({ status: "invalid", reason: "corrupted" });
  });

  it("answers invalid to a truncated body after a valid header", async () => {
    const full = await image(500, 500).jpeg().toBuffer();
    const file = full.subarray(0, Math.floor(full.length / 2));

    expect(await normalizePhoto(file, "image/jpeg")).toEqual({ status: "invalid", reason: "corrupted" });
  });

  it("answers invalid to an animated image", async () => {
    expect(await normalizePhoto(await animatedWebp(2), "image/webp")).toEqual({
      status: "invalid",
      reason: "animated",
    });
  });

  it("accepts a single-frame animated container", async () => {
    const { metadata } = await outputOf(await normalizePhoto(await animatedWebp(1), "image/webp"));

    expect(metadata).toMatchObject({ width: 100, height: 100 });
  });

  it.each([
    [63, 63],
    [63, 500],
    [4097, 100],
    [100, 4097],
  ])("answers invalid to %i×%i", async (width, height) => {
    const file = await image(width, height).png().toBuffer();

    expect(await normalizePhoto(file, "image/png")).toEqual({ status: "invalid", reason: "dimensions" });
  });

  it.each([
    [64, 4096],
    [4096, 64],
  ])("accepts the boundary size %i×%i", async (width, height) => {
    const file = await image(width, height).png().toBuffer();

    expect((await normalizePhoto(file, "image/png")).status).toBe("ok");
  });
});
