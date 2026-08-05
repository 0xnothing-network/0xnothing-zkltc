export const CURRENT_LENDING_IMPLEMENTATION_STATUS = "bad-debt-inclusive-borrow-cap-fix";
export const LEGACY_LENDING_IMPLEMENTATION_STATUS =
  "legacy-predates-bad-debt-inclusive-borrow-cap-fix";
export const LENDING_IMPLEMENTATION_REQUIRED_ACTION = "redeploy-or-state-migrate";

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
    badDebtInclusiveBorrowCapFix: !migrationRequired,
  };
}
