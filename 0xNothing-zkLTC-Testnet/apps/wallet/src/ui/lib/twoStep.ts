/** How long a first tap on a destructive header action waits for the second. */
export const CONFIRM_TAP_MS = 3_000;
/** A second touch sooner than this is the same double-tap, not a decision. */
export const CONFIRM_TAP_MIN_MS = 300;

/**
 * Whether a tap on a two-step action carries it out. The first tap only arms
 * (the button then says "tap again"); a second tap inside the window fires.
 * A double-tap's second touch is too soon to count and leaves it armed; a tap
 * after the window arms again instead.
 */
export function secondTapFires(armedAt: number | null, now: number, ms = CONFIRM_TAP_MS): boolean {
  return armedAt !== null && now - armedAt >= CONFIRM_TAP_MIN_MS && now - armedAt <= ms;
}
