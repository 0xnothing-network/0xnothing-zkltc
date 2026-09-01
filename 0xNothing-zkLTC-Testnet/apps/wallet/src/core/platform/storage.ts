import {
  chromeGet,
  chromeKeys,
  chromeRemove,
  chromeSet,
  chromeSetMany,
  onChromeChange,
} from "./chromeStore";
import { isAndroid, isExtension } from "./env";

/**
 * One async key/value interface over three very different backends.
 *
 * `persistent` survives restarts and holds the encrypted vault plus public
 * metadata. `session` is memory-only and holds the unlocked key: on the
 * extension that is chrome.storage.session (cleared by the browser on restart),
 * on Android/web it is a plain in-process Map, which is strictly stronger.
 *
 * Values must be JSON-safe — amounts are stored as decimal strings, never as
 * BigInt.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  setMany(entries: readonly (readonly [string, unknown])[]): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /** Fires when another document in the same profile changes `key`. */
  subscribe(key: string, handler: (value: unknown) => void): () => void;
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  const watchers = new Map<string, Set<(value: unknown) => void>>();
  return {
    async get<T>(key: string) {
      return (map.has(key) ? (map.get(key) as T) : null);
    },
    async set(key, value) {
      map.set(key, value);
      watchers.get(key)?.forEach((handler) => handler(value));
    },
    async setMany(entries) {
      for (const [key, value] of entries) map.set(key, value);
      for (const [key, value] of entries) {
        watchers.get(key)?.forEach((handler) => handler(value));
      }
    },
    async remove(key) {
      map.delete(key);
      watchers.get(key)?.forEach((handler) => handler(undefined));
    },
    async keys() {
      return [...map.keys()];
    },
    subscribe(key, handler) {
      const set = watchers.get(key) ?? new Set();
      set.add(handler);
      watchers.set(key, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) watchers.delete(key);
      };
    },
  };
}

function chromeStore(area: "local" | "session"): KeyValueStore {
  return {
    get: (key) => chromeGet(area, key),
    set: (key, value) => chromeSet(area, key, value),
    setMany: (entries) => chromeSetMany(area, entries),
    remove: (key) => chromeRemove(area, key),
    keys: () => chromeKeys(area),
    subscribe: (key, handler) => onChromeChange(area, key, handler),
  };
}

function webStore(storage: Storage): KeyValueStore {
  return {
    async get<T>(key: string) {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      storage.setItem(key, JSON.stringify(value));
    },
    async setMany(entries) {
      for (const [key, value] of entries) storage.setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      storage.removeItem(key);
    },
    async keys() {
      return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
        (key): key is string => key !== null,
      );
    },
    subscribe(key, handler) {
      const listener = (event: StorageEvent): void => {
        if (event.key !== key) return;
        if (event.newValue === null) {
          handler(undefined);
          return;
        }
        try {
          handler(JSON.parse(event.newValue) as unknown);
        } catch {
          // Corrupt data from another tab is treated as absent, matching get().
          handler(undefined);
        }
      };
      window.addEventListener("storage", listener);
      return () => window.removeEventListener("storage", listener);
    },
  };
}

/**
 * Capacitor Preferences, reached through a dynamic import so the extension
 * bundle never pulls in the native runtime. Read-modify-write callers use the
 * platform lock helper; this store stays a small transport layer.
 */
function preferencesStore(): KeyValueStore {
  // Keep the module promise, not the Capacitor plugin proxy itself. Plugin
  // proxies expose every property as a native method, including `then`;
  // resolving a Promise with that proxy therefore makes JavaScript treat it as
  // a thenable and call the non-existent native method `Preferences.then()`.
  const pluginModule = import("@capacitor/preferences");
  const watchers = new Map<string, Set<(value: unknown) => void>>();
  return {
    async get<T>(key: string) {
      const { Preferences } = await pluginModule;
      const { value } = await Preferences.get({ key });
      if (value === null || value === undefined) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      const { Preferences } = await pluginModule;
      await Preferences.set({ key, value: JSON.stringify(value) });
      watchers.get(key)?.forEach((handler) => handler(value));
    },
    async setMany(entries) {
      const { Preferences } = await pluginModule;
      await Promise.all(
        entries.map(([key, value]) => Preferences.set({ key, value: JSON.stringify(value) })),
      );
      for (const [key, value] of entries) {
        watchers.get(key)?.forEach((handler) => handler(value));
      }
    },
    async remove(key) {
      const { Preferences } = await pluginModule;
      await Preferences.remove({ key });
      watchers.get(key)?.forEach((handler) => handler(undefined));
    },
    async keys() {
      const { Preferences } = await pluginModule;
      const { keys } = await Preferences.keys();
      return keys;
    },
    subscribe(key, handler) {
      const set = watchers.get(key) ?? new Set();
      set.add(handler);
      watchers.set(key, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) watchers.delete(key);
      };
    },
  };
}

/**
 * The web backend is development-only, and `window` is missing outside a
 * document — under the test runner, for instance — so it falls back to memory
 * rather than throwing while this module is still being evaluated.
 */
export const persistentStore: KeyValueStore = isExtension
  ? chromeStore("local")
  : isAndroid
    ? preferencesStore()
    : typeof window === "undefined"
      ? memoryStore()
      : webStore(window.localStorage);

export const sessionStore: KeyValueStore = isExtension ? chromeStore("session") : memoryStore();
