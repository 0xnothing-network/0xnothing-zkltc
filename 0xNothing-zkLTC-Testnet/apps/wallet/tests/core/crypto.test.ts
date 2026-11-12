import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptJson,
  decryptWithKey,
  deriveKey,
  encryptJson,
  exportKey,
  importKey,
  keyForBlob,
  sealJson,
} from "../../src/core/keyring/crypto.ts";

test("vault encryption round-trips with authenticated ciphertext", async () => {
  const secret = { mnemonic: "test words", imported: [] };
  const blob = await encryptJson(secret, "correct horse battery staple");
  assert.deepEqual(await decryptJson(blob, "correct horse battery staple"), secret);
  await assert.rejects(() => decryptJson(blob, "wrong password"));
});

test("vault parsing rejects hostile KDF and encoded-field sizes before decrypting", async () => {
  const blob = await encryptJson({ ok: true }, "password-123");
  await assert.rejects(() => decryptJson({ ...blob, iterations: 2_000_001 }, "password-123"));
  await assert.rejects(() => decryptJson({ ...blob, salt: "AA==" }, "password-123"));
  await assert.rejects(() => decryptJson({ ...blob, iv: "not base64" }, "password-123"));
  await assert.rejects(() => decryptJson({ ...blob, data: "AA==" }, "password-123"));
});

test("key material imports enforce the AES-256 and PBKDF2 parameter bounds", async () => {
  await assert.rejects(() => importKey("AA=="));
  await assert.rejects(() => deriveKey("password-123", new Uint8Array(16), 2_000_001));
  await assert.rejects(() => deriveKey("password-123", new Uint8Array(8)));
});

test("sealing returns the key its blob was encrypted with, so no second derivation is needed", async () => {
  const { blob, key } = await sealJson({ phrase: "kept" }, "correct horse battery staple");
  assert.deepEqual(await decryptWithKey(blob, key), { phrase: "kept" });
  assert.deepEqual(await decryptJson(blob, "correct horse battery staple"), { phrase: "kept" });
  assert.equal(await exportKey(key), await exportKey(await keyForBlob(blob, "correct horse battery staple")));
});
