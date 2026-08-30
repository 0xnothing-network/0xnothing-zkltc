import { type Catalog, EN, type MessageKey, type TParams } from "./catalog";
import { de } from "./locales/de";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { ru } from "./locales/ru";
import { vi } from "./locales/vi";
import { zh } from "./locales/zh";

/**
 * Translation, hand-rolled and dependency-free.
 *
 * All nine catalogs are bundled statically. A wallet loads from local disk in
 * both shells, so there is no network to save by splitting them, and a dynamic
 * `import()` is forbidden outside the popup anyway (MV3 rejects it in the
 * service-worker graph). The whole set costs a few kilobytes of parse on a
 * surface that must paint on its first frame.
 *
 * The authoritative choice lives in `WalletSettings`, which is async storage.
 * `BOOT_KEY` mirrors it into `localStorage` so the first frame after a reload is
 * already in the user's language instead of flashing English and switching.
 * Everything here is synchronous by design.
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

const CATALOGS: Record<LocaleCode, Catalog> = { en: EN, vi, zh, es, fr, de, ja, ko, ru };

const BOOT_KEY = "0xn.wallet.locale";

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === "string" && value in CATALOGS;
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

let current: LocaleCode = bootLocale();
let active: Catalog = CATALOGS[current];

export function getLocale(): LocaleCode {
  return current;
}

export function localeInfo(code: LocaleCode): LocaleInfo {
  return LOCALES.find((entry) => entry.code === code) ?? LOCALES[0]!;
}

/**
 * Applies a locale process-wide. Callers re-render afterwards — the wallet has
 * no memoised components, so a state change at the provider reaches every label.
 */
export function setLocale(code: LocaleCode): void {
  if (code === current) return;
  current = code;
  active = CATALOGS[code];
  try {
    globalThis.localStorage?.setItem(BOOT_KEY, code);
  } catch {
    // Mirroring is an optimisation; the setting itself is already stored.
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
