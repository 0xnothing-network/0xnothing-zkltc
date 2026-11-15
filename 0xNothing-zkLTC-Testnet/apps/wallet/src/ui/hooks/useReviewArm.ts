import { useEffect, useState } from "react";
import { createArmTimer, REVIEW_ARM_MS } from "../lib/armTimer";

/**
 * True once the review identified by `key` has been on screen for
 * REVIEW_ARM_MS. A new key reads as disarmed in the same render, so a changed
 * review is never confirmable for a frame on the old key's timer.
 */
export function useReviewArm(key: string | null): boolean {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  useEffect(() => {
    // A closed review forgets its arming, so reopening the same one waits again.
    setArmedKey(null);
    if (key === null) return;
    const timer = createArmTimer(REVIEW_ARM_MS, setArmedKey);
    timer.start(key);
    return () => timer.stop();
  }, [key]);
  return key !== null && armedKey === key;
}
