import { type Address, bytesToHex, type Hex, isAddress } from "viem";
import { type HDAccount, mnemonicToAccount, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_LOCALE, isLocaleCode, type LocaleCode, t } from "../i18n";
import {
  litvmRpcOverride,
  LITVM_NETWORK,
  MAX_CUSTOM_NETWORKS,
  normalizeCustomNetworks,
  resolveNetwork,
  sanitizeCustomNetwork,
  type WalletNetwork,
} from "../../config/networks";
import { isExtension } from "../platform/env";
import { persistentStore, sessionStore } from "../platform/storage";
import { AUTOLOCK_ALARM, STORAGE_KEYS } from "../platform/storageKeys";
import { withNamedLock } from "../platform/locks";
import {
  decryptWithKey,
  type EncryptedBlob,
  sealJson,
  exportKey,
  importKey,
  keyForBlob,
  passwordForms,
} from "./crypto";
import { checkMnemonic, newMnemonic } from "./mnemonic";

/**
 * The keyring.
 *
 * On disk there is exactly one secret: an AES-GCM blob over
 * `{ mnemonic, imported[] }`. Everything else — addresses, labels, which
 * account is active — is public metadata kept in the clear so the UI can render
 * a locked wallet without touching key material.
 *
 * While unlocked, the *derived AES key* (not the password, not the mnemonic)
 * lives in session storage: chrome.storage.session on the extension, a plain
 * in-process Map on Android. Both are memory-only. Any read of the secret
 * re-decrypts the blob, so locking is a single delete with nothing left behind.
 */

export interface VaultSecret {
  mnemonic: string;
  /** Keys imported outside the HD tree. */
  imported: Hex[];
}

export const MIN_WALLET_PASSWORD_LENGTH = 8;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/u;

function isVaultSecret(value: unknown): value is VaultSecret {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const secret = value as Partial<VaultSecret>;
  return typeof secret.mnemonic === "string"
    && secret.mnemonic.length > 0
    && secret.mnemonic.length <= 1_024
    && Array.isArray(secret.imported)
    && secret.imported.length <= 10_000
    && secret.imported.every((key) => typeof key === "string" && PRIVATE_KEY.test(key));
}

/**
 * Passwords at the top of every cracking list, lowercase, 8 characters or more
 * (anything shorter is refused by length already). An offline copy of the vault
 * costs one PBKDF2 run per guess, so these would fall in the first minutes.
 */
const COMMON_PASSWORDS = new Set(`
  password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword
  pa55word password! password@ passwort motdepasse contrasena contraseña senha123
  parola123 matkhau1 matkhau123 mypassword changeme
  12345678 123456789 1234567890 0123456789 11111111 111111111 1111111111 00000000
  000000000 12341234 12121212 123123123 12344321 11223344 13579246 147258369
  159753456 123654789 147852369 741852963 963852741 789456123 456789123 654321abc
  123qweasd 123qweasdzxc qwerty123 qwerty1234 qwertyui qwertyuiop qwerty12 qwer1234
  1234qwer 1q2w3e4r 1q2w3e4r5t q1w2e3r4 q1w2e3r4t5 1qaz2wsx 1qazxsw2 zaq12wsx
  zaq1zaq1 12qwaszx qazwsxedc asdfghjk asdfghjkl asdf1234 zxcvbnm1 zxcvbnm123
  qwertyqwerty 12345qwert qwe12345 asd12345 zxc12345 abc12345 abcd1234 1234abcd
  abc123456 abcdefg1 abcdefgh1 12345abc a1b2c3d4 aa123456 aa112233 aaaa1111
  a12345678 12345678a 123456789a 1234567a 123456aa
  iloveyou iloveyou1 iloveyou2 iloveu123 loveyou1 lovelove anhyeuem anhyeuem123
  emyeuanh yeuemnhieu sunshine sunshine1 princess princess1 football football1
  baseball basketball superman superstar batman123 starwars pokemon1 pokemon123
  whatever trustno1 welcome1 welcome! welcome123 letmein1 letmein123 hello123
  hello1234 helloworld secret123 killer123 hunter12 hunter123 cookie123 monkey123
  dragon123 master123 shadow123 michael1 jennifer jordan23 charlie1 freedom1
  mustang1 harley123 liverpool chelsea1 arsenal1 manchester barcelona madrid123
  admin123 admin1234 administrator rootroot root1234 computer internet samsung1
  samsung123 iphone123 google123 facebook summer2024 summer2025 winter2024
  winter2025 spring2025 autumn2025 bitcoin1 bitcoin123 ethereum crypto123
  wallet123 metamask litecoin satoshi1 blockchain
`.trim().split(/\s+/u));

