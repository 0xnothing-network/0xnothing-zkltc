import { type ReactNode, useState } from "react";
import type { Address } from "viem";
import { NUSD_TOKEN } from "../../config/assets";
import { t } from "../../core/i18n";
import { formatAmount } from "../../core/lib/format";
import {
  dismissPendingStagedSwap,
  loadPendingStagedSwap,
  type PendingStagedSwap,
} from "../../core/services/swap";
import { useLiveRead } from "../hooks/useLiveRead";
import { Button, Note, Panel, PanelBody } from "./kit";

/**
 * A two-stage swap whose page closed after its first leg: the user holds the
 * NUSD in between and is offered the second leg. Finishing never reuses the old
 * floor; it hands the NUSD amount to the Swap form, which quotes it afresh and
 * goes through the normal review. Dismiss forgets the marker. Finish only
 * hides the offer here: the quote can still fail or the popup close before the
 * second leg is signed, and the marker is the only reminder of the NUSD held.
 * It goes once that NUSD is spent (the balance check) or after its 24 h TTL.
 */
export function StagedSwapPrompt({
  address,
  networkKey,
  onFinish,
}: {
  address: Address | null;
  /** Network identity, so a switch re-reads the marker of that network. */
  networkKey: string;
  onFinish: (pending: PendingStagedSwap) => void;
}): ReactNode {
  const [answered, setAnswered] = useState<string | null>(null);
  const read = useLiveRead(
    address ? () => loadPendingStagedSwap(address) : null,
    [address, networkKey],
    { live: false },
  );
  const pending = read.data;
  if (pending === null || answered === pending.stage1Hash) return null;

  const answer = (finish: boolean): void => {
    setAnswered(pending.stage1Hash);
    if (finish) onFinish(pending);
    else void dismissPendingStagedSwap(pending).catch(() => {});
  };

  return (
    <Panel>
      <PanelBody>
        <div role="status">
          <Note tone="warn">
            {t("swap.finishPrompt", {
              delivered: formatAmount(pending.delivered, NUSD_TOKEN.decimals, 6),
              token: pending.tokenOutSymbol,
            })}
          </Note>
        </div>
        <div className="w-btn-row">
          <Button onClick={() => answer(false)}>{t("common.dismiss")}</Button>
          <Button variant="primary" onClick={() => answer(true)}>{t("swap.finish")}</Button>
        </div>
      </PanelBody>
    </Panel>
  );
}
