import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicConfig = JSON.parse(
  fs.readFileSync(path.join(root, "..", "config", "liteforge-testnet.json"), "utf8"),
);
const endpoint = publicConfig.goldsky?.endpoint;
const contracts = publicConfig.deployment?.contracts;
if (!endpoint || !contracts) throw new Error("Goldsky endpoint or active deployment is missing");

const query = `query DeploymentAudit {
  _meta { block { number } hasIndexingErrors }
  pools(first: 1000) { id }
  gauges(first: 1000) { id }
  syntheticMarkets(first: 1000) {
    id
    safetyReserve
    totalCollateralNusd
    totalUserCollateralNusd
    totalReserveCollateralNusd
  }
  lendingMarkets(first: 1000) { id }
}`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Goldsky returned HTTP ${response.status}`);
const payload = await response.json();
if (payload.errors?.length) {
  throw new Error(payload.errors.map((error) => error.message || "Indexer query failed").join("; "));
}
if (!payload.data?._meta?.block?.number) throw new Error("Goldsky returned no indexed block");
if (payload.data._meta.hasIndexingErrors) throw new Error("Goldsky reports indexing errors");

const findings = [];
function recordMissing(label, rows, expected) {
  const actual = new Set((rows || []).map((row) => String(row.id).toLowerCase()));
  const missing = expected.filter(Boolean).filter((address) => !actual.has(address.toLowerCase()));
  if (missing.length) findings.push({ label, missing });
}

recordMissing("Pools", payload.data.pools, [
  contracts.wzkLtcNusdPair,
  contracts.nBTCNusdPair,
  contracts.nETHNusdPair,
]);
recordMissing("Gauges", payload.data.gauges, [
  contracts.wzkLtcNusdGauge,
  contracts.nBTCNusdGauge,
  contracts.nETHNusdGauge,
]);
recordMissing("Synthetic markets", payload.data.syntheticMarkets, [
  contracts.nBTCVault,
  contracts.nETHVault,
]);
recordMissing("Lending markets", payload.data.lendingMarkets, [contracts.lendingPool]);

const expectedSafetyReserve = contracts.synthSafetyReserve?.toLowerCase();
for (const market of payload.data.syntheticMarkets || []) {
  const total = BigInt(market.totalCollateralNusd);
  const user = BigInt(market.totalUserCollateralNusd);
  const reserve = BigInt(market.totalReserveCollateralNusd);
  if (total !== user + reserve) {
    findings.push({ label: "Synthetic collateral accounting", market: market.id });
  }
  if (expectedSafetyReserve && market.safetyReserve.toLowerCase() !== expectedSafetyReserve) {
    findings.push({
      label: "Synthetic safety reserve binding",
      market: market.id,
      expected: contracts.synthSafetyReserve,
      actual: market.safetyReserve,
    });
  }
}

console.log(JSON.stringify({
  endpoint,
  indexedBlock: payload.data._meta.block.number,
  hasIndexingErrors: payload.data._meta.hasIndexingErrors,
  ready: findings.length === 0,
  findings,
}, null, 2));
if (findings.length) process.exitCode = 1;
