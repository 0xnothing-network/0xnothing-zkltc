import { type Catalog, EN, type MessageKey, type TParams } from "./catalog";

/**
 * Translation, hand-rolled and dependency-free.
 *
 * English is bundled statically; every other catalog is its own chunk and only
 * the one on screen is read, so a page no longer parses eight catalogs it does
 * not show before its first frame. The service worker never imports this module
 * (MV3 rejects a dynamic `import()` in its graph; scripts/build-all.mjs checks).
 *
 * The authoritative choice lives in `WalletSettings`, which is async storage.
 * `BOOT_KEY` mirrors it into `localStorage` so the first frame after a reload is
 * already in the user's language instead of flashing English and switching:
 * main.tsx renders only after `prepareLocale()` has read that one catalog.
 * `t()` and `setLocale()` stay synchronous; `loadLocale()` is the only wait.
 */
export type LocaleCode = "en" | "vi" | "zh" | "es" | "fr" | "de" | "ja" | "ko" | "ru";

export interface LocaleInfo {
  code: LocaleCode;
  /** The language's own name — a picker in a language you cannot read is useless. */
  label: string;
  /** `<html lang>` value; also what `Intl` would be given if it were used. */
  tag: string;
}

export const DEFAULT_LOCALE: LocaleCode = "en";

export const LOCALES: readonly LocaleInfo[] = [
  { code: "en", label: "English", tag: "en" },
  { code: "vi", label: "Tiếng Việt", tag: "vi" },
  { code: "zh", label: "中文", tag: "zh-Hans" },
  { code: "es", label: "Español", tag: "es" },
  { code: "fr", label: "Français", tag: "fr" },
  { code: "de", label: "Deutsch", tag: "de" },
  { code: "ja", label: "日本語", tag: "ja" },
  { code: "ko", label: "한국어", tag: "ko" },
  { code: "ru", label: "Русский", tag: "ru" },
];

const LOADERS: Record<Exclude<LocaleCode, "en">, () => Promise<Catalog>> = {
  vi: async () => (await import("./locales/vi")).vi,
  zh: async () => (await import("./locales/zh")).zh,
  es: async () => (await import("./locales/es")).es,
  fr: async () => (await import("./locales/fr")).fr,
  de: async () => (await import("./locales/de")).de,
  ja: async () => (await import("./locales/ja")).ja,
  ko: async () => (await import("./locales/ko")).ko,
  ru: async () => (await import("./locales/ru")).ru,
};

/** A chunk read from local disk answers at once; past this the page goes on in English. */
const LOAD_TIMEOUT_MS = 4_000;

const loaded: Partial<Record<LocaleCode, Catalog>> = { en: EN };
const loading = new Map<LocaleCode, Promise<boolean>>();

const BOOT_KEY = "0xn.wallet.locale";

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === "string" && LOCALES.some((entry) => entry.code === value);
}

function bootLocale(): LocaleCode {
  try {
    const cached = globalThis.localStorage?.getItem(BOOT_KEY);
    if (isLocaleCode(cached)) return cached;
  } catch {
    // No localStorage (service worker, test runner): English it is.
  }
  return DEFAULT_LOCALE;
}

// English until a catalog is loaded: prepareLocale() runs before the first render.
let current: LocaleCode = DEFAULT_LOCALE;
let active: Catalog = EN;

export function localeInfo(code: LocaleCode): LocaleInfo {
  return LOCALES.find((entry) => entry.code === code) ?? LOCALES[0]!;
}

/**
 * Reads one locale's catalog. Resolves true once it is in memory and false when
 * its chunk could not be read in time; never rejects. A failed read is not
 * remembered, so the next call tries again.
 */
export function loadLocale(code: LocaleCode): Promise<boolean> {
  if (loaded[code]) return Promise.resolve(true);
  const running = loading.get(code);
  if (running) return running;
  const load = LOADERS[code as Exclude<LocaleCode, "en">];
  const attempt = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
    load().then(
      (catalog) => {
        loaded[code] = catalog;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
  loading.set(code, attempt);
  void attempt.then(() => loading.delete(code));
  return attempt;
}

/**
 * Before the first render: loads and applies the locale the boot mirror names.
 * Settles either way; a catalog that cannot be read leaves the page in English.
 */
export async function prepareLocale(): Promise<void> {
  const code = bootLocale();
  if (await loadLocale(code)) setLocale(code);
}

/**
 * Applies a locale process-wide. Callers re-render afterwards — the wallet has
 * no memoised components, so a state change at the provider reaches every label.
 * A locale whose catalog is not loaded yet (see loadLocale) shows English and
 * leaves the mirror alone, so the stored choice is tried again next time.
 */
export function setLocale(code: LocaleCode): void {
  const catalog = loaded[code];
  const shown = catalog ? code : DEFAULT_LOCALE;
  if (shown === current) return;
  current = shown;
  active = catalog ?? EN;
  if (catalog) {
    try {
      globalThis.localStorage?.setItem(BOOT_KEY, code);
    } catch {
      // Mirroring is an optimisation; the setting itself is already stored.
    }
  }
  applyDocumentLang();
}

/** Keeps `<html lang>` truthful for screen readers and hyphenation. */
export function applyDocumentLang(): void {
  const root = globalThis.document?.documentElement;
  if (root) root.lang = localeInfo(current).tag;
}

/**
 * Looks a message up in the active locale, falling back to English, and
 * interpolates `{name}` placeholders. An unknown key returns the key itself,
 * which is loud enough to spot and harmless enough to ship.
 */
export function t(key: MessageKey, params?: TParams): string {
  const template = active[key] ?? EN[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export type { MessageKey, TParams } from "./catalog";
