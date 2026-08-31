export interface RasterImageMetadata {
  animated: boolean;
  height: number;
  width: number;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16);
}

function pngMetadata(bytes: Uint8Array): RasterImageMetadata | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 33
    || !signature.every((value, index) => bytes[index] === value)
  ) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let animated = false;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (end + 4 > bytes.length) return undefined;
    const type = ascii(bytes, offset + 4, offset + 8);
    if (type === "IHDR" && length >= 13) {
      width = view.getUint32(dataOffset, false);
      height = view.getUint32(dataOffset + 4, false);
    } else if (type === "acTL") {
      animated = true;
    }
    offset = end + 4;
    if (type === "IEND") break;
  }

  return width > 0 && height > 0 ? { animated, height, width } : undefined;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function jpegMetadata(bytes: Uint8Array): RasterImageMetadata | undefined {
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return undefined;

    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) return undefined;
      const height = view.getUint16(offset + 3, false);
      const width = view.getUint16(offset + 5, false);
      return width > 0 && height > 0
        ? { animated: false, height, width }
        : undefined;
    }
    offset += segmentLength;
  }

  return undefined;
}

function webpMetadata(bytes: Uint8Array): RasterImageMetadata | undefined {
  if (
    bytes.length < 20
    || ascii(bytes, 0, 4) !== "RIFF"
    || ascii(bytes, 8, 12) !== "WEBP"
  ) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dimensions: Omit<RasterImageMetadata, "animated"> | undefined;
  let animated = false;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (end > bytes.length) return undefined;

    if (type === "VP8X" && length >= 10) {
      animated ||= (bytes[dataOffset] & 0x02) !== 0;
      dimensions = {
        width: uint24le(bytes, dataOffset + 4) + 1,
        height: uint24le(bytes, dataOffset + 7) + 1,
      };
    } else if (
      type === "VP8 "
      && length >= 10
      && bytes[dataOffset + 3] === 0x9d
      && bytes[dataOffset + 4] === 0x01
      && bytes[dataOffset + 5] === 0x2a
    ) {
      dimensions ??= {
        width: view.getUint16(dataOffset + 6, true) & 0x3fff,
        height: view.getUint16(dataOffset + 8, true) & 0x3fff,
      };
    } else if (type === "VP8L" && length >= 5 && bytes[dataOffset] === 0x2f) {
      dimensions ??= {
        width: 1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8),
        height: 1
          + ((bytes[dataOffset + 2] & 0xc0) >> 6)
          + (bytes[dataOffset + 3] << 2)
          + ((bytes[dataOffset + 4] & 0x0f) << 10),
      };
    } else if (type === "ANIM" || type === "ANMF") {
      animated = true;
    }

    offset = end + (length % 2);
  }

  return dimensions && dimensions.width > 0 && dimensions.height > 0
    ? { ...dimensions, animated }
    : undefined;
}

export function readRasterImageMetadata(
  bytes: Uint8Array,
  contentType: string,
): RasterImageMetadata | undefined {
  if (contentType === "image/png") return pngMetadata(bytes);
  if (contentType === "image/jpeg") return jpegMetadata(bytes);
  if (contentType === "image/webp") return webpMetadata(bytes);
  return undefined;
}

export function hasSafeRasterDimensions(
  metadata: RasterImageMetadata | undefined,
  maxDimension: number,
  maxPixels: number,
): metadata is RasterImageMetadata {
  if (!metadata || metadata.animated) return false;
  return metadata.width <= maxDimension
    && metadata.height <= maxDimension
    && metadata.width * metadata.height <= maxPixels;
}
