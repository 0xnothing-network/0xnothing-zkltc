import { persistentStore } from "../../core/platform/storage";
import { STORAGE_KEYS } from "../../core/platform/storageKeys";
import { type HomeTab, parseHomeTab, type SwapPair } from "./uiMemory";

/**
 * Storage for the remembered Home tab and swap pair. A preference is never worth a failed screen:
 * a read fault gives the default and a write fault is dropped. The erase
 * removes both keys (vault.ts wipeWallet).
 */
export async function loadHomeTab(): Promise<HomeTab | null> {
  try {
    return parseHomeTab(await persistentStore.get(STORAGE_KEYS.homeTab));
  } catch {
    return null;
  }
}

export function saveHomeTab(tab: HomeTab): void {
  void persistentStore.set(STORAGE_KEYS.homeTab, tab).catch(() => undefined);
}

/** The raw stored value; the caller checks it against its network and token list. */
export async function loadSwapPair(): Promise<unknown> {
  try {
    return await persistentStore.get(STORAGE_KEYS.swapPair);
  } catch {
    return null;
  }
}

export function saveSwapPair(pair: SwapPair): void {
  void persistentStore.set(STORAGE_KEYS.swapPair, pair).catch(() => undefined);
}

/** The raw stored version; whatsNew.ts checks it. */
export async function loadSeenVersion(): Promise<unknown> {
  try {
    return await persistentStore.get(STORAGE_KEYS.seenVersion);
  } catch {
    // Unreadable reads as "seen", never as a card that cannot be dismissed.
    return __WALLET_VERSION__;
  }
}

export async function markVersionSeen(version: string): Promise<void> {
  await persistentStore.set(STORAGE_KEYS.seenVersion, version).catch(() => undefined);
}
