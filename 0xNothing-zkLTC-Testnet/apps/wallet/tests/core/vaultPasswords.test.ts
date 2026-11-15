import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

const PHRASE = "test test test test test test test test test test test junk";
const NFC_PASSWORD = "mật khẩu ví 2026".normalize("NFC");
const NFD_PASSWORD = NFC_PASSWORD.normalize("NFD");
let server: ViteDevServer | null = null;

async function load() {
  server ??= await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const [vault, crypto, storage, keys] = await Promise.all([
    server.ssrLoadModule("/src/core/keyring/vault.ts") as Promise<
      typeof import("../../src/core/keyring/vault.ts")
    >,
    server.ssrLoadModule("/src/core/keyring/crypto.ts") as Promise<
      typeof import("../../src/core/keyring/crypto.ts")
    >,
    server.ssrLoadModule("/src/core/platform/storage.ts") as Promise<
      typeof import("../../src/core/platform/storage.ts")
    >,
    server.ssrLoadModule("/src/core/platform/storageKeys.ts") as Promise<
      typeof import("../../src/core/platform/storageKeys.ts")
    >,
  ]);
  return { vault, crypto, ...storage, ...keys };
}

after(async () => {
  await server?.close();
});

/** Counts PBKDF2 runs: every password derivation goes through subtle.deriveKey. */
async function derivations<T>(run: () => Promise<T>): Promise<{ result: T; count: number }> {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.deriveKey;
  let count = 0;
  subtle.deriveKey = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto["deriveKey"]>) {
    count += 1;
    return original.apply(this, args);
  } as SubtleCrypto["deriveKey"];
  try {
    return { result: await run(), count };
  } finally {
    subtle.deriveKey = original;
  }
}

/** A vault blob exactly as 1.0.9 wrote it: the password bytes as typed, no `pw` tag. */
async function legacyVault(password: string): Promise<void> {
  const { vault, crypto, persistentStore, STORAGE_KEYS } = await load();
  await vault.wipeWallet();
  await vault.createVault("correct horse battery staple", PHRASE);
  await vault.lock();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic: PHRASE, imported: [] }));
  const data = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  await persistentStore.set(STORAGE_KEYS.vault, {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: crypto.PBKDF2_ITERATIONS,
    salt: crypto.bytesToBase64(salt),
    iv: crypto.bytesToBase64(iv),
    data: crypto.bytesToBase64(data),
  });
}

test("a 1.0.9 vault sealed from an NFD password opens with the NFD and the NFC form", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await load();
  try {
    await legacyVault(NFD_PASSWORD);
    const typed = await derivations(() => vault.unlock(NFD_PASSWORD));
    assert.equal(typed.result.mnemonic, PHRASE);
    assert.equal(typed.count, 1, "the typed form is tried first");
    await vault.lock();
    const other = await derivations(() => vault.unlock(NFC_PASSWORD));
    assert.equal(other.result.mnemonic, PHRASE);
    assert.equal(other.count, 2);
    // A legacy unlock rewrites nothing.
    assert.equal((await persistentStore.get<{ pw?: string }>(STORAGE_KEYS.vault))?.pw, undefined);
  } finally {
    await vault.wipeWallet();
  }
});

test("a 1.0.9 vault sealed from an NFC password opens with the NFC and the NFD form", async () => {
  const { vault } = await load();
  try {
    await legacyVault(NFC_PASSWORD);
    assert.equal((await derivations(() => vault.unlock(NFC_PASSWORD))).count, 1);
    await vault.lock();
    assert.equal((await vault.unlock(NFD_PASSWORD)).mnemonic, PHRASE);
  } finally {
    await vault.wipeWallet();
  }
});

test("a 1.0.9 vault with an ASCII password derives once, right or wrong", async () => {
  const { vault } = await load();
  try {
    await legacyVault("correct horse battery staple");
    assert.equal((await derivations(() => vault.unlock("correct horse battery staple"))).count, 1);
    await vault.lock();
    const wrong = await derivations(() => vault.unlock("wrong horse battery staple").catch((error) => error));
    assert.equal((wrong.result as Error).name, "WrongPasswordError");
    assert.equal(wrong.count, 1);
  } finally {
    await vault.wipeWallet();
  }
});

