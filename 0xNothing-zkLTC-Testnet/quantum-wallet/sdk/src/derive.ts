// SPDX-License-Identifier: MIT
// Deterministic derivation from the user's 256-bit secret. The secret itself is
// NEVER sent on-chain or to the relayer; everything the wallet needs (its signing
// tree, the vault wrap key) is derived offline here.
//
// Root-of-trust flow:
//   secret (32B, from icons) --keccak--> treeSeed
//   treeSeed --WOTS/Merkle--> root0   (committed to the QuantumWallet at deploy)
//   secret --HKDF-ish--> vaultKey     (optional at-rest AES wrap, dev-managed)
//   secret --keccak--> changeSeed     (per-op churn in phase-4 optional hardening)
//
// Key rotation WITHOUT changing the wallet address = derive a new treeSeed from a
// NEW secret, build a fresh tree, then submit a signed rotateRoot(newRoot) op.

import { keccak, utf8 } from "./crypto.ts";
import type { Bytes } from "./crypto.ts";

const TREE_SEED_INFO = "0xQ/tree-seed/v1";

/** Tree seed for the WOTS/Merkle signer. Public root commits to this wallet. */
export function treeSeedFromSecret(secret: Bytes): Bytes {
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return keccak(secret, utf8(TREE_SEED_INFO));
}

/** Encrypt `plaintext` under a user passphrase (PBKDF2-SHA256 600k + AES-GCM-256).
 * WebCrypto; usable in the extension and in Node 20+. */
export async function wrapVault(
  passphrase: string,
  plaintext: Bytes,
): Promise<{ ciphertext: Bytes; salt: Bytes; iv: Bytes }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: 600_000,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  // `as BufferSource` on every Bytes handed to WebCrypto: TS types Uint8Array
  // over ArrayBufferLike, WebCrypto wants a plain ArrayBuffer view. Sound here —
  // these are all ArrayBuffer-backed — and a no-op at runtime.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext as BufferSource),
  );
  return { ciphertext, salt, iv };
}

/** Inverse of wrapVault. Throws on wrong passphrase (AES-GCM auth failure). */
export async function unwrapVault(
  passphrase: string,
  salt: Bytes,
  iv: Bytes,
  ciphertext: Bytes,
): Promise<Bytes> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: 600_000,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
}
