import type { Hex } from "viem";
import { readVaultQuantum, writeVaultQuantum } from "../keyring/vault";
import { persistentStore } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";

const HEX32 = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

/**
 * A signed intent that has left this device, or is about to.
 *
 * Written BEFORE the relayer is called, because a WOTS leaf is burned the
 * instant a signature over it exists — not when the transaction mines. Two
 * signatures over two different digests at one leaf hand anyone who holds both
 * (the relayer sees every request) enough chain values to forge a third, so
 * "re-sign the leaf with a fresh deadline" is never an option. The wallet
 * instead replays these exact bytes until the chain moves past `leafIndex`.
 */
export interface QuantumPending {
  kind: "execute" | "rotate";
  /** Leaf this signature consumed; replayable only while chain leafIndex == this. */
  leafIndex: number;
  /** Epoch it was signed under — a rotation retires that tree and voids it. */
  epoch: number;
  /** The exact relay request, re-POSTed verbatim on every retry. */
  request: unknown;
  /**
   * rotate only: the successor secret, parked here so that a rotation which
   * lands while the popup is closed can still be adopted locally. Without it a
   * confirmed rotation would leave the wallet signing with the retired tree.
   */
  successorEntropyHex?: Hex;
}

/**
 * Persisted 0xQuantum key material. The 24-icon string is the human backup;
 * this record holds the SAME 32-byte secret as hex plus the signing-tree epoch,
 * so the account can be rebuilt offline without asking for the icons again.
 *
 * It is stored inside the encrypted vault blob, under the wallet password —
 * same PBKDF2-SHA256 + AES-GCM treatment as the seed phrase. Reading it
 * therefore requires an unlocked vault, which the app's phase gate already
 * guarantees for every screen that can reach this module.
 */
export interface QuantumStored {
  /** Secret for the CURRENT epoch's signing tree; a rotation replaces it. */
  entropyHex: Hex;
  epoch: number;
  /**
   * The wallet's CREATE2 address, persisted rather than derived.
   *
   * The factory salts on the EPOCH-0 tree root, which is what keeps the address
   * stable across rotations. But a rotation overwrites `entropyHex` with the
   * successor secret, whose tree root is NOT that salt — so once rotated, the
   * address cannot be recomputed from anything else in this record. Absent only
   * on records written before this field existed, all of which are epoch 0.
   */
  address?: Hex;
  pending?: QuantumPending | null;
}

function uint32(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
}

/**
 * Validate the pending slot. `request` stays opaque on purpose: it is wire data
 * the relayer re-validates and re-simulates in full before spending any gas, so
 * checking its scalars here would duplicate that without adding a guarantee.
 */
function readPending(raw: unknown): QuantumPending | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  // Bind to a local before narrowing: control-flow narrowing of an index-signature
  // property access is not something to rely on.
  const kind = value.kind;
  if (kind !== "execute" && kind !== "rotate") return null;
  const leafIndex = uint32(value.leafIndex);
  const epoch = uint32(value.epoch);
  if (leafIndex === null || epoch === null) return null;
  if (value.request === null || typeof value.request !== "object") return null;
  const pending: QuantumPending = { kind, leafIndex, epoch, request: value.request };
  if (typeof value.successorEntropyHex === "string" && HEX32.test(value.successorEntropyHex)) {
    pending.successorEntropyHex = value.successorEntropyHex.toLowerCase() as Hex;
  }
  return pending;
}

/** Structural validation of a record read from either store. */
function parseStored(raw: unknown): QuantumStored | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.entropyHex !== "string" || !HEX32.test(value.entropyHex)) return null;
  const epoch = uint32(value.epoch);
  if (epoch === null) return null;
  const stored: QuantumStored = { entropyHex: value.entropyHex.toLowerCase() as Hex, epoch };
  // Kept in its checksummed form — every comparison against it is case-folded.
  if (typeof value.address === "string" && ADDRESS.test(value.address)) {
    stored.address = value.address as Hex;
  }
  const pending = readPending(value.pending);
  if (pending !== null) stored.pending = pending;
  return stored;
}

/**
 * Read the record from the encrypted vault, falling back once to the plaintext
 * slot that builds before this one wrote.
 *
 * Requires an unlocked vault — the record holds the one-time signing secret.
 * That always holds where this is called from: the app's phase gate renders
 * Unlock instead of any screen while the vault is closed, so no caller is
 * reachable with the vault shut.
 */
