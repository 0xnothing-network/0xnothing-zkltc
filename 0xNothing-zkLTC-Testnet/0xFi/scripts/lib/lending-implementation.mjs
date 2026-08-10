export const CURRENT_LENDING_IMPLEMENTATION_STATUS =
  "fixed-rate-protocol-spread-80-85-90-paused-bootstrap-v2";
export const LEGACY_LENDING_IMPLEMENTATION_STATUS =
  "legacy-predates-bad-debt-inclusive-borrow-cap-fix";
export const LENDING_IMPLEMENTATION_REQUIRED_ACTION = "redeploy-or-state-migrate";
export const CURRENT_LENDING_IMPLEMENTATION_ID =
  "0x7a03229a63916cb50f31952711fc2ce4584e5105d94d54a1be15fda916848c70";
export const CURRENT_LENDING_COLLATERAL_RISK = Object.freeze({
  loanToValueBps: 8000,
  marginCallThresholdBps: 8500,
  liquidationThresholdBps: 9000,
  liquidationBonusBps: 500,
  decimals: 18,
});

export function lendingCollateralConfigurationMatches(
  config,
  { oracle, cap, enabled = true },
) {
  const risk = CURRENT_LENDING_COLLATERAL_RISK;
  return Boolean(
    Array.isArray(config)
      && typeof config[0] === "string"
      && config[0].toLowerCase() === String(oracle).toLowerCase()
      && config[1] === BigInt(cap)
      && config[2] === risk.loanToValueBps
      && config[3] === risk.liquidationThresholdBps
      && config[4] === risk.liquidationBonusBps
      && config[5] === risk.decimals
      && config[6] === enabled
      && config[7] === risk.marginCallThresholdBps,
  );
}

export function creationInputMatchesArtifact(input, artifactBytecode) {
  const normalizedInput = String(input || "").toLowerCase();
  const normalizedBytecode = String(artifactBytecode || "").toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(normalizedInput) || !/^0x[0-9a-f]+$/.test(normalizedBytecode)) {
    return false;
  }
  return normalizedInput.startsWith(normalizedBytecode);
}

export function lendingImplementationState(deployment) {
  const status = deployment.lendingImplementationStatus || "unrecorded";
  const migrationRequired = deployment.lendingImplementationMigrationRequired !== false
    || status !== CURRENT_LENDING_IMPLEMENTATION_STATUS;
  return {
    status,
    migrationRequired,
    requiredAction: migrationRequired
      ? deployment.lendingImplementationRequiredAction || LENDING_IMPLEMENTATION_REQUIRED_ACTION
      : null,
    manifestClaimsCurrentImplementation: !migrationRequired,
  };
}

export function lendingRuntimeState(deployment, liveImplementationId) {
  const recorded = lendingImplementationState(deployment);
  const normalizedLiveImplementationId = typeof liveImplementationId === "string"
    ? liveImplementationId.toLowerCase()
    : null;
  const implementationIdMatches = normalizedLiveImplementationId
    === CURRENT_LENDING_IMPLEMENTATION_ID;
  const migrationRequired = recorded.migrationRequired || !implementationIdMatches;
  return {
    ...recorded,
    expectedImplementationId: CURRENT_LENDING_IMPLEMENTATION_ID,
    liveImplementationId: normalizedLiveImplementationId,
    implementationIdMatches,
    runtimeCompatible: implementationIdMatches,
    migrationRequired,
    requiredAction: migrationRequired
      ? recorded.requiredAction || LENDING_IMPLEMENTATION_REQUIRED_ACTION
      : null,
    fixedRateImplementationReady: implementationIdMatches,
  };
}

export function lendingRiskActionsManifestEnabled(deployment) {
  const implementation = lendingImplementationState(deployment);
  if (implementation.migrationRequired) return false;

  // Once the staged synth replacement is part of this topology, lending may
  // only be exposed after both synth markets and gauges are published active.
  if (deployment.synthSafetyReserveMigration && (
    !deployment.synthSafetyReserve
      || !deployment.synthFeeGaugeFactory
      || deployment.synthRiskActivationStatus !== "active"
      || deployment.synthRiskActionsEnabled !== true
  )) return false;

  const activationGated = Boolean(
    deployment.lendingFixedRateMigration
      || deployment.lendingFixedRateActivationStatus
      || deployment.lendingRiskActionsEnabled !== undefined,
  );
  if (!activationGated) return true;

  return deployment.lendingFixedRateActivationStatus === "active"
    && deployment.lendingRiskActionsEnabled === true;
}

export function lendingActivationState(
  deployment,
  {
    activated,
    bootstrapOpen,
    supplyPaused,
    borrowPaused,
    collateralWithdrawalPaused,
  } = {},
) {
  const manifestEnabled = lendingRiskActionsManifestEnabled(deployment);
  const runtimeReadable = typeof activated === "boolean"
    && typeof bootstrapOpen === "boolean"
    && typeof supplyPaused === "boolean"
    && typeof borrowPaused === "boolean"
    && typeof collateralWithdrawalPaused === "boolean";
  const liveEnabled = runtimeReadable
    && activated
    && !bootstrapOpen
    && !supplyPaused
    && !borrowPaused
    && !collateralWithdrawalPaused;
  const staged = runtimeReadable
    && !activated
    && !bootstrapOpen
    && supplyPaused
    && borrowPaused
    && collateralWithdrawalPaused;

  return {
    activated: runtimeReadable ? activated : null,
    bootstrapOpen: runtimeReadable ? bootstrapOpen : null,
    staged,
    liveEnabled,
    manifestEnabled,
    manifestMatchesRuntime: runtimeReadable && manifestEnabled === liveEnabled,
    ready: runtimeReadable && liveEnabled && manifestEnabled,
  };
}

export function synthActivationLendingSafety({
  allSynthActive,
  activated,
  bootstrapOpen,
  supplyPaused,
  borrowPaused,
  collateralWithdrawalPaused,
  totalBorrowed,
  totalBadDebt,
  collateralAssetCount,
  expectedCollateralAssetCount = 5n,
}) {
  const staged = !activated
    && !bootstrapOpen
    && supplyPaused
    && borrowPaused
    && collateralWithdrawalPaused;
  const active = activated
    && !bootstrapOpen
    && !supplyPaused
    && !borrowPaused
    && !collateralWithdrawalPaused;
  const runtimeModeSafe = allSynthActive ? staged || active : staged;
  const requiresEmptyAccounting = !allSynthActive || !active;

  return {
    staged,
    active,
    runtimeModeSafe,
    requiresEmptyAccounting,
    collateralCountSafe: collateralAssetCount === expectedCollateralAssetCount,
    debtSafe: !requiresEmptyAccounting || totalBorrowed === 0n,
    badDebtSafe: totalBadDebt === 0n,
  };
}