test("every reseal writes a tagged blob that opens from either typed form", async () => {
  const { vault, persistentStore, STORAGE_KEYS } = await load();
  const tag = async () => (await persistentStore.get<{ pw?: string }>(STORAGE_KEYS.vault))?.pw;
  await vault.wipeWallet();
  try {
    await vault.createVault(NFD_PASSWORD, PHRASE);
    assert.equal(await tag(), "nfc");
    await vault.lock();
    assert.equal((await derivations(() => vault.unlock(NFC_PASSWORD))).count, 1);
    await vault.lock();
    assert.equal((await derivations(() => vault.unlock(NFD_PASSWORD))).count, 1);

    await legacyVault(NFD_PASSWORD);
    await vault.importPrivateKey(NFD_PASSWORD, `0x${"1".padStart(64, "0")}`);
    assert.equal(await tag(), "nfc");
    await vault.lock();
    assert.equal((await vault.unlock(NFC_PASSWORD)).imported.length, 1);

    await legacyVault(NFC_PASSWORD);
    await vault.changePassword(NFC_PASSWORD, `${NFD_PASSWORD} mới`);
    assert.equal(await tag(), "nfc");
    await vault.lock();
    assert.equal((await vault.unlock(`${NFC_PASSWORD} mới`.normalize("NFC"))).mnemonic, PHRASE);
  } finally {
    await vault.wipeWallet();
  }
});

test("new passwords are refused for length, repeats, runs and the common list", async () => {
  const { vault } = await load();
  const table: [string, string | null][] = [
    ["short1!", "onb.shortPassword"],
    ["🔐🔑🗝🔒", "onb.shortPassword"],
    ["🔐🔑🗝🔒🔐🔑🗝🔒", null],
    ["aaaaaaaa", "pwd.repeated"],
    ["AAAAaaaa", "pwd.repeated"],
    ["12345678", "pwd.sequence"],
    ["87654321", "pwd.sequence"],
    ["ABCDEFGH", "pwd.sequence"],
    ["password1", "pwd.tooCommon"],
    ["PassWord123", "pwd.tooCommon"],
    ["matkhau123", "pwd.tooCommon"],
    ["correct horse battery staple", null],
    [NFD_PASSWORD, null],
  ];
  for (const [password, problem] of table) {
    assert.equal(vault.passwordProblem(password), problem, password);
  }
  assert.equal(vault.passwordStrength("password1"), "weak");
  assert.equal(vault.passwordStrength("tulip-harbor"), "strong");
  assert.equal(vault.passwordStrength("correct horse battery staple"), "strong");
});

test("create and change refuse a listed password; a weak 1.0.9 password still unlocks", async () => {
  const { vault } = await load();
  await vault.wipeWallet();
  try {
    await assert.rejects(vault.createVault("password1", PHRASE), /too common/u);
    assert.equal(await vault.hasVault(), false);

    await legacyVault("aaaaaaaa");
    assert.equal((await vault.unlock("aaaaaaaa")).mnemonic, PHRASE);
    await assert.rejects(vault.changePassword("aaaaaaaa", "12345678"), /sequences/u);
    await vault.lock();
    assert.equal((await vault.unlock("aaaaaaaa")).mnemonic, PHRASE);
  } finally {
    await vault.wipeWallet();
  }
});

test("every listed common password is long enough to reach the list", async () => {
  const { vault } = await load();
  const source = readFileSync(new URL("../../src/core/keyring/vault.ts", import.meta.url), "utf8");
  const list = source.match(/const COMMON_PASSWORDS = new Set\(`([^`]*)`/u)?.[1] ?? "";
  const entries = list.split(/\s+/u).filter(Boolean);
  assert.ok(entries.length > 100, String(entries.length));
  for (const entry of entries) {
    // A shorter entry is refused for length first, so it would be dead.
    assert.ok([...entry].length >= vault.MIN_WALLET_PASSWORD_LENGTH, entry);
    assert.notEqual(vault.passwordProblem(entry), null, entry);
  }
});

test("the password notes address the user as their locale does elsewhere", () => {
  const locale = (code: string): string =>
    readFileSync(new URL(`../../src/core/i18n/locales/${code}.ts`, import.meta.url), "utf8");
  const de = locale("de");
  for (const key of ["pwd.tooCommon", "pwd.sequence", "pwd.hint"]) {
    const line = de.split("\n").find((entry) => entry.includes(`"${key}": "`)) ?? "";
    assert.ok(line.length > 0, key);
    assert.match(line, /\bSie\b/u, `${key} uses the formal Sie`);
    assert.doesNotMatch(line, /\b(?:Wähle|Vermeide|Nimm|du|dein)\b/u, key);
  }
  // One word is named first, then "it": the object pronoun is singular.
  assert.match(locale("fr"), /"onb\.verifyIntro": "[^"]*touchez-en un ou tapez-le\."/u);
  assert.match(locale("es"), /"onb\.verifyIntro": "[^"]*toca una o escríbela\."/u);
});
