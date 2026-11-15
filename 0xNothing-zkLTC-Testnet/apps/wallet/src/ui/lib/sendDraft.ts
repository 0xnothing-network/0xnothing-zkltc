import { persistentStore } from "../../core/platform/storage";
import { STORAGE_KEYS } from "../../core/platform/storageKeys";

/**
 * The half-filled Send form, kept so the MV3 popup closing (it closes on any
 * click outside it, often while the user copies the address elsewhere) does
 * not throw it away. One slot for the whole wallet: the token, the typed
 * amount and the typed recipient, all public. Nothing from the review sheet
 * is ever stored, and the draft is only offered back to the same account on
 * the same network for ten minutes. A successful send, a lock (App clears it
 * whenever it sees the wallet locked, whichever surface locked it) and an
 * erase remove it.
 */
export const SEND_DRAFT_MAX_AGE_MS = 10 * 60_000;
/** A clock a little ahead on the writing side must not make a draft immortal. */
const FUTURE_SKEW_MS = 60_000;

export interface SendDraft {
  account: string;
  networkId: string;
  tokenId: string;
  to: string;
  amount: string;
  at: number;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** The stored draft if it belongs to this account and network and is fresh, else null. */
export function parseSendDraft(
  value: unknown,
  account: string,
  networkId: string,
  now: number,
): SendDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const owner = text(row.account, 42);
  const network = text(row.networkId, 200);
  const tokenId = text(row.tokenId, 200);
  const to = text(row.to, 128);
  const amount = text(row.amount, 80);
  const at = row.at;
  if (owner === null || network === null || tokenId === null || to === null || amount === null) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (owner.toLowerCase() !== account.toLowerCase() || network !== networkId) return null;
  if (now - at > SEND_DRAFT_MAX_AGE_MS || at - now > FUTURE_SKEW_MS) return null;
  if (tokenId.length === 0 || (to.length === 0 && amount.length === 0)) return null;
  return { account: owner, networkId: network, tokenId, to, amount, at };
}

export async function loadSendDraft(account: string, networkId: string, now = Date.now()): Promise<SendDraft | null> {
  return parseSendDraft(await persistentStore.get(STORAGE_KEYS.sendDraft), account, networkId, now);
}

/** Writes the form as typed; an empty form removes the draft instead. */
export async function saveSendDraft(draft: Omit<SendDraft, "at">, now = Date.now()): Promise<void> {
  if (draft.to.length === 0 && draft.amount.length === 0) {
    await persistentStore.remove(STORAGE_KEYS.sendDraft);
    return;
  }
  await persistentStore.set(STORAGE_KEYS.sendDraft, {
    account: draft.account.toLowerCase(),
    networkId: draft.networkId,
    tokenId: draft.tokenId.slice(0, 200),
    to: draft.to.slice(0, 128),
    amount: draft.amount.slice(0, 80),
    at: now,
  });
}

export async function clearSendDraft(): Promise<void> {
  await persistentStore.remove(STORAGE_KEYS.sendDraft);
}
