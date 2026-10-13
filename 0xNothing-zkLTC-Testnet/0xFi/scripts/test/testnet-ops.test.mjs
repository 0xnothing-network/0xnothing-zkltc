import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { planWorkerRun, SELECTORS } from "../../keepers/sync-price/worker.mjs";
import {
  DEFAULT_SEED_CORE_NUSD,
  parseSeedAmounts,
  pairIsLiquid,
  planLiquiditySeed,
  resolveSeedTargets,
  seedPlanNeedsBroadcast,
} from "../lib/seed-liquidity-policy.mjs";
import {
  decideSyncPrice,
  DEFAULT_DIA_ADAPTER,
  parseCliMode,
  resolveAdapterAddress,
} from "../lib/sync-price-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const network = JSON.parse(fs.readFileSync(path.join(root, "config", "liteforge-testnet.json"), "utf8"));
const staleLatest = JSON.parse(fs.readFileSync(path.join(root, "contracts", "deployments", "latest.json"), "utf8"));

test("seed amounts reject non-wei values and stay inside the reviewed bounds", () => {
  assert.deepEqual(parseSeedAmounts({}), {
    coreNusd: DEFAULT_SEED_CORE_NUSD,
    synthCollateralNusd: 15n * 10n ** 17n,
  });
  assert.equal(parseSeedAmounts({ SEED_CORE_NUSD: "50000000000000000" }).coreNusd, 5n * 10n ** 16n);
  assert.throws(() => parseSeedAmounts({ SEED_CORE_NUSD: "1.5" }), /SEED_CORE_NUSD/);
  assert.throws(() => parseSeedAmounts({ SEED_SYNTH_COLLATERAL_NUSD: "1" }), /SEED_SYNTH_COLLATERAL_NUSD/);
});

test("seed targets come from liteforge-testnet.json, not the stale latest.json NUSD", () => {
  const targets = resolveSeedTargets(network);
  assert.equal(targets.nusd.toLowerCase(), network.existingContracts.nusd.toLowerCase());
  assert.notEqual(targets.nusd.toLowerCase(), String(staleLatest.nusd).toLowerCase());
  assert.equal(targets.corePair.toLowerCase(), network.deployment.contracts.wzkLtcNusdPair.toLowerCase());
  assert.equal(targets.nbtcPair.toLowerCase(), network.deployment.contracts.nBTCNusdPair.toLowerCase());
  assert.equal(targets.nethPair.toLowerCase(), network.deployment.contracts.nETHNusdPair.toLowerCase());
  assert.throws(() => resolveSeedTargets({ chainId: 1 }), /4441/);
});

test("seed planner skips inactive vaults and already-liquid pairs", () => {
  const amounts = parseSeedAmounts({});
  const actions = planLiquiditySeed({
    coreLiquid: false,
    amounts,
    markets: [
      { symbol: "nBTC", liquid: false, vaultActivated: false, mintPaused: false },
      { symbol: "nETH", liquid: true, vaultActivated: true, mintPaused: false },
    ],
  });
  assert.deepEqual(actions.map((action) => [action.id, action.action, action.reason]), [
    ["wzkLTC/NUSD", "seed-native", "empty-pair"],
    ["nBTC/NUSD", "skip", "vault-inactive"],
    ["nETH/NUSD", "skip", "already-liquid"],
  ]);
  assert.equal(seedPlanNeedsBroadcast(actions), true);
  assert.equal(pairIsLiquid([0n, 1n]), false);
  assert.equal(pairIsLiquid([1n, 2n]), true);
  assert.equal(seedPlanNeedsBroadcast(planLiquiditySeed({
    coreLiquid: true,
    amounts,
    markets: [
      { symbol: "nBTC", liquid: true, vaultActivated: true, mintPaused: false },
      { symbol: "nETH", liquid: true, vaultActivated: true, mintPaused: false },
    ],
  })), false);
});

test("syncPrice policy arms, refreshes an aging anchor, and skips a live one", () => {
  assert.deepEqual(decideSyncPrice({
    canReadPrice: false,
    anchorPriceWad: 0n,
    anchorUpdatedAt: 0,
    maxPriceAge: 3600,
    now: 10_000,
  }), { action: "skip", reason: "feed-unreadable" });
  assert.deepEqual(decideSyncPrice({
    canReadPrice: true,
    anchorPriceWad: 0n,
    anchorUpdatedAt: 0,
    maxPriceAge: 3600,
    now: 10_000,
  }), { action: "sync", reason: "unarmed-anchor" });
  assert.deepEqual(decideSyncPrice({
    canReadPrice: true,
    anchorPriceWad: 50n * 10n ** 18n,
    anchorUpdatedAt: 6_400,
    maxPriceAge: 3600,
    now: 10_000,
    leadSeconds: 300,
  }), { action: "sync", reason: "aging-anchor" });
  assert.deepEqual(decideSyncPrice({
    canReadPrice: true,
    anchorPriceWad: 50n * 10n ** 18n,
    anchorUpdatedAt: 9_000,
    maxPriceAge: 3600,
    now: 10_000,
    leadSeconds: 300,
  }), { action: "skip", reason: "anchor-fresh" });
});

test("syncPrice CLI and adapter resolution stay fail-closed", () => {
  assert.deepEqual(parseCliMode(["--dry-run"]), { once: false, dryRun: true, loop: false });
  assert.deepEqual(parseCliMode(["--once"]), { once: true, dryRun: false, loop: false });
  assert.deepEqual(parseCliMode([]), { once: false, dryRun: false, loop: true });
  assert.throws(() => parseCliMode(["--once", "--dry-run"]), /Choose --once or --dry-run/);
  assert.throws(() => parseCliMode(["--broadcast"]), /Usage/);
  assert.equal(resolveAdapterAddress(undefined), DEFAULT_DIA_ADAPTER);
  assert.throws(() => resolveAdapterAddress("0x1234"), /20-byte/);
});

test("Cloudflare worker planner uses the same policy and known selectors", () => {
  assert.equal(SELECTORS.syncPrice, "0x3f438fbb");
  assert.deepEqual(planWorkerRun({
    fresh: true,
    anchorPriceWad: 0n,
    anchorUpdatedAt: 0,
    maxPriceAge: 3600,
    now: 1,
    leadSeconds: 300,
  }), { action: "sync", reason: "unarmed-anchor" });
});
