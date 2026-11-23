import sharp from "sharp";

export const PHOTO_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const PHOTO_MIN_SIDE = 64;
export const PHOTO_MAX_SIDE = 4096;
export const PHOTO_OUTPUT_SIDE = 1024;

const WEBP_QUALITIES = [85, 70, 50];

type PhotoFormat = "jpeg" | "png" | "webp";

const MIME_FORMATS: Record<string, PhotoFormat> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

export type NormalizedPhoto =
  | { status: "ok"; data: Buffer }
  | { status: "unsupported" }
  | { status: "invalid"; reason: string };

function detectFormat(file: Buffer): PhotoFormat | null {
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) {
    return "jpeg";
  }
  if (file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (
    file.length >= 12 &&
    file.toString("latin1", 0, 4) === "RIFF" &&
    file.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export async function normalizePhoto(
  file: Buffer,
  declaredMime: string,
): Promise<NormalizedPhoto> {
  const format = detectFormat(file);
  if (!format || MIME_FORMATS[declaredMime] !== format) {
    return { status: "unsupported" };
  }

  const input = { limitInputPixels: PHOTO_MAX_SIDE * PHOTO_MAX_SIDE };
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(file, input).metadata();
  } catch {
    return { status: "invalid", reason: "corrupted" };
  }

  if (metadata.format !== format) {
    return { status: "invalid", reason: "corrupted" };
  }
  if ((metadata.pages ?? 1) > 1) {
    return { status: "invalid", reason: "animated" };
  }
  const { width = 0, height = 0 } = metadata;
  if (Math.min(width, height) < PHOTO_MIN_SIDE || Math.max(width, height) > PHOTO_MAX_SIDE) {
    return { status: "invalid", reason: "dimensions" };
  }

  try {
    for (const quality of WEBP_QUALITIES) {
      const data = await sharp(file, { ...input, failOn: "error" })
        .rotate()
        .resize(PHOTO_OUTPUT_SIDE, PHOTO_OUTPUT_SIDE, { fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      if (data.length <= PHOTO_MAX_OUTPUT_BYTES) {
        return { status: "ok", data };
      }
    }
  } catch {
    return { status: "invalid", reason: "corrupted" };
  }
  return { status: "invalid", reason: "too_large" };
}
