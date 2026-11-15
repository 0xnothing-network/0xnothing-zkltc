import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

/** O1: only the active locale's catalog is read, before the first render, with English as the floor. */
type I18n = typeof import("../../src/core/i18n/index.ts");
const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const EN = { "onb.create": "Create a new wallet", "onb.import": "Restore from a seed phrase" };
const CATALOGS: Record<string, Record<string, string>> = {
  vi: { "onb.create": "Tạo ví mới" },
  de: { "onb.create": "Neue Wallet erstellen" },
  ja: { "onb.create": "新しいウォレットを作成" },
};

function load(stored: string | null, options: { broken?: Set<string>; timers?: "instant" } = {}) {
  const reads: string[] = [];
  const mirror = new Map<string, string>(stored === null ? [] : [["0xn.wallet.locale", stored]]);
  const imports: Record<string, unknown> = { "./catalog": { EN } };
  for (const code of ["vi", "zh", "es", "fr", "de", "ja", "ko", "ru"]) {
    Object.defineProperty(imports, `./locales/${code}`, {
      enumerable: true,
      get() {
        reads.push(code);
        if (options.broken?.has(code)) throw new Error(`chunk ${code} failed`);
        return { [code]: CATALOGS[code] ?? {} };
      },
    });
  }
  const root = { lang: "en" };
  const i18n = evaluateModule<I18n>(new URL("../../src/core/i18n/index.ts", import.meta.url), imports, {
    localStorage: { getItem: (key: string) => mirror.get(key) ?? null, setItem: (key: string, value: string) => mirror.set(key, value) },
    document: { documentElement: root },
    setTimeout: options.timers === "instant" ? (fn: () => void) => { fn(); return 0; } : setTimeout,
    clearTimeout,
  });
  return { i18n, reads, mirror, root };
}

test("the first render reads only the stored locale and paints in it", async () => {
  const { i18n, reads, mirror, root } = load("vi");
  // Before prepareLocale nothing but English is in memory.
  assert.equal(i18n.t("onb.create" as never), "Create a new wallet");
  assert.deepEqual(reads, []);
  await i18n.prepareLocale();
  assert.deepEqual(reads, ["vi"]);
  assert.equal(i18n.t("onb.create" as never), "Tạo ví mới");
  // A key the locale lacks still falls back to English.
  assert.equal(i18n.t("onb.import" as never), "Restore from a seed phrase");
  assert.equal(root.lang, "vi");
  assert.equal(mirror.get("0xn.wallet.locale"), "vi");
  // English and an unknown mirror read nothing at all.
  for (const stored of [null, "en", "toString", "xx"]) {
    const fresh = load(stored);
    await fresh.i18n.prepareLocale();
    assert.deepEqual(fresh.reads, [], String(stored));
    assert.equal(fresh.i18n.t("onb.create" as never), "Create a new wallet");
  }
  assert.equal(i18n.isLocaleCode("toString"), false);
  assert.equal(i18n.isLocaleCode("ru"), true);
});

test("a chunk that fails leaves English on screen, keeps the stored choice and is tried again", async () => {
  const broken = new Set(["de"]);
  const { i18n, reads, mirror, root } = load("de", { broken });
  await i18n.prepareLocale();
  assert.equal(i18n.t("onb.create" as never), "Create a new wallet");
  assert.equal(root.lang, "en");
  assert.equal(mirror.get("0xn.wallet.locale"), "de", "the mirror still names the user's choice");
  // setLocale without the catalog shows English and does not rewrite the mirror.
  i18n.setLocale("de");
  assert.equal(i18n.t("onb.create" as never), "Create a new wallet");
  assert.equal(mirror.get("0xn.wallet.locale"), "de");
  broken.clear();
  assert.equal(await i18n.loadLocale("de"), true);
  assert.deepEqual(reads, ["de", "de"]);
  i18n.setLocale("de");
  assert.equal(i18n.t("onb.create" as never), "Neue Wallet erstellen");
  assert.equal(root.lang, "de");
});

test("a language picked later shows once its catalog is read; parallel reads share one load", async () => {
  const { i18n, reads, mirror, root } = load("vi");
  await i18n.prepareLocale();
  i18n.setLocale("ja");
  // Not loaded yet: English, lang en, mirror untouched.
  assert.equal(i18n.t("onb.create" as never), "Create a new wallet");
  assert.equal(root.lang, "en");
  assert.equal(mirror.get("0xn.wallet.locale"), "vi");
  const [first, second] = await Promise.all([i18n.loadLocale("ja"), i18n.loadLocale("ja")]);
  assert.deepEqual([first, second], [true, true]);
  assert.deepEqual(reads, ["vi", "ja"]);
  i18n.setLocale("ja");
  assert.equal(i18n.t("onb.create" as never), "新しいウォレットを作成");
  assert.equal(mirror.get("0xn.wallet.locale"), "ja");
  assert.equal(await i18n.loadLocale("ja"), true);
  assert.deepEqual(reads, ["vi", "ja"], "a loaded catalog is not read again");
  i18n.setLocale("en");
  assert.equal(i18n.t("onb.create" as never), "Create a new wallet");
  assert.equal(mirror.get("0xn.wallet.locale"), "en");
});

test("a chunk that does not answer in time gives English; the catalog is kept when it arrives", async () => {
  const { i18n } = load("vi", { timers: "instant" });
  await i18n.prepareLocale();
  assert.equal(i18n.t("onb.create" as never), "Create a new wallet");
  // The late answer is not thrown away: the next pick applies at once.
  assert.equal(await i18n.loadLocale("vi"), true);
  i18n.setLocale("vi");
  assert.equal(i18n.t("onb.create" as never), "Tạo ví mới");
});

test("no catalog is imported statically, the page renders on both outcomes and the provider waits for the catalog", () => {
  const index = source("src/core/i18n/index.ts");
  assert.doesNotMatch(index, /^import [^\n]*from "\.\/locales\//mu);
  assert.equal((index.match(/await import\("\.\/locales\/(vi|zh|es|fr|de|ja|ko|ru)"\)/gu) ?? []).length, 8);
  const main = source("src/ui/main.tsx");
  assert.match(main, /void prepareLocale\(\)\.then\(render, render\);/u);
  assert.doesNotMatch(main, /^createRoot\(/mu, "nothing renders before the catalog settles");
  const context = source("src/ui/state/WalletContext.tsx");
  assert.match(context, /await Promise\.all\(\[listTokens\(selected\), loadLocale\(saved\.locale\)\]\);[\s\S]*setLocale\(saved\.locale\);/u);
  assert.match(context, /await Promise\.all\(\[listTokens\(selected\), loadLocale\(next\.locale\)\]\);[\s\S]*setLocale\(next\.locale\);/u);
});