/** True when the whole text climbs or falls by one code point each step (12345678, hgfedcba). */
function isSequence(points: readonly string[]): boolean {
  const steps = new Set<number>();
  for (let i = 1; i < points.length; i += 1) {
    steps.add(points[i]!.codePointAt(0)! - points[i - 1]!.codePointAt(0)!);
    if (steps.size > 1) return false;
  }
  return steps.has(1) || steps.has(-1);
}

export type PasswordProblem = "onb.shortPassword" | "pwd.repeated" | "pwd.sequence" | "pwd.tooCommon";

/**
 * Why a NEW password is refused, or null. Applied only where a password is
 * created or changed: unlock never calls it, so a vault sealed under a weaker
 * password by an earlier build still opens. Read on the NFC form, the form the
 * vault is sealed from, and counted in code points so the screens and this
 * check agree on emoji and combining marks.
 */
export function passwordProblem(password: string): PasswordProblem | null {
  const form = password.normalize("NFC").toLowerCase();
  const points = [...form];
  if (points.length < MIN_WALLET_PASSWORD_LENGTH) return "onb.shortPassword";
  if (new Set(points).size === 1) return "pwd.repeated";
  if (isSequence(points)) return "pwd.sequence";
  if (COMMON_PASSWORDS.has(form)) return "pwd.tooCommon";
  return null;
}

export function passwordProblemText(problem: PasswordProblem): string {
  return t(problem, { min: MIN_WALLET_PASSWORD_LENGTH });
}

export type PasswordStrength = "weak" | "fair" | "strong";

/** A rough, non-blocking meter: length and character variety, nothing more. */
export function passwordStrength(password: string): PasswordStrength {
  if (passwordProblem(password) !== null) return "weak";
  const form = password.normalize("NFC");
  const length = [...form].length;
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}]/u]
    .filter((pattern) => pattern.test(form)).length;
  if (length >= 16 || (length >= 12 && classes >= 2)) return "strong";
  if (length >= 10 || classes >= 3) return "fair";
  return "weak";
}

function assertNewPassword(password: string): void {
  const problem = passwordProblem(password);
  if (problem !== null) throw new Error(passwordProblemText(problem));
}

export interface AccountMeta {
  address: Address;
  /**
   * The name the user typed, or "" for a never-renamed account — those are named
   * at display time by `accountLabel` so the default follows the UI language.
   */
  label: string;
  source: "hd" | "imported";
  /** HD address index, or the position in `imported` for imported keys. */
  index: number;
}

/**
 * Default names generated by builds that stored them in Vietnamese. Treated as
 * "never renamed" so an upgrade re-labels them in the chosen language instead of
 * leaving one screen in the old one.
 */
const LEGACY_DEFAULT_LABEL = /^(?:Ví Chính|Ví \d+|Nhập \d+)$/u;

/** What the UI shows for an account: the custom name, or a localised default. */
export function accountLabel(meta: AccountMeta): string {
  const custom = meta.label.trim();
  if (custom.length > 0 && !LEGACY_DEFAULT_LABEL.test(custom)) return custom;
  if (meta.source === "imported") return t("account.importedN", { n: meta.index + 1 });
  return meta.index === 0 ? t("account.main") : t("account.hdN", { n: meta.index + 1 });
}

export interface AccountsState {
  accounts: AccountMeta[];
  active: Address | null;
}

export interface WalletSettings {
  autoLockMinutes: number;
  slippageBps: number;
  /** UI language. English by default in every fresh install. */
  locale: LocaleCode;
  /** Background mode. Dark is the safe default for an existing install. */
  theme: WalletTheme;
  /** Selected built-in or locally configured EVM network. */
  networkId: string;
  /** RPC profiles entered by the user; never contains key material. */
  customNetworks: WalletNetwork[];
  /** Masks Home's total and list figures. Absent in 1.0.9 settings, read as false. */
  hideBalances: boolean;
  /** Opt-in OS notifications (extension only). Absent before 1.0.10, read as false. */
  notifications: boolean;
  /**
   * The user's own RPC for LiteForge, tried before the public endpoint (extension
   * only). Absent before 1.0.10; "" or anything invalid reads as unset.
   */
  litvmRpcUrl?: string;
}

/** "system" (1.0.10) follows the OS; an older build reads it as dark. */
export type WalletTheme = "dark" | "light" | "system";

