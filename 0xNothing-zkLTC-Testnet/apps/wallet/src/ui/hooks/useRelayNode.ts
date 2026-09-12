import { useEffect, useRef } from "react";
import type { Hex } from "viem";
import { t } from "../../core/i18n";
import { readQuantum } from "../../core/quantum/storage";
import { startRelayNode, type RelayTickResult } from "../../core/quantum/relayNode";
import { useWallet } from "../state/WalletContext";

/**
 * Runs the opt-in DePIN relayer node for as long as the wallet UI is open and
 * unlocked.
 *
 * Mounted once at the App root rather than inside the settings panel, so the
 * node keeps working while the user does something else — but still stops the
 * moment the wallet locks or the window closes. That bound is deliberate: the
 * node pays gas from a key that only exists in memory while unlocked, and the
 * alternative (a service-worker alarm holding a hot key outside the vault)
 * trades the wallet's main security property for a few more relays.
 *
 * The interval runs whether or not the node is enabled, and `runRelayNodeTick`
 * re-reads the switch every time. That costs one local storage read per tick and
 * buys the property that matters: flipping the toggle in Settings takes effect
 * on the next tick instead of on the next unlock. Nothing touches the network
 * until the user has opted in.
 *
 * Failure is silent by design. A node that cannot reach the board, or that loses
 * a race, is behaving correctly; surfacing either as a toast would train the user
 * to ignore toasts. The ledger in Settings is where outcomes live.
 */
export function useRelayNode(): void {
  const { phase, address, notify } = useWallet();
  /**
   * This device's own quantum wallet, which the node must never relay for: the
   * screen's own retry loop already covers it, and routing it through the hub
   * would spend the wallet's sponsored quota to pay the user's own gas.
   *
   * A ref refreshed after each tick, because the wallet may be created while
   * this hook is already mounted.
   */
  const own = useRef<Hex[]>([]);

  useEffect(() => {
    if (phase !== "ready" || address === null) return undefined;

    let cancelled = false;
    const refreshOwn = async (): Promise<void> => {
      try {
        const stored = await readQuantum();
        if (!cancelled) own.current = stored?.address === undefined ? [] : [stored.address];
      } catch {
        // Leave the previous value. An empty skip list would be the unsafe
        // default here — it is the one that spends money.
      }
    };
    void refreshOwn();

    const stop = startRelayNode(
      () => address as Hex,
      () => own.current,
      (result: RelayTickResult) => {
        void refreshOwn();
        // The one outcome worth interrupting for: the node spent the whole loss
        // budget and switched itself off. Silence there would read as "still
        // earning".
        if (result.disabled === true) notify(t("relay.nodeStopped"), "error");
      },
    );

    return () => {
      cancelled = true;
      stop();
    };
    // `notify` is stable from the context; depending on it would restart the
    // node on every toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, address]);
}
