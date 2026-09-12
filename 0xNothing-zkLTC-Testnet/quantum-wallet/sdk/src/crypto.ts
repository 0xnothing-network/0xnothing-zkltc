// SPDX-License-Identifier: MIT
// Low-level byte helpers + a single viem import for keccak256.
// All encodings deliberately mirror Solidity `abi.encodePacked` semantics so that
// what the SDK computes equals what the contract computes.

import { keccak256 } from "viem";

export type Bytes = Uint8Array;
export type Hex = `0x${string}`;

/** Concatenate byte arrays. */
export function cat(...parts: Bytes[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One byte. */
export function u8(v: number): Bytes {
  return Uint8Array.of(v & 0xff);
}

/** uint16 big-endian (matches abi.encodePacked(uint16)). */
export function u16(v: number): Bytes {
  return Uint8Array.of((v >>> 8) & 0xff, v & 0xff);
}

/** uint32 big-endian (matches abi.encodePacked(uint32)). */
export function u32(v: number): Bytes {
  return Uint8Array.of(
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  );
}

/** uint256 big-endian (matches abi.encodePacked(uint256)). */
export function u256(v: bigint | number): Bytes {
  let n = BigInt(v);
  if (n < 0n || n >= 1n << 256n) throw new Error("u256 overflow");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** UTF-8 bytes of a string (matches abi.encodePacked("literal")). */
export function utf8(s: string): Bytes {
  return new TextEncoder().encode(s);
}

/** 20-byte address from a 0x-hex string (checksummed or not). */
export function addrBytes(a: Hex): Bytes {
  const raw = a.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`bad address: ${a}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Raw bytes of a 0x-hex string (must be even-length). */
export function hexBytes(h: Hex): Bytes {
  const raw = h.slice(2);
  if (raw.length % 2 !== 0) throw new Error(`odd-length hex: ${h}`);
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = NIBBLE[raw.charCodeAt(i * 2)] ?? 255;
    const lo = NIBBLE[raw.charCodeAt(i * 2 + 1)] ?? 255;
    if (hi === 255 || lo === 255) throw new Error(`bad hex: ${h}`);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/**
 * ASCII hex digit -> nibble, 255 for anything else.
 *
 * This decode sits on the hot path: every chainStep ends in
 * `hexBytes(keccak256(...))` and a single tree build makes ~1M of those calls.
 * The obvious `parseInt(raw.slice(i*2, i*2+2), 16)` allocates a two-char string
 * per byte before parsing it, so a table lookup measurably beats it — and the
 * result is identical because the inputs here are always lowercase 0x-hex
 * produced by viem's keccak256.
 */
const NIBBLE = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < 10; i++) t[0x30 + i] = i; // '0'-'9'
  for (let i = 0; i < 6; i++) {
    t[0x41 + i] = 10 + i; // 'A'-'F'
    t[0x61 + i] = 10 + i; // 'a'-'f'
  }
  return t;
})();

/** 0x-hex from bytes. */
export function toHex(b: Bytes): Hex {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as Hex;
}

/** keccak256 -> 32 raw bytes. */
export function keccak(...parts: Bytes[]): Bytes {
  return hexBytes(keccak256(cat(...parts)) as Hex);
}

/** sha256 (used for the icon-codec checksum), async, WebCrypto in browser+node. */
export async function sha256(b: Bytes): Promise<Bytes> {
  // `as BufferSource`: TS types Uint8Array over ArrayBufferLike (it could be
  // SharedArrayBuffer-backed) while WebCrypto wants a plain ArrayBuffer view.
  // Every Bytes in this SDK is ArrayBuffer-backed, so the assertion is sound.
  const buf = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return new Uint8Array(buf);
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