export const DEFAULT_SETTINGS: WalletSettings = {
  autoLockMinutes: 15,
  slippageBps: 50,
  locale: DEFAULT_LOCALE,
  theme: "dark",
  networkId: LITVM_NETWORK.id,
  customNetworks: [],
  hideBalances: false,
  notifications: false,
};

export class WalletLockedError extends Error {
  constructor() {
    super(t("vault.locked"));
    this.name = "WalletLockedError";
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super(t("vault.wrongPassword"));
    this.name = "WrongPasswordError";
  }
}

/** Refused before any key derivation: too many wrong passwords in a row. */
export class UnlockThrottledError extends Error {
  constructor(readonly retryAt: number) {
    super(t("unlock.throttled", { seconds: secondsUntil(retryAt) }));
    this.name = "UnlockThrottledError";
  }
}

export function secondsUntil(at: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((at - now) / 1_000));
}

interface SessionRecord {
  key: string;
  /** Kept optional so sessions written by v1 can be read and migrated safely. */
  expiresAt?: number;
}

const SESSION_LOCK = "session";
const SETTINGS_LOCK = "settings";
const VAULT_LOCK = "vault";
const MAX_ACCOUNTS = 100;
const MAX_HD_INDEX = 100_000;

/* ---------------------------------------------------------------- settings */

export async function readSettings(): Promise<WalletSettings> {
  const stored = await persistentStore.get<Partial<WalletSettings>>(STORAGE_KEYS.settings);
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  const autoLock = Number(merged.autoLockMinutes);
  merged.autoLockMinutes = Number.isFinite(autoLock) && autoLock > 0 && autoLock <= 24 * 60
    ? Math.round(autoLock)
    : DEFAULT_SETTINGS.autoLockMinutes;
  const slippage = Number(merged.slippageBps);
  merged.slippageBps = Number.isFinite(slippage) && slippage >= 0 && slippage <= 5_000
    ? Math.round(slippage)
    : DEFAULT_SETTINGS.slippageBps;
  // A locale written by an older or hand-edited build must not reach the catalog.
  if (!isLocaleCode(merged.locale)) merged.locale = DEFAULT_LOCALE;
  if (merged.theme !== "light" && merged.theme !== "dark" && merged.theme !== "system") {
    merged.theme = DEFAULT_SETTINGS.theme;
  }
  merged.hideBalances = merged.hideBalances === true;
  merged.notifications = merged.notifications === true;
  // Unset reads as no key at all, so the settings of an install that never set
  // it look exactly as they did in 1.0.9.
  const litvmRpcUrl = litvmRpcOverride(merged.litvmRpcUrl);
  if (litvmRpcUrl === null) delete merged.litvmRpcUrl;
  else merged.litvmRpcUrl = litvmRpcUrl;
  merged.customNetworks = normalizeCustomNetworks(merged.customNetworks);
  merged.networkId = resolveNetwork(merged.networkId, merged.customNetworks).id;
  return merged;
}

export async function writeSettings(patch: Partial<WalletSettings>): Promise<WalletSettings> {
  return withNamedLock(SETTINGS_LOCK, async () => {
    const next = { ...(await readSettings()), ...patch };
    next.customNetworks = normalizeCustomNetworks(next.customNetworks);
    next.networkId = resolveNetwork(next.networkId, next.customNetworks).id;
    await persistentStore.set(STORAGE_KEYS.settings, next);
    return next;
  });
}

/**
 * Adds one network under the settings lock, re-reading the list first. Two
 * surfaces add networks (Settings and a dapp's proposal in the approval window);
 * writing a whole list from a screen's older copy would drop the other's entry.
 * A chain already saved, or the built-in one, is never replaced: "exists".
 */
export async function addCustomNetwork(
  candidate: WalletNetwork,
  options: { select: boolean },
): Promise<"added" | "exists"> {
  return withNamedLock(SETTINGS_LOCK, async () => {
    if (candidate.chainId === LITVM_NETWORK.chainId) return "exists";
    const network = sanitizeCustomNetwork(candidate);
    if (network === null) throw new Error(t("set.networkInvalid"));
    const current = await readSettings();
    if (current.customNetworks.some((entry) => entry.chainId === network.chainId)) return "exists";
    // normalizeCustomNetworks would silently drop the one past the cap.
    if (current.customNetworks.length >= MAX_CUSTOM_NETWORKS) throw new Error(t("set.networksFull"));
    const customNetworks = [...current.customNetworks, network];
    const next = {
      ...current,
      customNetworks,
      networkId: options.select ? network.id : current.networkId,
    };
    await persistentStore.set(STORAGE_KEYS.settings, next);
    return "added";
  });
}

