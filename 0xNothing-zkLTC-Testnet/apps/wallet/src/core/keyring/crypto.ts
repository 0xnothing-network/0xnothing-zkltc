/**
 * Vault encryption primitives. WebCrypto only — no crypto dependency is added
 * to a bundle that holds a seed phrase.
 *
 * Scheme: PBKDF2-SHA256(password, 16-byte random salt, 600k iterations)
 *         -> AES-GCM-256 key -> AES-GCM(12-byte random IV) over the plaintext.
 *
 * 600k iterations is above the OWASP 2023 floor for PBKDF2-SHA256 and costs
 * roughly a quarter second on a laptop — paid once per unlock, not per read.
 */
export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AES_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
const MIN_PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const MAX_CIPHERTEXT_BYTES = 1_048_576;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface EncryptedBlob {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  /** base64 */
  salt: string;
  /** base64 */
  iv: string;
  /** base64, ciphertext with the GCM tag appended */
  data: string;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodedBase64(value: unknown, maxBytes: number): Uint8Array {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > Math.ceil(maxBytes / 3) * 4
    || !BASE64.test(value)
  ) {
    throw new Error("Invalid encrypted wallet data");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new Error("Invalid encrypted wallet data");
  }
  if (bytes.length > maxBytes) throw new Error("Invalid encrypted wallet data");
  return bytes;
}

function validatedBlob(blob: EncryptedBlob): {
  blob: EncryptedBlob;
  salt: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
} {
  const value = blob as unknown as Record<string, unknown> | null;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.v !== 1
    || value.kdf !== "PBKDF2-SHA256"
    || !Number.isInteger(value.iterations)
    || (value.iterations as number) < MIN_PBKDF2_ITERATIONS
    || (value.iterations as number) > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("Invalid encrypted wallet data");
  }
  const decoded: Uint8Array[] = [];
  try {
    const salt = decodedBase64(value.salt, SALT_BYTES);
    decoded.push(salt);
    const iv = decodedBase64(value.iv, IV_BYTES);
    decoded.push(iv);
    const data = decodedBase64(value.data, MAX_CIPHERTEXT_BYTES);
    decoded.push(data);
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || data.length < GCM_TAG_BYTES) {
      throw new Error("Invalid encrypted wallet data");
    }
    return { blob: value as unknown as EncryptedBlob, salt, iv, data };
  } catch (error) {
    for (const bytes of decoded) bytes.fill(0);
    throw error;
  }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (
    salt.length !== SALT_BYTES
    || !Number.isInteger(iterations)
    || iterations < MIN_PBKDF2_ITERATIONS
    || iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("Invalid key derivation parameters");
  }
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      passwordBytes,
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      // extractable: the raw key is handed to session storage so the wallet can
      // stay unlocked across popup closes without keeping the password anywhere.
      true,
      ["encrypt", "decrypt"],
    );
  } finally {
    passwordBytes.fill(0);
  }
}

export async function encryptJson(value: unknown, password: string): Promise<EncryptedBlob> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  let ciphertext: Uint8Array | undefined;
  try {
    const key = await deriveKey(password, salt);
    ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext,
    ));
    return {
      v: 1,
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      data: bytesToBase64(ciphertext),
    };
  } finally {
    plaintext.fill(0);
    ciphertext?.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

/** Throws if the password is wrong — AES-GCM tag verification fails closed. */
export async function decryptJson<T>(blob: EncryptedBlob, password: string): Promise<T> {
  const checked = validatedBlob(blob);
  try {
    const key = await deriveKey(password, checked.salt, checked.blob.iterations);
    return await decryptValidated<T>(checked, key);
  } catch (error) {
    checked.salt.fill(0);
    checked.iv.fill(0);
    checked.data.fill(0);
    throw error;
  }
}

export async function decryptWithKey<T>(blob: EncryptedBlob, key: CryptoKey): Promise<T> {
  return decryptValidated<T>(validatedBlob(blob), key);
}

async function decryptValidated<T>(
  checked: ReturnType<typeof validatedBlob>,
  key: CryptoKey,
): Promise<T> {
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: checked.iv as BufferSource },
      key,
      checked.data as BufferSource,
    ));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } finally {
    plaintext?.fill(0);
    checked.salt.fill(0);
    checked.iv.fill(0);
    checked.data.fill(0);
  }
}

/** Re-derives the key for an existing blob so its salt/iterations are reused. */
export async function keyForBlob(blob: EncryptedBlob, password: string): Promise<CryptoKey> {
  const checked = validatedBlob(blob);
  try {
    return await deriveKey(password, checked.salt, checked.blob.iterations);
  } finally {
    checked.salt.fill(0);
    checked.iv.fill(0);
    checked.data.fill(0);
  }
}

export async function exportKey(key: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    return bytesToBase64(bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function importKey(raw: string): Promise<CryptoKey> {
  const bytes = decodedBase64(raw, AES_KEY_BYTES);
  try {
    if (bytes.length !== AES_KEY_BYTES) throw new Error("Invalid session key");
    return await crypto.subtle.importKey(
      "raw",
      bytes as BufferSource,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}