export async function readQuantum(): Promise<QuantumStored | null> {
  const fromVault = parseStored(await readVaultQuantum());
  if (fromVault !== null) return fromVault;
  // Migration. The vault read wins above, so this only runs for an install that
  // predates encryption, or one where an interrupted migration left the
  // plaintext copy behind. It is idempotent: the plaintext record is removed the
  // moment the same record is safely inside the vault.
  const legacy = parseStored(await persistentStore.get<unknown>(STORAGE_KEYS.quantum));
  if (legacy === null) return null;
  await writeVaultQuantum(legacy);
  await persistentStore.remove(STORAGE_KEYS.quantum);
  return legacy;
}

export async function writeQuantum(stored: QuantumStored): Promise<void> {
  await writeVaultQuantum(stored);
}

/**
 * Park a signed intent without disturbing the key material. Must complete
 * BEFORE the request reaches the relayer: everything after that point assumes
 * the only signature ever made for this leaf is recoverable from here.
 *
 * Throws rather than no-op'ing when there is no record to attach to, and when a
 * pending intent is already recorded. The latter is the last line of defense
 * against double-signing a leaf: overwriting would orphan a signature nothing
 * on disk can replay, and the replacement would be a second signature over the
 * same one-time key. Callers must retry the outstanding intent, never re-sign.
 */
export async function writePending(pending: QuantumPending): Promise<void> {
  const current = await readQuantum();
  if (current === null) {
    throw new Error("no quantum wallet record to attach a pending intent to");
  }
  if (current.pending) {
    throw new Error("a signed intent is already pending — retry it, do not re-sign");
  }
  await writeQuantum({ ...current, pending });
}

/**
 * Drop the pending slot once the chain has moved past its leaf.
 *
 * `ifLeaf` scopes the clear to one specific (epoch, leafIndex). Without it, a
 * window settling an old intent could wipe a NEWER one another window has since
 * armed: the leaf being retired is not necessarily the leaf the record holds,
 * and erasing that record would orphan a signature nothing on disk can replay.
 * Leaves are unique per epoch, so the pair identifies the intent unambiguously.
 */
export async function clearPending(ifLeaf?: { epoch: number; leafIndex: number }): Promise<void> {
  const current = await readQuantum();
  if (current === null || !current.pending) return;
  if (
    ifLeaf !== undefined
    && (current.pending.epoch !== ifLeaf.epoch || current.pending.leafIndex !== ifLeaf.leafIndex)
  ) {
    return;
  }
  await writeQuantum({ ...current, pending: null });
}

export async function clearQuantum(): Promise<void> {
  await writeVaultQuantum(null);
  // Also drop any plaintext record a pre-encryption build left on disk, so
  // "forget this device" can never leave the secret sitting in the clear.
  await persistentStore.remove(STORAGE_KEYS.quantum);
}

/**
 * Minimal structural type for the Web Locks API. Declared here rather than
 * relying on lib.dom so this compiles identically in the extension (whose
 * tsconfig pins `types`) and in the web build.
 */
interface SignLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * Name of the origin-wide signing mutex. All 0xQuantum signing goes through the
 * one wallet record this extension holds, so a single name is correct — and
 * using one name is what serializes two windows against each other.
 */
const SIGN_LOCK = "0xq.sign";

/**
 * Serialize "read the world, decide, sign, persist" across extension contexts.
 *
 * WHY THIS EXISTS: a WOTS leaf is burned the instant a signature over it exists,
 * so the one-time property is enforced purely by ordering — a signature for leaf
 * N may exist only if a record of it is on disk before the signature leaves.
 * That argument is a compare-and-swap on (leafIndex -> signature), and
 * chrome.storage has no compare-and-swap: two documents that both read "no
 * pending intent" would both sign leaf N. Two signatures over two different
 * digests at one leaf publish chain values at two depths per chain, which is
 * enough to forge with — it does not merely double-spend, it destroys the key.
 *
 * Web Locks are origin-scoped and every context of this extension (popup, tab,
 * side panel, service worker) shares one origin — as do all tabs of the web
 * build — so this is a genuine cross-document mutex. Where the API is missing
 * the section still runs and the persisted re-check inside it remains as a
 * backstop, but the mutual exclusion is then gone; nothing may rely on this
 * alone.
 */
export async function withSignLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as unknown as { navigator?: { locks?: SignLockManager } })
    .navigator?.locks;
  if (locks === undefined) return fn();
  return locks.request(SIGN_LOCK, fn);
}
