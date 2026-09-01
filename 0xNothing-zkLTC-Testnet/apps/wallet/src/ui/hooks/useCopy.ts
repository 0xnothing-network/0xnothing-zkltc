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
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
        resetTimer.current = null;
      }
    };
  }, []);

  const copy = useCallback(async (text: string) => {
    const request = ++requestRef.current;
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    if (mountedRef.current) setCopied(false);
    const ok = await copyText(text);
    if (!mountedRef.current || requestRef.current !== request || !ok) return ok;
    setCopied(true);
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null;
      if (mountedRef.current && requestRef.current === request) setCopied(false);
    }, 2_000);
    return true;
  }, []);

  return { copied, copy };
}
