/**
 * Readiness of a reviewed rewards claim. `claim(from)` pays out everything
 * earned at execution, not the reviewed figure, and rewards stream every
 * second, so the reviewed amount is only a lower bound: a grown balance keeps
 * Confirm armed, a shrunk one (claimed from another device) disarms it.
 */
export function claimReviewReady(
  reviewed: { identity: string; amount: bigint },
  current: { identity: string; claimable: bigint | null },
): boolean {
  return reviewed.identity === current.identity
    && reviewed.amount > 0n
    && current.claimable !== null
    && current.claimable >= reviewed.amount;
}
