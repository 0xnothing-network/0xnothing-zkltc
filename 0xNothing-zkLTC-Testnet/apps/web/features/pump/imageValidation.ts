export const PUMP_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function validatePumpImage(file: Blob): Promise<string | null> {
  const mimeType = file.type.trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    return "Only PNG, JPEG, and WebP logos are accepted";
  }
  if (file.size <= 0 || file.size > PUMP_MAX_IMAGE_BYTES) {
    return "Logo must be non-empty and smaller than or equal to 2 MB";
  }

  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const looksLikeSvg = new TextDecoder()
    .decode(bytes)
    .trimStart()
    .toLowerCase()
    .startsWith("<svg");
  if (looksLikeSvg) return "SVG uploads are not accepted";

  const png =
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP";
  const matches =
    (mimeType === "image/png" && png) ||
    (mimeType === "image/jpeg" && jpeg) ||
    (mimeType === "image/webp" && webp);

  return matches ? null : "Logo bytes do not match the declared image type";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}
