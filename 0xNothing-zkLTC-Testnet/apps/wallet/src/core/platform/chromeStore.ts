/**
 * Direct chrome.storage access, deliberately free of dynamic imports so it can
 * be used from the MV3 service worker (where `import()` is disallowed) and from
 * the UI alike.
 *
 * `local` holds the encrypted vault and all public metadata.
 * `session` holds the unlocked key material: chrome clears it when the browser
 * restarts and it is never written to disk.
 */

type Area = "local" | "session";

function area(name: Area): chrome.storage.StorageArea {
  return name === "session" ? chrome.storage.session : chrome.storage.local;
}

export async function chromeGet<T>(name: Area, key: string): Promise<T | null> {
  const bag = await area(name).get(key);
  const value = bag?.[key];
  return value === undefined ? null : (value as T);
}

export async function chromeSet(name: Area, key: string, value: unknown): Promise<void> {
  await area(name).set({ [key]: value });
}

export async function chromeSetMany(
  name: Area,
  entries: readonly (readonly [string, unknown])[],
): Promise<void> {
  await area(name).set(Object.fromEntries(entries));
}

export async function chromeRemove(name: Area, key: string): Promise<void> {
  await area(name).remove(key);
}

export async function chromeKeys(name: Area): Promise<string[]> {
  const bag = await area(name).get(null);
  return Object.keys(bag ?? {});
}

/**
 * Cross-context notification. The approval window and the popup are separate
 * documents from the service worker, so a storage listener is the only channel
 * that works for both while the other side may not be alive yet.
 */
export function onChromeChange(
  name: Area,
  key: string,
  handler: (value: unknown) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    changedArea: string,
  ): void => {
    if (changedArea !== name) return;
    if (!(key in changes)) return;
    handler(changes[key]?.newValue);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
