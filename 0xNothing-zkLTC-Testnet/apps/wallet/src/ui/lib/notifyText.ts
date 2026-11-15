import { t } from "../../core/i18n";
import { EN, type MessageKey } from "../../core/i18n/catalog";
import { persistentStore } from "../../core/platform/storage";
import { STORAGE_KEYS } from "../../core/platform/storageKeys";

/**
 * The service worker shows the opt-in notifications but carries no catalog: nine
 * of them would weigh on every worker start, and MV3 forbids loading one later.
 * So the wallet page hands it the few templates it needs, in the language on
 * screen: every History label (`tx.*`) and the notification titles (`notif.*`).
 * Templates only; the worker fills in each row's own parameters.
 */
export function notifyTextKeys(): MessageKey[] {
  return (Object.keys(EN) as MessageKey[]).filter((key) => key.startsWith("tx.") || key.startsWith("notif."));
}

export function notifyText(): Record<string, string> {
  return Object.fromEntries(notifyTextKeys().map((key) => [key, t(key)]));
}

export async function writeNotifyText(): Promise<void> {
  await persistentStore.set(STORAGE_KEYS.notifyText, notifyText());
}
