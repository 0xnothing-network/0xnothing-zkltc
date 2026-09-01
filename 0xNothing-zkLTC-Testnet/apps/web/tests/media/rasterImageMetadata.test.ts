import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSafeRasterDimensions,
  readRasterImageMetadata,
} from "../../lib/server/rasterImageMetadata.ts";

function png(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(33 + (animated ? 20 : 0));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  if (animated) {
    view.setUint32(33, 8, false);
    bytes.set([0x61, 0x63, 0x54, 0x4c], 37);
  }
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(23);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  bytes.set([0xff, 0xd9], 21);
  return bytes;
}

function webp(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  view.setUint32(16, 10, true);
  bytes[20] = animated ? 0x02 : 0;
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes.set([
    encodedWidth & 0xff,
    (encodedWidth >> 8) & 0xff,
    (encodedWidth >> 16) & 0xff,
  ], 24);
  bytes.set([
    encodedHeight & 0xff,
    (encodedHeight >> 8) & 0xff,
    (encodedHeight >> 16) & 0xff,
  ], 27);
  return bytes;
}

test("reads PNG, JPEG, and WebP dimensions without native image libraries", () => {
  assert.deepEqual(readRasterImageMetadata(png(320, 240), "image/png"), {
    animated: false,
    height: 240,
    width: 320,
  });
  assert.deepEqual(readRasterImageMetadata(jpeg(640, 480), "image/jpeg"), {
    animated: false,
    height: 480,
    width: 640,
  });
  assert.deepEqual(readRasterImageMetadata(webp(96, 72), "image/webp"), {
    animated: false,
    height: 72,
    width: 96,
  });
});

test("rejects animated and oversized image metadata", () => {
  const animatedPng = readRasterImageMetadata(png(96, 96, true), "image/png");
  const animatedWebp = readRasterImageMetadata(webp(96, 96, true), "image/webp");
  const oversized = readRasterImageMetadata(png(4096, 4096), "image/png");

  assert.equal(hasSafeRasterDimensions(animatedPng, 4096, 4_194_304), false);
  assert.equal(hasSafeRasterDimensions(animatedWebp, 4096, 4_194_304), false);
  assert.equal(hasSafeRasterDimensions(oversized, 4096, 4_194_304), false);
});

test("rejects malformed or mismatched image data", () => {
  assert.equal(readRasterImageMetadata(new Uint8Array(24), "image/png"), undefined);
  assert.equal(readRasterImageMetadata(png(96, 96), "image/jpeg"), undefined);
  assert.equal(readRasterImageMetadata(webp(96, 96).subarray(0, 20), "image/webp"), undefined);
});
