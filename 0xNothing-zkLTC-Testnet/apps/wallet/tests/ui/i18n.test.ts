import assert from "node:assert/strict";
import { test } from "node:test";
import { EN, type MessageKey } from "../../src/core/i18n/catalog.ts";
import { de } from "../../src/core/i18n/locales/de.ts";
import { es } from "../../src/core/i18n/locales/es.ts";
import { fr } from "../../src/core/i18n/locales/fr.ts";
import { ja } from "../../src/core/i18n/locales/ja.ts";
import { ko } from "../../src/core/i18n/locales/ko.ts";
import { ru } from "../../src/core/i18n/locales/ru.ts";
import { vi } from "../../src/core/i18n/locales/vi.ts";
import { zh } from "../../src/core/i18n/locales/zh.ts";

/**
 * English is the catalog; the other eight are overlays that fall back to it key
 * by key. That fallback is a feature — a term like `NFT` or `{amount} {symbol}`
 * carries no language and is better left in one place than restated nine times —
 * but it is also the one way a missing translation can ship silently. These tests
 * make every gap deliberate: a key may only be absent if it is listed below.
 *
 * The lists are the specification, not a snapshot. Adding a translation means
 * deleting its key from a list; leaving English in the UI on purpose means adding
 * it, with the reason visible in review.
 */
const LOCALES = { vi, zh, es, fr, de, ja, ko, ru };

type Code = keyof typeof LOCALES;

/** Absent from every locale: symbols, brand, and pure interpolation. */
const NEUTRAL: readonly MessageKey[] = [
  "common.amountWithSymbol", // "{amount} {symbol}"
  "nav.dapp",
  "dapp.title",
  "kind.dapp",
  "kind.nft",
  "home.delta24h", // "24h"
  "tx.swap", // "{paid} → {received}"
  "apr.selTransfer",
  "apr.selApprove",
  "apr.selTransferFrom",
  "apr.selSafeTransferFrom",
];

/**
 * Absent from one locale but not the others, because the translation would read
 * exactly like the English — including `wipe.word`, which the user has to type
 * by hand, so CJK keeps the Latin "ERASE" rather than a word needing an IME.
 */