/** Removes one saved network under the settings lock; the selection falls back to the built-in one. */
export async function removeCustomNetwork(networkId: string): Promise<WalletSettings> {
  return withNamedLock(SETTINGS_LOCK, async () => {
    const current = await readSettings();
    const customNetworks = current.customNetworks.filter((entry) => entry.id !== networkId);
    const next = {
      ...current,
      customNetworks,
      networkId: resolveNetwork(current.networkId, customNetworks).id,
    };
    await persistentStore.set(STORAGE_KEYS.settings, next);
    return next;
  });
}

/**
 * Points a saved network at another RPC in place, under the settings lock from a
 * fresh read. The chain must stay the same: the probe in Settings checked the new
 * URL answers it. The profile keeps its place and stays selected if it was; its
 * id follows the URL, while tokens and history are keyed by chain and stay.
 */
export async function replaceCustomNetworkRpc(oldId: string, candidate: WalletNetwork): Promise<WalletSettings> {
  return withNamedLock(SETTINGS_LOCK, async () => {
    const current = await readSettings();
    const index = current.customNetworks.findIndex((entry) => entry.id === oldId);
    if (index < 0) throw new Error(t("set.networkChanged"));
    const old = current.customNetworks[index]!;
    const network = sanitizeCustomNetwork(candidate);
    if (network === null || network.chainId !== old.chainId) throw new Error(t("set.networkInvalid"));
    if (network.id === old.id) return current;
    const customNetworks = current.customNetworks.map((entry, at) => (at === index
      ? { ...network, name: old.name, nativeCurrency: old.nativeCurrency, explorerUrl: old.explorerUrl }
      : entry));
    const next = {
      ...current,
      customNetworks,
      networkId: current.networkId === oldId ? network.id : current.networkId,
    };
    await persistentStore.set(STORAGE_KEYS.settings, next);
    return next;
  });
}

/* ------------------------------------------------------------------- vault */

async function readVaultBlob(): Promise<EncryptedBlob | null> {
  return persistentStore.get<EncryptedBlob>(STORAGE_KEYS.vault);
}

export async function hasVault(): Promise<boolean> {
  return (await readVaultBlob()) !== null;
}

/** The deadline is checked lazily here; the worker's alarm also drops the key on time once every wallet page is closed. */
function scheduleAutoLock(deadline: number): void {
  if (!isExtension || !chrome?.alarms) return;
  void chrome.alarms.create(AUTOLOCK_ALARM, { when: deadline }).catch(() => undefined);
}

async function putSession(key: CryptoKey): Promise<void> {
  await withNamedLock(SESSION_LOCK, async () => {
    const { autoLockMinutes } = await readSettings();
    const deadline = Date.now() + autoLockMinutes * 60_000;
    await sessionStore.setMany([
      [STORAGE_KEYS.session, { key: await exportKey(key) } satisfies SessionRecord],
      [STORAGE_KEYS.sessionDeadline, deadline],
    ]);
    scheduleAutoLock(deadline);
  });
}

