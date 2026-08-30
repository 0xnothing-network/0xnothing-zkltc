import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTRACTS, FI_DEPLOYMENT_BLOCK, PIXEL_START_BLOCK } from "../src/config/contracts.ts";

/**
 * The wallet mirrors its addresses by hand: importing the web app's generated
 * config would drag that build into this one. A hand-copied address that goes
 * stale after a redeploy would send funds to a dead contract, so every one of
 * them is pinned here against the file it was copied from.
 */
type Json = Record<string, unknown>;

function read(path: string): Json {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Json;
}

const fi = read("../../web/features/fi/config/testnet.generated.json");
const deployed = read("../../../deployments/liteforge-testnet/deployments.json");

function text(source: Json, key: string): string {
  const value = source[key];
  assert.equal(typeof value, "string", `${key} is not a string in the mirrored file`);
  return value as string;
}

function group(source: Json, key: string): Json {
  const value = source[key];
  assert.equal(typeof value, "object", `${key} is not an object in the mirrored file`);
  return value as Json;
}

function same(mirrored: string, source: string): void {
  assert.equal(mirrored.toLowerCase(), source.toLowerCase());
}

test("addresses copied from the web app's generated config still match it", () => {
  same(CONTRACTS.nusd, text(fi, "nusd"));
  same(CONTRACTS.wzkltc, text(fi, "wzkltc"));
  same(CONTRACTS.nbtc, text(fi, "nbtc"));
  same(CONTRACTS.neth, text(fi, "neth"));
  same(CONTRACTS.dexFactory, text(fi, "dexFactory"));
  same(CONTRACTS.dexRouter, text(fi, "dexRouter"));
  same(CONTRACTS.lendingPool, text(fi, "lendingPool"));
  same(CONTRACTS.diaLtcFeed, text(fi, "diaLtcFeed"));
  same(CONTRACTS.pumpFactory, text(fi, "pump"));
  assert.equal(FI_DEPLOYMENT_BLOCK, BigInt(text(fi, "deploymentBlock")));
});

/**
 * NUSD prices its own mint and redeem through this adapter, and the wallet reads
 * the address off the contract at runtime. What is pinned here is the fallback
 * for a failed read: the 0xFi stack deploys a *second* adapter over the same DIA
 * feed (`ltcOracle` in the generated config), and quoting a mint against that
 * one would mean showing a price the mint does not use.
 */
test("the NUSD oracle fallback is NUSD's own adapter, not 0xFi's", () => {
  const pump = group(deployed, "pump");
  same(CONTRACTS.nusdOracleAdapter, text(pump, "diaOracleAdapter"));
  same(CONTRACTS.nusd, text(pump, "nusd"));
  assert.notEqual(
    CONTRACTS.nusdOracleAdapter.toLowerCase(),
    text(fi, "ltcOracle").toLowerCase(),
    "the wallet is back on the 0xFi adapter",
  );
});

test("pixel addresses and the log-scan floor match the deployment record", () => {
  const pixel = group(deployed, "pixel");
  same(CONTRACTS.pixelNft, text(pixel, "nft"));
  same(CONTRACTS.pixelMarketplace, text(pixel, "marketplace"));
  assert.equal(PIXEL_START_BLOCK, BigInt(pixel.nftStartBlock as number));
});
