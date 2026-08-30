import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../../core/platform/env";

/**
 * Copy-to-clipboard with a two-second acknowledgement. `copyText` already falls
 * back through the Capacitor plugin and a hidden textarea, so the hook only has
 * to report whether it worked.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    if (!ok) return false;
    setCopied(true);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      setCopied(false);
    }, 2_000);
    return true;
  }, []);

  return { copied, copy };
}