/** Invalid persisted timestamps must never disable the auto-lock comparison. */
function sessionDeadline(stored: unknown, legacy: unknown): number {
  const value = stored ?? legacy;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The key, and the stored string it came from so a later delete can check it is still the same. */
async function sessionKey(): Promise<{ key: CryptoKey; raw: string } | null> {
  return withNamedLock(SESSION_LOCK, async () => {
    const [record, storedDeadline] = await Promise.all([
      sessionStore.get<SessionRecord>(STORAGE_KEYS.session),
      sessionStore.get<number>(STORAGE_KEYS.sessionDeadline),
    ]);
    if (!record) return null;
    const deadline = sessionDeadline(storedDeadline, record.expiresAt);
    if (deadline <= Date.now()) {
      await Promise.all([
        sessionStore.remove(STORAGE_KEYS.session),
        sessionStore.remove(STORAGE_KEYS.sessionDeadline),
      ]);
      return null;
    }
    try {
      return { key: await importKey(record.key), raw: record.key };
    } catch {
      await Promise.all([
        sessionStore.remove(STORAGE_KEYS.session),
        sessionStore.remove(STORAGE_KEYS.sessionDeadline),
      ]);
      return null;
    }
  });
}

export async function isUnlocked(): Promise<boolean> {
  return (await sessionKey()) !== null;
}

/** Pushes the auto-lock deadline out; called on any deliberate user action. */
export async function touchSession(): Promise<void> {
  await withNamedLock(SESSION_LOCK, async () => {
    const [record, storedDeadline] = await Promise.all([
      sessionStore.get<SessionRecord>(STORAGE_KEYS.session),
      sessionStore.get<number>(STORAGE_KEYS.sessionDeadline),
    ]);
    const deadline = sessionDeadline(storedDeadline, record?.expiresAt);
    if (!record || deadline <= Date.now()) return;
    const { autoLockMinutes } = await readSettings();
    // Only the deadline is written. A stale activity task can therefore never
    // put an AES key back after lock() removed it.
    const next = Date.now() + autoLockMinutes * 60_000;
    await sessionStore.set(STORAGE_KEYS.sessionDeadline, next);
    scheduleAutoLock(next);
  });
}

export async function lock(): Promise<void> {
  await withNamedLock(SESSION_LOCK, async () => {
    await Promise.all([
      sessionStore.remove(STORAGE_KEYS.session),
      sessionStore.remove(STORAGE_KEYS.sessionDeadline),
    ]);
  });
}

/** Removes the session only if it still holds `raw`; a fresher one written meanwhile stays. */
async function dropSessionIf(raw: string): Promise<void> {
  await withNamedLock(SESSION_LOCK, async () => {
    const record = await sessionStore.get<SessionRecord>(STORAGE_KEYS.session);
    if (record?.key !== raw) return;
    await Promise.all([
      sessionStore.remove(STORAGE_KEYS.session),
      sessionStore.remove(STORAGE_KEYS.sessionDeadline),
    ]);
  });
}

export async function getSecret(): Promise<VaultSecret> {
  // The key and the blob are read apart, outside VAULT_LOCK, so a password change
  // in another surface (new blob, then new key) can land between the two reads.
  // One more read, AES only, settles that; a key that still fails is stale.
  for (let attempt = 0; ; attempt += 1) {
    const [session, blob] = await Promise.all([sessionKey(), readVaultBlob()]);
    if (!session || !blob) throw new WalletLockedError();
    try {
      const secret = await decryptWithKey<unknown>(blob, session.key);
      if (!isVaultSecret(secret)) throw new Error("Invalid vault secret");
      return secret;
    } catch {
      if (attempt === 0) continue;
      // Treated as locked rather than as a corrupt vault, and only this key is
      // dropped: a plain lock() here would delete the session just written.
      await dropSessionIf(session.raw);
      throw new WalletLockedError();
    }
  }
}

/**
 * Tries each form `passwordForms` gives. A vault from 1.0.9 is tried with the
 * text exactly as typed before any normalised form, so no existing vault can
 * become unopenable; nothing is rewritten when a later form is the one that fits.
 */
async function openBlob(
  blob: EncryptedBlob,
  password: string,
): Promise<{ key: CryptoKey; secret: VaultSecret } | null> {
  for (const form of passwordForms(blob, password)) {
    try {
      const key = await keyForBlob(blob, form);
      const decrypted = await decryptWithKey<unknown>(blob, key);
      if (!isVaultSecret(decrypted)) throw new Error("Invalid vault secret");
      return { key, secret: decrypted };
    } catch {
      // The next form, if any.
    }
  }
  return null;
}

/**
 * Online guessing guard, shared by every path that checks the password (unlock,
 * reveal, import, change) on every surface, and kept across restarts. Five wrong
 * passwords are free; after that each one waits 30 s, doubling to 15 min. It
 * never wipes and never locks out for good. It does nothing against an offline
 * attack on a copied vault; the PBKDF2 cost is what answers that.
 */
interface UnlockGuard {
  failures: number;
  retryAt: number;
}

const FREE_FAILURES = 5;
const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

/**
 * A missing or unreadable record is no guard, so storage trouble can never brick
 * the wallet. The wait is clamped to 15 min from now, so a clock that was wrong
 * when it was written cannot stretch it.
 */
async function readUnlockGuard(now: number): Promise<UnlockGuard & { clamped: boolean }> {
  const raw = await persistentStore.get<unknown>(STORAGE_KEYS.unlockGuard).catch(() => null);
  const value = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const failures = Number.isSafeInteger(value.failures) && (value.failures as number) > 0
    ? Math.min(value.failures as number, 1_000)
    : 0;
  const stored = typeof value.retryAt === "number" && Number.isFinite(value.retryAt) ? value.retryAt : 0;
  const retryAt = Math.min(stored, now + MAX_DELAY_MS);
  return { failures, retryAt, clamped: retryAt < stored };
}

/** When the next password attempt is allowed, or 0. For the lock screen's countdown. */
export async function unlockRetryAt(): Promise<number> {
  const now = Date.now();
  const { retryAt } = await readUnlockGuard(now);
  return retryAt > now ? retryAt : 0;
}

async function unlockUnderVaultLock(password: string): Promise<VaultSecret> {
  const blob = await readVaultBlob();
  if (!blob) throw new WalletLockedError();
  // Before any derivation and outside the catch that maps to WrongPasswordError,
  // so a refused attempt costs no PBKDF2 run and is not itself counted.
  const now = Date.now();
  const guard = await readUnlockGuard(now);
  if (guard.clamped) {
    await persistentStore.set(STORAGE_KEYS.unlockGuard, { failures: guard.failures, retryAt: guard.retryAt })
      .catch(() => undefined);
  }
  if (now < guard.retryAt) throw new UnlockThrottledError(guard.retryAt);
  // Every password form tried is one attempt.
  const opened = await openBlob(blob, password);
  if (!opened) {
    const failures = guard.failures + 1;
    const retryAt = failures < FREE_FAILURES
      ? 0
      : Date.now() + Math.min(FIRST_DELAY_MS * 2 ** Math.min(failures - FREE_FAILURES, 10), MAX_DELAY_MS);
    await persistentStore.set(STORAGE_KEYS.unlockGuard, { failures, retryAt } satisfies UnlockGuard)
      .catch(() => undefined);
    throw new WrongPasswordError();
  }
  if (guard.failures > 0 || guard.retryAt > 0) {
    await persistentStore.remove(STORAGE_KEYS.unlockGuard).catch(() => undefined);
  }
  await putSession(opened.key);
  return opened.secret;
}

export function unlock(password: string): Promise<VaultSecret> {
  return withNamedLock(VAULT_LOCK, () => unlockUnderVaultLock(password));
}

/* ---------------------------------------------------------------- accounts */

export async function readAccounts(): Promise<AccountsState> {
  const raw = await persistentStore.get<unknown>(STORAGE_KEYS.accounts);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { accounts: [], active: null };
  }
  const value = raw as Record<string, unknown>;
  const source = Array.isArray(value.accounts) ? value.accounts.slice(0, MAX_ACCOUNTS) : [];
  const accounts: AccountMeta[] = [];
  const seen = new Set<string>();
  for (const candidate of source) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const candidateAddress = entry.address;
    if (typeof candidateAddress !== "string" || !isAddress(candidateAddress)) continue;
    if (entry.source !== "hd" && entry.source !== "imported") continue;
    const index = Number(entry.index);
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index > (entry.source === "hd" ? MAX_HD_INDEX : 10_000)
    ) continue;
    const key = candidateAddress.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = typeof entry.label === "string"
      && entry.label.length <= 24
      && !/[\u0000-\u001f\u007f]/u.test(entry.label)
      ? entry.label
      : "";
    accounts.push({ address: candidateAddress, label, source: entry.source, index });
  }
  const rawActive = value.active;
  const active = typeof rawActive === "string"
    ? accounts.find((entry) => entry.address.toLowerCase() === rawActive.toLowerCase())?.address
      ?? null
    : null;
  return { accounts, active };
}

