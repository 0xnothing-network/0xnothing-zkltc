import { useEffect, useState } from "react";
import { chainScope, type WalletNetwork } from "../../config/networks";
import { type RecentRecipient, recentRecipients } from "../lib/recipients";

/**
 * The recent recipients of `address` on this chain. Null while the read runs,
 * so no "first time" warning flashes before the list is known; a failed read
 * is an empty list, which warns rather than stays quiet.
 */
export function useRecipients(address: string | null, network: WalletNetwork): RecentRecipient[] | null {
  const scope = chainScope(network.id);
  const [known, setKnown] = useState<RecentRecipient[] | null>(null);
  useEffect(() => {
    setKnown(null);
    if (address === null) return undefined;
    let alive = true;
    void recentRecipients(address, scope).then(
      (list) => {
        if (alive) setKnown(list);
      },
      () => {
        if (alive) setKnown([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [address, scope]);
  return known;
}
