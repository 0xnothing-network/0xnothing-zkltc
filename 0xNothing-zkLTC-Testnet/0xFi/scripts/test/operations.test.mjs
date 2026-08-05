import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { governanceAddress, governanceMode } from "../lib/graduation-runtime.mjs";
import {
  creationInputMatchesArtifact,
  CURRENT_LENDING_IMPLEMENTATION_STATUS,
  LEGACY_LENDING_IMPLEMENTATION_STATUS,
  lendingImplementationState,
} from "../lib/lending-implementation.mjs";
import { projectMainPumpGraduation } from "../lib/main-pump-publication.mjs";
import { mergeEnvironment, publicEnvironmentValues } from "../lib/public-environment.mjs";

const addresses = Array.from(
  { length: 25 },
  (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("governance mode resolves explicit direct governance without using a stale timelock", () => {
  const deployment = {
    governanceMode: "direct-deployer-no-timelock",
    deployer: addresses[0],
    timelock: addresses[1],
  };
  assert.equal(governanceMode(deployment), "direct");
  assert.equal(governanceAddress(deployment), addresses[0]);
});

test("governance mode defaults legacy deployments to their timelock", () => {
  const deployment = { deployer: addresses[0], timelock: addresses[1] };
  assert.equal(governanceMode(deployment), "timelock");
  assert.equal(governanceAddress(deployment), addresses[1]);
});

test("governance transition uses the effective deployer without claiming completion", () => {
  const deployment = {
    governanceMode: "transitioning-to-direct-deployer",
    governance: addresses[0],
    deployer: addresses[0],
    timelock: addresses[1],
  };
  assert.equal(governanceMode(deployment), "transition");
  assert.equal(governanceAddress(deployment), addresses[0]);
});

test("environment merge preserves unmanaged lines and removes stale aliases", () => {
  const source = [
    "# operator comment",
    "UNMANAGED=value",
    "NEXT_PUBLIC_FARM_FACTORY_ADDRESS=stale",
    "NEXT_PUBLIC_NBTC_ADDRESS=old",
    "NEXT_PUBLIC_NBTC_ADDRESS=duplicate",
    "",
  ].join("\n");
  const merged = mergeEnvironment(
    source,
    { NEXT_PUBLIC_NBTC_ADDRESS: addresses[0], NEXT_PUBLIC_OPTIONAL: null },
    ["NEXT_PUBLIC_FARM_FACTORY_ADDRESS"],
  );
  assert.match(merged, /^# operator comment\nUNMANAGED=value\n/m);
  assert.equal((merged.match(/NEXT_PUBLIC_NBTC_ADDRESS=/g) || []).length, 1);
  assert.match(merged, new RegExp(`NEXT_PUBLIC_NBTC_ADDRESS=${addresses[0]}`));
  assert.doesNotMatch(merged, /NEXT_PUBLIC_FARM_FACTORY_ADDRESS/);
  assert.doesNotMatch(merged, /NEXT_PUBLIC_OPTIONAL/);
  assert.ok(!merged.startsWith("\n"));
  assert.ok(merged.endsWith("\n"));
});

test("public environment uses the canonical gauge key and clears an absent controller", () => {
  const deployment = {
    deploymentBlock: "123",
    nusd: addresses[0],
    wzkLTC: addresses[1],
    nBTC: addresses[2],
    nETH: addresses[3],
    dexFactory: addresses[4],
    dexRouter: addresses[5],
    gaugeFactory: addresses[6],
    synthFeeGaugeFactory: addresses[22],
    synthSafetyReserve: addresses[21],
    lendingPool: addresses[7],
    nBTCVault: addresses[8],
    nETHVault: addresses[9],
    ltcOracle: addresses[10],
    btcOracle: addresses[11],
    ethOracle: addresses[12],
    pumpGraduationAdapter: addresses[13],
    pump: addresses[14],
    wzkLtcNusdPair: addresses[15],
    nBTCNusdPair: addresses[16],
    nETHNusdPair: addresses[17],
    wzkLtcNusdGauge: addresses[18],
    nBTCNusdGauge: addresses[19],
    nETHNusdGauge: addresses[20],
  };
  const network = {
    rpcUrl: "https://rpc.example",
    explorerUrl: "https://explorer.example",
    dia: { feeds: { wzkLTC: addresses[22], nBTC: addresses[23], nETH: addresses[24] } },
  };
  const values = publicEnvironmentValues({ deployment, network });
  assert.equal(values.NEXT_PUBLIC_GAUGE_FACTORY_ADDRESS, addresses[6]);
  assert.equal(values.NEXT_PUBLIC_SYNTH_FEE_GAUGE_FACTORY_ADDRESS, addresses[22]);
  assert.equal(values.NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS, addresses[21]);
  assert.equal(values.NEXT_PUBLIC_LENDING_RISK_ACTIONS_ENABLED, "false");
  assert.equal(values.NEXT_PUBLIC_PUMP_GRADUATION_CONTROLLER_ADDRESS, null);
  assert.equal("NEXT_PUBLIC_FARM_FACTORY_ADDRESS" in values, false);
  const legacyValues = publicEnvironmentValues({
    deployment: { ...deployment, synthSafetyReserve: undefined },
    network,
  });
  assert.equal(legacyValues.NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS, undefined);
  const cleared = mergeEnvironment(
    `NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS=${addresses[21]}\n`,
    legacyValues,
  );
  assert.doesNotMatch(cleared, /NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS=/);
});

test("fresh deployment and direct-governance migration use distinct artifacts", () => {
  const deploySource = fs.readFileSync(path.join(root, "contracts", "script", "Deploy0xFi.s.sol"), "utf8");
  const migrationSource = fs.readFileSync(
    path.join(root, "contracts", "script", "DisableTimelockTestnet.s.sol"),
    "utf8",
  );
  assert.match(deploySource, /\.\/deployments\/fresh-deployment\.json/);
  assert.match(migrationSource, /\.\/deployments\/direct-governance\.json/);
  assert.doesNotMatch(deploySource, /\.\/deployments\/direct-governance\.json/);
});

test("direct-governance resume bypasses the initial topology preflight", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "direct-governance.mjs"), "utf8");
  assert.match(
    source,
    /if \(mode !== "--resume"\) \{\s+await run\(process\.execPath, \[path\.join\(root, "scripts", "preflight\.mjs"\)\]\);/,
  );
});

test("lending implementation health fails closed for legacy or unrecorded deployments", () => {
  assert.equal(lendingImplementationState({}).migrationRequired, true);
  const legacy = lendingImplementationState({
    lendingImplementationStatus: LEGACY_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
  });
  assert.equal(legacy.migrationRequired, true);
  assert.equal(legacy.badDebtInclusiveBorrowCapFix, false);

  const current = lendingImplementationState({
    lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
  });
  assert.equal(current.migrationRequired, false);
  assert.equal(current.badDebtInclusiveBorrowCapFix, true);
});

test("lending creation input must contain the exact current creation artifact", () => {
  assert.equal(creationInputMatchesArtifact("0x60016002aabb", "0x60016002"), true);
  assert.equal(creationInputMatchesArtifact("0x60026002aabb", "0x60016002"), false);
  assert.equal(creationInputMatchesArtifact("", "0x60016002"), false);
  assert.equal(creationInputMatchesArtifact("0x6001", "not-bytecode"), false);
});

test("direct-governance finalization publishes the active controller to the main Pump manifest", () => {
  const manifest = {
    chainId: 4441,
    pump: {
      launchpad: addresses[0],
      graduationRouter: addresses[1],
      graduation: { adapter: addresses[2], controller: addresses[3], operational: false },
    },
  };
  const projected = projectMainPumpGraduation({
    manifest,
    chainId: 4441,
    pump: addresses[0],
    router: addresses[1],
    adapter: addresses[2],
    controller: addresses[4],
    governance: addresses[5],
    guardian: addresses[6],
    controllerDeploymentBlock: 456,
    controllerDeploymentHash: `0x${"ab".repeat(32)}`,
    verificationBlock: 789,
    activatedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(projected.pump.graduation.controller, addresses[4]);
  assert.equal(projected.pump.graduation.operational, true);
  assert.equal(projected.pump.graduation.controllerOwnsPumpAdmin, true);
  assert.equal(projected.pump.graduation.controllerOwnsRouterAdmin, true);
  assert.equal(projected.pump.graduation.lastVerifiedBlock, 789);
  assert.equal(manifest.pump.graduation.operational, false);
});

test("main Pump publication rejects a cross-deployment topology", () => {
  assert.throws(() => projectMainPumpGraduation({
    manifest: {
      chainId: 4441,
      pump: {
        launchpad: addresses[0],
        graduationRouter: addresses[1],
        graduation: { adapter: addresses[2] },
      },
    },
    chainId: 4441,
    pump: addresses[0],
    router: addresses[7],
    adapter: addresses[2],
    controller: addresses[4],
    governance: addresses[5],
    guardian: addresses[6],
    controllerDeploymentBlock: 456,
    controllerDeploymentHash: `0x${"ab".repeat(32)}`,
    verificationBlock: 789,
    activatedAt: "2026-08-03T00:00:00.000Z",
  }), /router.*does not match/i);
});