async function writeAccounts(state: AccountsState): Promise<AccountsState> {
  await persistentStore.set(STORAGE_KEYS.accounts, state);
  return state;
}

function hdMeta(mnemonic: string, index: number, label?: string): AccountMeta {
  return {
    address: mnemonicToAccount(mnemonic, { addressIndex: index }).address,
    // No default text on disk: `accountLabel` names it in the current language.
    label: label ?? "",
    source: "hd",
    index,
  };
}

/* ------------------------------------------------------------ create/import */

export interface CreateVaultResult {
  mnemonic: string;
  accounts: AccountsState;
}

/**
 * Creates the vault and unlocks it. `phrase` is optional: onboarding generates a
 * fresh 12-word phrase, the import flow passes the user's own. Refuses to run if
 * a vault already exists — overwriting one would destroy funds.
 */
export async function createVault(
  password: string,
  phrase?: string,
): Promise<CreateVaultResult> {
  return withNamedLock(VAULT_LOCK, async () => {
    if (await hasVault()) throw new Error(t("vault.exists"));
    assertNewPassword(password);
    const checked = await checkMnemonic(phrase ?? newMnemonic());
    if (!checked.ok) {
      throw new Error(t("vault.badPhrase", { reason: t(`mnemonic.${checked.reason}`) }));
    }

    const secret: VaultSecret = { mnemonic: checked.phrase, imported: [] };
    const { blob, key } = await sealJson(secret, password);
    const first = hdMeta(secret.mnemonic, 0);
    const accounts = { accounts: [first], active: first.address } satisfies AccountsState;
    await persistentStore.setMany([
      [STORAGE_KEYS.vault, blob],
      [STORAGE_KEYS.accounts, accounts],
    ]);
    await putSession(key);
    return { mnemonic: secret.mnemonic, accounts };
  });
}

