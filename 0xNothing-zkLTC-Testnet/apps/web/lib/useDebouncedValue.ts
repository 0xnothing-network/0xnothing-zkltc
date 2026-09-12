"use client";

import { useEffect, useState } from "react";

/** Long enough to swallow a fast typist's gaps, short enough to feel immediate. */
const DEFAULT_DEBOUNCE_MS = 220;

/**
 * Holds a value steady until it stops changing.
 *
 * Every amount field in the app feeds a parsed amount straight into a contract
 * quote's query key, so an undebounced field turned each keystroke into its own
 * round trip: typing "123.456" asked the chain about seven different amounts,
 * six of which the user was still in the middle of replacing. On the swap form,
 * where one amount fans out to six candidate-route quotes, that is roughly fifty
 * eth_calls and fifty cache entries for a single number — and the quote helper
 * and submit button flickered once per character while it happened.
 *
 * Only the value the queries key on is delayed; the typed text itself is state
 * owned by the field and still renders on the keystroke.
 *
 * `pending` is derived during render rather than set from the effect, so it is
 * true on the very first render after a change. A caller folds it into whatever
 * "still quoting" flag it already has, which is what stops the form from
 * treating a quote for the previous amount as executable for the current one.
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number = DEFAULT_DEBOUNCE_MS,
): { value: T; pending: boolean } {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, settled, value]);

  return { value: settled, pending: !Object.is(settled, value) };
}