const SAME_AS_ENGLISH: Record<Code, readonly MessageKey[]> = {
  vi: [
    "common.explorer",
    "common.token",
    "nav.swap",
    "home.stake",
    "home.mint",
    "swap.title",
    "swap.submit",
    "mint.title",
    "kind.mintNusd",
    "kind.swap",
    "apr.domain",
    "apr.footer",
  ],
  zh: ["wipe.word", "network.protocolOnly", "apr.networkChanged", "set.customNetworks", "set.networkChoose", "set.addNetwork",
    "set.networkName", "set.rpcUrl", "set.chainId", "set.nativeName", "set.nativeSymbol", "set.explorerUrl",
    "set.networkInvalid", "set.networkDuplicate", "set.networkPermission", "set.customNetworkNote"],
  es: ["common.no", "common.token", "nav.swap", "home.stake", "swap.title", "swap.submit",
    "kind.swap", "set.lockChoice", "tok.panel", "network.protocolOnly", "apr.networkChanged", "set.customNetworks", "set.networkChoose",
    "set.addNetwork", "set.networkName", "set.rpcUrl", "set.chainId", "set.nativeName", "set.nativeSymbol",
    "set.explorerUrl", "set.networkInvalid", "set.networkDuplicate", "set.networkPermission", "set.customNetworkNote"],
  fr: ["common.max", "common.token", "nav.swap", "home.stake", "swap.title", "swap.submit",
    "swap.route", "swap.confirmations", "lend.utilization", "kind.swap", "set.lockChoice",
    "set.build", "tok.panel", "apr.txTitle", "apr.signTitle", "network.protocolOnly", "apr.networkChanged", "set.customNetworks",
    "set.networkChoose", "set.addNetwork", "set.networkName", "set.rpcUrl", "set.chainId", "set.nativeName",
    "set.nativeSymbol", "set.explorerUrl", "set.networkInvalid", "set.networkDuplicate", "set.networkPermission",
    "set.customNetworkNote"],
  de: ["common.explorer", "common.max", "common.token", "account.hdN", "nav.swap", "home.stake",
    "swap.title", "swap.submit", "swap.route", "kind.swap", "onb.title", "set.build", "tok.panel",
    "tok.symbol", "tok.name", "apr.domain", "apr.footer", "network.protocolOnly", "apr.networkChanged", "set.customNetworks",
    "set.networkChoose", "set.addNetwork", "set.networkName", "set.rpcUrl", "set.chainId", "set.nativeName",
    "set.nativeSymbol", "set.explorerUrl", "set.networkInvalid", "set.networkDuplicate", "set.networkPermission",
    "set.customNetworkNote"],
  ja: ["wipe.word", "network.protocolOnly", "apr.networkChanged", "set.customNetworks", "set.networkChoose", "set.addNetwork",
    "set.networkName", "set.rpcUrl", "set.chainId", "set.nativeName", "set.nativeSymbol", "set.explorerUrl",
    "set.networkInvalid", "set.networkDuplicate", "set.networkPermission", "set.customNetworkNote"],
  ko: ["wipe.word", "network.protocolOnly", "apr.networkChanged", "set.customNetworks", "set.networkChoose", "set.addNetwork",
    "set.networkName", "set.rpcUrl", "set.chainId", "set.nativeName", "set.nativeSymbol", "set.explorerUrl",
    "set.networkInvalid", "set.networkDuplicate", "set.networkPermission", "set.customNetworkNote"],
  ru: ["nav.swap", "swap.title", "swap.submit", "network.protocolOnly", "apr.networkChanged", "set.customNetworks", "set.networkChoose",
    "set.addNetwork", "set.networkName", "set.rpcUrl", "set.chainId", "set.nativeName", "set.nativeSymbol",
    "set.explorerUrl", "set.networkInvalid", "set.networkDuplicate", "set.networkPermission", "set.customNetworkNote"],
};

/** New market discovery/review copy falls back until each locale is translated. */
const SWAP_MARKET_ENGLISH: readonly MessageKey[] = [
  "swap.searchToken",
  "swap.searchPlaceholder",
  "swap.catalogLoading",
  "swap.catalogUnavailable",
  "swap.noTokenMatch",
  "swap.reviewTitle",
  "swap.confirmSubmit",
  "swap.reviewNotice",
  "swap.approvalHint",
];

/** Points staking ships in English and Vietnamese first; other locales fall back deliberately. */
const POINTS_ENGLISH: readonly MessageKey[] = [
  "earn.title",
  "earn.stake",
  "earn.stakeLabel",
  "earn.walletBalance",
  "earn.lockPeriod",
  "earn.lockOption",
  "earn.locked",
  "earn.availablePoints",
  "earn.earnedPoints",
  "earn.spentPoints",
  "earn.overWallet",
  "earn.stakingPaused",
  "earn.stakeNote",
  "earn.approvalHint",
  "earn.submitStake",
  "earn.toastStake",
  "earn.positions",
  "earn.noPositions",
  "earn.positionsTruncated",
  "earn.position",
  "earn.positionAmount",
  "earn.positionPoints",
  "earn.unlocks",
  "earn.withdrawn",
  "earn.withdraw",
  "earn.toastWithdraw",
  "earn.lending",
  "earn.lendingNote",
  "earn.redeem",
  "earn.redeemLabel",
  "earn.redeemRate",
  "earn.redeemReceive",
  "earn.overPoints",
  "earn.redeemTooSmall",
  "earn.redeemReserve",
  "earn.redeemSubmit",
  "earn.toastRedeem",
  "earn.reviewStake",
  "earn.reviewWithdraw",
  "earn.reviewRedeem",
  "tx.pointsStake",
  "tx.pointsWithdraw",
  "tx.pointsRedeem",
  "kind.pointsStake",
  "kind.pointsWithdraw",
  "kind.pointsRedeem",
];