export async function addHdAccount(label?: string): Promise<AccountsState> {
  return withNamedLock(VAULT_LOCK, async () => {
    const secret = await getSecret();
    const state = await readAccounts();
    if (state.accounts.length >= MAX_ACCOUNTS) {
      throw new Error(`This wallet supports up to ${MAX_ACCOUNTS} accounts`);
    }
    const nextIndex = state.accounts.reduce(
      (max, meta) => (meta.source === "hd" ? Math.max(max, meta.index + 1) : max),
      0,
    );
    // An imported key can be the very key of the next HD index (the same seed's
    // account 2 imported from another wallet). Skip past every address already
    // listed rather than return the old list, which left Add account stuck for
    // good. HD indices can then have gaps; nothing reads them as contiguous.
    const taken = new Set(state.accounts.map((existing) => existing.address.toLowerCase()));
    let index = nextIndex;
    let meta = hdMeta(secret.mnemonic, index, label);
    while (taken.has(meta.address.toLowerCase())) {
      index += 1;
      if (index > MAX_HD_INDEX) throw new Error(`This wallet supports up to ${MAX_ACCOUNTS} accounts`);
      meta = hdMeta(secret.mnemonic, index, label);
    }
    return writeAccounts({ accounts: [...state.accounts, meta], active: meta.address });
  });
}

/** Adds a raw private key. Requires the password: it rewrites the vault blob. */
export async function importPrivateKey(
  password: string,
  privateKey: Hex,
  label?: string,
): Promise<AccountsState> {
  // A key the vault would refuse on read must never be sealed into it: one such
  // entry makes every later unlock fail.
  if (!PRIVATE_KEY.test(privateKey)) throw new Error(t("imp.badKey"));
  return withNamedLock(VAULT_LOCK, async () => {
    const secret = await unlockUnderVaultLock(password);
    const account = privateKeyToAccount(privateKey);
    const state = await readAccounts();
    const existing = state.accounts.find((meta) => meta.address === account.address);
    const opens = (index: number): boolean => {
      const stored = secret.imported[index];
      return stored !== undefined && privateKeyToAccount(stored).address === account.address;
    };
    if (existing && (existing.source === "hd" || opens(existing.index))) {
      return writeAccounts({ ...state, active: account.address });
    }
    if (!existing && state.accounts.length >= MAX_ACCOUNTS) {
      throw new Error(`This wallet supports up to ${MAX_ACCOUNTS} accounts`);
    }
    // Re-importing repairs a row whose key is missing: an import cut short on
    // Android can leave the account list written and the vault not.
    const found = secret.imported.findIndex((_, index) => opens(index));
    const imported = found >= 0 ? secret.imported : [...secret.imported, privateKey];
    const meta: AccountMeta = {
      address: account.address,
      label: label ?? existing?.label ?? "",
      source: "imported",
      index: found >= 0 ? found : imported.length - 1,
    };
    const accounts = existing
      ? {
        accounts: state.accounts.map((entry) => (entry === existing ? meta : entry)),
        active: meta.address,
      }
      : { accounts: [...state.accounts, meta], active: meta.address };
    if (found >= 0) {
      return writeAccounts(accounts);
    }
    const { blob, key } = await sealJson({ ...secret, imported } satisfies VaultSecret, password);
    await persistentStore.setMany([
      [STORAGE_KEYS.vault, blob],
      [STORAGE_KEYS.accounts, accounts],
    ]);
    await putSession(key);
    return accounts;
  });
}

export async function setActiveAccount(address: Address): Promise<AccountsState> {
  return withNamedLock(VAULT_LOCK, async () => {
    const state = await readAccounts();
    if (!state.accounts.some((meta) => meta.address === address)) return state;
    return writeAccounts({ ...state, active: address });
  });
}

export async function renameAccount(address: Address, label: string): Promise<AccountsState> {
  return withNamedLock(VAULT_LOCK, async () => {
    const state = await readAccounts();
    return writeAccounts({
      ...state,
      accounts: state.accounts.map((meta) => (meta.address === address ? { ...meta, label } : meta)),
    });
  });
}

