import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { governanceAddress, governanceMode } from "../lib/graduation-runtime.mjs";
import {
  creationInputMatchesArtifact,
  CURRENT_LENDING_COLLATERAL_RISK,
  CURRENT_LENDING_IMPLEMENTATION_ID,
  CURRENT_LENDING_IMPLEMENTATION_STATUS,
  LEGACY_LENDING_IMPLEMENTATION_STATUS,
  lendingCollateralConfigurationMatches,
  lendingActivationState,
  lendingImplementationState,
  lendingRiskActionsManifestEnabled,
  lendingRuntimeState,
} from "../lib/lending-implementation.mjs";
import { projectMainPumpGraduation } from "../lib/main-pump-publication.mjs";
import {
  mergeEnvironment,
  publicEnvironmentTargets,
  publicEnvironmentValues,
  publicGeneratedConfigTarget,
  publicTestnetConfiguration,
  synthRiskActionsManifestEnabled,
} from "../lib/public-environment.mjs";

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

test("public environment targets the unified web app", () => {
  const targets = publicEnvironmentTargets(root);
  assert.deepEqual(targets, [
    path.resolve(root, "..", "apps", "web", ".env.local"),
    path.resolve(root, "..", "apps", "web", ".env.example"),
  ]);
  assert.ok(targets.every((target) => !target.includes(`${path.sep}0xFi${path.sep}web${path.sep}`)));
  assert.equal(
    publicGeneratedConfigTarget(root),
    path.resolve(root, "..", "apps", "web", "features", "fi", "config", "testnet.generated.json"),
  );
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
  assert.equal(values.NEXT_PUBLIC_SYNTH_RISK_ACTIONS_ENABLED, "false");
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

test("tracked testnet configuration publishes typed staged and active lending gates", () => {
  const deployment = {
    deploymentBlock: "123",
    nusd: addresses[0],
    wzkLTC: addresses[1],
    nBTC: addresses[2],
    nETH: addresses[3],
    dexFactory: addresses[4],
    dexRouter: addresses[5],
    gaugeFactory: addresses[6],
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
    lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
    lendingFixedRateMigration: { pool: addresses[7] },
    lendingFixedRateActivationStatus: "pending-owner-activation",
    lendingRiskActionsEnabled: false,
  };
  const network = {
    goldsky: { endpoint: "https://api.example.test/subgraphs/0xfi/staging/gn" },
    dia: { feeds: { wzkLTC: addresses[22], nBTC: addresses[23], nETH: addresses[24] } },
  };

  const staged = publicTestnetConfiguration({ deployment, network });
  assert.equal(staged.deploymentBlock, "123");
  assert.equal(staged.lendingRiskActionsEnabled, false);
  assert.equal(staged.synthFeeGaugeFactory, null);
  assert.equal(staged.synthSafetyReserve, null);
  assert.equal(staged.synthRiskActionsEnabled, false);
  assert.equal(staged.pumpGraduationController, null);
  assert.equal(typeof staged.lendingRiskActionsEnabled, "boolean");

  const active = publicTestnetConfiguration({
    deployment: {
      ...deployment,
      lendingFixedRateActivationStatus: "active",
      lendingRiskActionsEnabled: true,
    },
    network,
  });
  assert.equal(active.lendingRiskActionsEnabled, true);
});

test("synth public risk gate requires the reserve topology and explicit activation", () => {
  assert.equal(synthRiskActionsManifestEnabled({}), false);
  const staged = {
    synthSafetyReserve: addresses[0],
    synthFeeGaugeFactory: addresses[1],
    synthRiskActivationStatus: "pending-owner-activation",
    synthRiskActionsEnabled: false,
  };
  assert.equal(synthRiskActionsManifestEnabled(staged), false);
  assert.equal(synthRiskActionsManifestEnabled({
    ...staged,
    synthRiskActivationStatus: "active",
    synthRiskActionsEnabled: true,
  }), true);
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

test("fixed-rate lending migration preserves the historical V2 artifact", () => {
  const source = fs.readFileSync(
    path.join(root, "contracts", "script", "MigrateLendingFixedRate.s.sol"),
    "utf8",
  );
  const finalizer = fs.readFileSync(
    path.join(root, "scripts", "finalize-lending-fixed-rate.mjs"),
    "utf8",
  );
  const activator = fs.readFileSync(
    path.join(root, "scripts", "activate-lending-fixed-rate.mjs"),
    "utf8",
  );
  assert.match(source, /\.\/deployments\/lending-fixed-rate\.json/);
  assert.doesNotMatch(source, /\.\/deployments\/lending-v2\.json/);
  assert.match(finalizer, /"lending-fixed-rate\.json"/);
  assert.match(finalizer, /"MigrateLendingFixedRate\.s\.sol"/);
  assert.match(finalizer, /requireRecoverablePoolReference/);
  assert.match(finalizer, /pending-owner-activation/);
  assert.match(activator, /event MarketActivated\(\)/);
  assert.match(activator, /getTransactionReceipt/);
  assert.match(activator, /activationRequired: false/);
  assert.match(activator, /writePublicEnvironment/);
  assert.match(activator, /Synth migration must be finalized and activated before lending activation/);
  assert.match(activator, /collateral count is not exactly/);
  assert.match(activator, /receipt-backed MarketActivated event evidence/);
});

test("synth activation rechecks empty pair and gauge accounting before opening markets", () => {
  const activator = fs.readFileSync(
    path.join(root, "scripts", "activate-synth-safety-reserve.mjs"),
    "utf8",
  );
  assert.match(activator, /progressKey === "0000"/);
  assert.match(activator, /pair\/gauge changed after staged finalization/);
  assert.match(activator, /gaugeRewardAccumulator/);
  assert.match(activator, /gaugeNusdBalance/);
  assert.match(activator, /receipt-backed event evidence/);
});

test("deployment finalizers bind journal transactions to receipt senders and targets", () => {
  for (const script of [
    "finalize-lending-fixed-rate.mjs",
    "finalize-synth-safety-reserve.mjs",
  ]) {
    const source = fs.readFileSync(path.join(root, "scripts", script), "utf8");
    assert.match(source, /receipt sender/);
    assert.match(source, /receipt target/);
    assert.match(source, /CREATE receipt address/);
  }
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
  assert.equal(legacy.manifestClaimsCurrentImplementation, false);

  const current = lendingImplementationState({
    lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
  });
  assert.equal(current.migrationRequired, false);
  assert.equal(current.manifestClaimsCurrentImplementation, true);
});

test("lending runtime health verifies the onchain implementation identity", () => {
  const deployment = {
    lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
  };
  const current = lendingRuntimeState(deployment, CURRENT_LENDING_IMPLEMENTATION_ID.toUpperCase());
  assert.equal(current.runtimeCompatible, true);
  assert.equal(current.migrationRequired, false);
  assert.equal(current.fixedRateImplementationReady, true);

  for (const liveImplementationId of [null, `0x${"ab".repeat(32)}`]) {
    const incompatible = lendingRuntimeState(deployment, liveImplementationId);
    assert.equal(incompatible.runtimeCompatible, false);
    assert.equal(incompatible.migrationRequired, true);
    assert.equal(incompatible.fixedRateImplementationReady, false);
    assert.equal(incompatible.requiredAction, "redeploy-or-state-migrate");
  }
});

test("lending activation gate fails closed until runtime and manifests are fully active", () => {
  const stagedDeployment = {
    lendingImplementationStatus: CURRENT_LENDING_IMPLEMENTATION_STATUS,
    lendingImplementationMigrationRequired: false,
    lendingFixedRateMigration: { pool: addresses[0] },
    lendingFixedRateActivationStatus: "pending-owner-activation",
    lendingRiskActionsEnabled: false,
  };
  assert.equal(lendingRiskActionsManifestEnabled(stagedDeployment), false);
  const staged = lendingActivationState(stagedDeployment, {
    activated: false,
    bootstrapOpen: false,
    supplyPaused: true,
    borrowPaused: true,
    collateralWithdrawalPaused: true,
  });
  assert.equal(staged.staged, true);
  assert.equal(staged.liveEnabled, false);
  assert.equal(staged.manifestMatchesRuntime, true);
  assert.equal(staged.ready, false);

  const activeDeployment = {
    ...stagedDeployment,
    lendingFixedRateActivationStatus: "active",
    lendingRiskActionsEnabled: true,
  };
  assert.equal(lendingRiskActionsManifestEnabled(activeDeployment), true);
  const active = lendingActivationState(activeDeployment, {
    activated: true,
    bootstrapOpen: false,
    supplyPaused: false,
    borrowPaused: false,
    collateralWithdrawalPaused: false,
  });
  assert.equal(active.liveEnabled, true);
  assert.equal(active.manifestMatchesRuntime, true);
  assert.equal(active.ready, true);

  assert.equal(lendingRiskActionsManifestEnabled({
    ...activeDeployment,
    synthSafetyReserveMigration: { reserve: addresses[1] },
    synthSafetyReserve: addresses[1],
    synthFeeGaugeFactory: addresses[2],
    synthRiskActivationStatus: "pending-owner-activation",
    synthRiskActionsEnabled: false,
  }), false);
  assert.equal(lendingRiskActionsManifestEnabled({
    ...activeDeployment,
    synthSafetyReserveMigration: { reserve: addresses[1] },
    synthSafetyReserve: addresses[1],
    synthFeeGaugeFactory: addresses[2],
    synthRiskActivationStatus: "active",
    synthRiskActionsEnabled: true,
  }), true);

  const unpublished = lendingActivationState(stagedDeployment, {
    activated: true,
    bootstrapOpen: false,
    supplyPaused: false,
    borrowPaused: false,
    collateralWithdrawalPaused: false,
  });
  assert.equal(unpublished.manifestMatchesRuntime, false);
  assert.equal(unpublished.ready, false);
});

test("current lending collateral risk rejects the legacy 50/65 configuration", () => {
  const oracle = addresses[0];
  const cap = 123n;
  assert.deepEqual(CURRENT_LENDING_COLLATERAL_RISK, {
    loanToValueBps: 8000,
    marginCallThresholdBps: 8500,
    liquidationThresholdBps: 9000,
    liquidationBonusBps: 500,
    decimals: 18,
  });
  assert.equal(lendingCollateralConfigurationMatches(
    [oracle, cap, 8000, 9000, 500, 18, true, 8500],
    { oracle, cap },
  ), true);
  assert.equal(lendingCollateralConfigurationMatches(
    [oracle, cap, 5000, 6500, 500, 18, true, 0],
    { oracle, cap },
  ), false);
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