const codes = Object.keys(LOCALES) as Code[];

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[1] ?? "").sort();
}

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => params[name] ?? whole);
}

test("no locale carries a key English has dropped", () => {
  for (const code of codes) {
    for (const key of Object.keys(LOCALES[code])) {
      assert.ok(key in EN, `${code}: "${key}" is not a key of the English catalog`);
    }
  }
});

test("every gap is a declared one", () => {
  const keys = Object.keys(EN) as MessageKey[];
  for (const code of codes) {
    const catalog: Record<string, string | undefined> = LOCALES[code];
    const missing = keys.filter((key) => catalog[key] === undefined);
    const allowed = [
      ...NEUTRAL,
      ...(code === "vi" ? [] : SWAP_MARKET_ENGLISH),
      ...(code === "vi" ? [] : POINTS_ENGLISH),
      ...SAME_AS_ENGLISH[code],
    ];
    assert.deepEqual(
      missing.slice().sort(),
      allowed.slice().sort(),
      `${code}: untranslated keys do not match the declared list`,
    );
  }
});

test("a locale never restates the English string", () => {
  for (const code of codes) {
    for (const [key, value] of Object.entries(LOCALES[code])) {
      assert.notEqual(
        value,
        EN[key as MessageKey],
        `${code}: "${key}" repeats English — omit it and let the fallback do it`,
      );
      assert.notEqual(value?.trim(), "", `${code}: "${key}" is empty`);
    }
  }
});

test("placeholders survive translation", () => {
  for (const code of codes) {
    for (const [key, value] of Object.entries(LOCALES[code])) {
      assert.deepEqual(
        placeholders(value ?? ""),
        placeholders(EN[key as MessageKey]),
        `${code}: "${key}" changes the placeholder set`,
      );
    }
  }
});

test("the NUSD points flow names its public unit only as xPoints", () => {
  const pointsKeys = (Object.keys(EN) as MessageKey[]).filter((key) => (
    key.startsWith("earn.") || key.startsWith("kind.points") || key.startsWith("tx.points")
  ));

  for (const key of pointsKeys) {
    const englishVisibleCopy = EN[key].replace(/\{\w+\}/gu, "");
    assert.doesNotMatch(
      englishVisibleCopy,
      /\b0xPoint\b|(?<!0x)\bpoints?\b/iu,
      `en: ${key}`,
    );
    const translated = vi[key];
    if (translated !== undefined) {
      const vietnameseVisibleCopy = translated.replace(/\{\w+\}/gu, "");
      assert.doesNotMatch(vietnameseVisibleCopy, /\b0xPoint\b/iu, `vi: ${key}`);
      assert.equal(
        vietnameseVisibleCopy.toLocaleLowerCase("vi").includes("điểm"),
        false,
        `vi: ${key}`,
      );
    }
  }
});

test("xPoints toast and history templates append the public unit exactly once", () => {
  assert.equal(
    interpolate(EN["earn.toastRedeem"], { points: "1.24xPoints", amount: "2" }),
    "Redeemed 1.24xPoints for 2 NUSD",
  );
  assert.equal(
    interpolate(EN["tx.pointsRedeem"], { amount: "1.24xPoints" }),
    "Redeemed 1.24xPoints for NUSD",
  );
  assert.equal(
    interpolate(vi["earn.toastRedeem"]!, { points: "1,24xPoints", amount: "2" }),
    "Đã đổi 1,24xPoints lấy 2 NUSD",
  );
  assert.equal(
    interpolate(vi["tx.pointsRedeem"]!, { amount: "1,24xPoints" }),
    "Đã đổi 1,24xPoints lấy NUSD",
  );
});