/* ----------------------------------------------------------------- signing */

/**
 * Returns a viem account able to sign. Built on demand from the decrypted
 * secret and never cached, so a lock takes effect immediately everywhere.
 */
export async function signerFor(address: Address): Promise<HDAccount | PrivateKeyAccount> {
  const [secret, state] = await Promise.all([getSecret(), readAccounts()]);
  const meta = state.accounts.find(
    (candidate) => candidate.address.toLowerCase() === address.toLowerCase(),
  );
  if (!meta) throw new Error(t("vault.noAccount", { address }));
  return accountForMeta(secret, meta, address);
}

/** Public metadata selects a key but can never change the address being authorized. */
function accountForMeta(
  secret: VaultSecret,
  meta: AccountMeta,
  address: Address,
): HDAccount | PrivateKeyAccount {
  const imported = secret.imported[meta.index];
  if (meta.source === "imported" && !imported) {
    throw new Error(t("vault.noKey", { address }));
  }
  const account = meta.source === "hd"
    ? mnemonicToAccount(secret.mnemonic, { addressIndex: meta.index })
    : privateKeyToAccount(imported!);
  if (account.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(t("vault.noKey", { address }));
  }
  return account;
}

/* -------------------------------------------------------- reveal / rotate */

/** Password re-entry is required to show a secret, even while unlocked. */
export async function revealMnemonic(password: string): Promise<string> {
  return (await unlock(password)).mnemonic;
}

export async function revealPrivateKey(password: string, address: Address): Promise<Hex> {
  const secret = await unlock(password);
  const state = await readAccounts();
  const meta = state.accounts.find(
    (candidate) => candidate.address.toLowerCase() === address.toLowerCase(),
  );
  if (!meta) throw new Error(t("vault.noAccount", { address }));
  const account = accountForMeta(secret, meta, address);
  if (meta.source === "imported") {
    const key = secret.imported[meta.index];
    if (!key) throw new Error(t("vault.noKey", { address }));
    return key;
  }
  const hdKey = (account as HDAccount).getHdKey();
  if (!hdKey.privateKey) throw new Error(t("vault.keyUnreadable"));
  return bytesToHex(hdKey.privateKey);
}

export async function changePassword(current: string, next: string): Promise<void> {
  await withNamedLock(VAULT_LOCK, async () => {
    assertNewPassword(next);
    const secret = await unlockUnderVaultLock(current);
    const { blob, key } = await sealJson(secret, next);
    await persistentStore.set(STORAGE_KEYS.vault, blob);
    await putSession(key);
  });
}

/**
 * Destroys the wallet. Only the seed phrase can bring it back, which is why the
 * UI gates this behind an explicit typed confirmation.
 */
export async function wipeWallet(): Promise<void> {
  await withNamedLock(VAULT_LOCK, async () => {
    await lock();
    // Only the language and the theme survive: they say nothing about the
    // wallet, and without them the next boot paints in the old language from
    // the localStorage mirror, then flips to English once settings are read.
    const { locale, theme } = await readSettings();
    await Promise.all([
      persistentStore.remove(STORAGE_KEYS.vault),
      persistentStore.remove(STORAGE_KEYS.accounts),
      persistentStore.remove(STORAGE_KEYS.tokens),
      persistentStore.remove(STORAGE_KEYS.history),
      persistentStore.remove(STORAGE_KEYS.snapshots),
      persistentStore.remove(STORAGE_KEYS.connections),
      persistentStore.remove(STORAGE_KEYS.pending),
      persistentStore.remove(STORAGE_KEYS.resolved),
      // Custom RPC URLs can carry provider API keys, and the next wallet made on
      // this device must not start on the old network, so the record is
      // replaced by one that holds nothing but the language and the theme.
      persistentStore.set(STORAGE_KEYS.settings, { locale, theme }),
      persistentStore.remove(STORAGE_KEYS.unlockGuard),
      persistentStore.remove(STORAGE_KEYS.pendingStagedSwap),
      persistentStore.remove(STORAGE_KEYS.recipients),
      persistentStore.remove(STORAGE_KEYS.sendDraft),
      persistentStore.remove(STORAGE_KEYS.approvals),
      persistentStore.remove(STORAGE_KEYS.notified),
      persistentStore.remove(STORAGE_KEYS.notifyText),
      persistentStore.remove(STORAGE_KEYS.homeTab),
      persistentStore.remove(STORAGE_KEYS.swapPair),
      persistentStore.remove(STORAGE_KEYS.seenVersion),
    ]);
  });
}
