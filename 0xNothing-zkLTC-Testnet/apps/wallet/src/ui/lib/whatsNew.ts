import type { MessageKey } from "../../core/i18n/catalog";

/**
 * "What is new": once after an update, a few lines on Home about the
 * version now running. The last version seen is stored; a fresh install
 * writes its own version while it is still on onboarding, so only a wallet
 * that existed before the update ever sees the card. Pure, type imports only.
 */
export interface NewsLine {
  key: MessageKey;
  /** A feature the Android app does not have is not announced there. */
  extensionOnly?: boolean;
}

export const MAX_NEWS_LINES = 5;

export const WALLET_NEWS: Readonly<Record<string, readonly NewsLine[]>> = {
  "1.0.10": [
    { key: "news.panel", extensionOnly: true },
    { key: "news.names" },
    { key: "news.approvals", extensionOnly: true },
    { key: "news.proposals", extensionOnly: true },
    { key: "news.system" },
  ],
};

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/u;

export function parseSeenVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value) ? value : null;
}

/** Negative, zero or positive as a is older than, equal to or newer than b. Invalid sorts oldest. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (left === null || right === null) return left === null ? (right === null ? 0 : -1) : 1;
  for (let part = 1; part <= 3; part += 1) {
    const diff = Number(left[part]) - Number(right[part]);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function newsLines(version: string, extension: boolean): readonly NewsLine[] {
  return (WALLET_NEWS[version] ?? [])
    .filter((line) => extension || line.extensionOnly !== true)
    .slice(0, MAX_NEWS_LINES);
}

/**
 * Due when nothing was stored (a wallet from before this key, so an update) or
 * an older version was, and this version has something to say. A downgrade
 * says nothing.
 */
export function whatsNewDue(stored: unknown, current: string, lineCount: number): boolean {
  if (lineCount === 0) return false;
  const seen = parseSeenVersion(stored);
  return seen === null || compareVersions(seen, current) < 0;
}
