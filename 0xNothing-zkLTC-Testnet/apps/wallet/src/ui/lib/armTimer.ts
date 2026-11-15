/** How long a review's Confirm stays disarmed after it shows a review. */
export const REVIEW_ARM_MS = 500;
/** How long a tap on the dimmed backdrop is ignored after a sheet opens. */
export const SHEET_BACKDROP_GRACE_MS = 300;

export interface ArmTimer {
  /** Disarms at once and arms `key` after the delay; a new key restarts it. */
  start: (key: string) => void;
  armed: (key: string) => boolean;
  stop: () => void;
}

/**
 * The review sheet opens under the finger that tapped Review, with Confirm at
 * the bottom where a double-tap's second touch lands. Arming per review key
 * makes that second touch hit a disabled button, and a changed review (new
 * amount, new quote) is disarmed again before it can be confirmed.
 */
export function createArmTimer(
  ms: number,
  onArmed: (key: string) => void = () => {},
): ArmTimer {
  let armedKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    start(key) {
      stop();
      armedKey = null;
      timer = setTimeout(() => {
        timer = undefined;
        armedKey = key;
        onArmed(key);
      }, ms);
    },
    armed: (key) => armedKey === key,
    stop,
  };
}

/** A backdrop tap closes the sheet only once the opening tap has settled. */
export function backdropCloseAllowed(shownAt: number, now: number): boolean {
  return now - shownAt >= SHEET_BACKDROP_GRACE_MS;
}
