import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { WalletNetwork } from "../../config/networks";
import { listRecords, listSettled, type TxKind, type TxRecord } from "../../core/services/history";
import { broadcastOutcome, missingRowReleases, seedBroadcastHold } from "../lib/broadcastHold";
import { useLiveRead } from "./useLiveRead";

interface Held {
  hash: Hex;
  owner: string;
  heldAt: number;
  /** Whether History has shown the row; a row seen and then gone stops holding. */
  seen: boolean;
}

/**
 * Holds a screen's Confirm after a BroadcastUnknownError until History settles
 * that transaction (mined, failed or dropped). The hold belongs to the account
 * and network that signed it; another account or network is not held back.
 *
 * `kinds` are the History kinds the screen's own job writes. A mined row of one
 * of them runs `onSent` (the screen's success path) instead of turning Confirm
 * back on for a job that already went through. A screen opened while such a row
 * is still pending starts held, so closing the popup does not drop the hold.
 */
export function useBroadcastHold(
  address: Address | null,
  network: WalletNetwork,
  kinds: readonly TxKind[],
): { held: boolean; hold: (hash: Hex, onSent?: (hash: Hex, row: TxRecord) => void) => void } {
  const [pending, setPending] = useState<Held | null>(null);
  // Not state: the screen's success path is only ever called, never rendered.
  const onSent = useRef<{ hash: Hex; run: (hash: Hex, row: TxRecord) => void } | null>(null);
  const owner = `${address ?? ""}:${network.id}:${network.rpcUrl}`;
  const active = pending !== null && pending.owner === owner && address !== null;
  const read = useLiveRead(
    active ? () => listSettled(address, network) : null,
    [active, pending?.hash, owner],
  );
  useEffect(() => {
    if (address === null) return;
    let alive = true;
    void listRecords(address, network).then((rows) => {
      const hash = seedBroadcastHold(rows, kinds, Date.now());
      if (!alive || hash === null) return;
      setPending((current) => (
        current !== null && current.owner === owner
          ? current
          : { hash, owner, heldAt: Date.now(), seen: true }
      ));
    }).catch(() => undefined);
    return () => { alive = false; };
    // The kinds are a screen constant; the owner names the account and network.
  }, [owner]);
  useEffect(() => {
    if (pending === null || !active || read.data === null) return;
    const outcome = broadcastOutcome(read.data, pending.hash, kinds);
    if (outcome === "pending") {
      if (!pending.seen) setPending({ ...pending, seen: true });
      return;
    }
    if (outcome === "missing" && !missingRowReleases(pending.seen, pending.heldAt, Date.now())) return;
    setPending(null);
    const sent = onSent.current;
    onSent.current = null;
    if (outcome !== "sent" || sent === null || sent.hash.toLowerCase() !== pending.hash.toLowerCase()) return;
    const row = read.data.find((entry) => entry.hash.toLowerCase() === pending.hash.toLowerCase());
    if (row !== undefined) sent.run(pending.hash, row);
  }, [active, pending, read.data, kinds]);
  return {
    held: active,
    hold: (hash, run) => {
      onSent.current = run === undefined ? null : { hash, run };
      setPending({ hash, owner, heldAt: Date.now(), seen: false });
    },
  };
}
