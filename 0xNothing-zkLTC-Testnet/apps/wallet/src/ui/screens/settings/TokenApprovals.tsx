import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, getAddress, type Hex } from "viem";
import { erc20Abi } from "../../../abis";
import { BUILTIN_TOKENS, customToken, impersonatesBuiltin, nativeTokenFor, type WalletToken } from "../../../config/assets";
import { txUrl } from "../../../config/chain";
import { isLitvmNetwork, networkIdentity, type WalletNetwork } from "../../../config/networks";
import { t } from "../../../core/i18n";
import { BroadcastUnknownError, describeError } from "../../../core/lib/errors";
import { formatAmount, formatFee, groupHex, shortenAddress } from "../../../core/lib/format";
import { publicClientFor } from "../../../core/rpc/client";
import { type ApprovalRecord, forgetApproval, listApprovalBook } from "../../../core/services/approvals";
import { lookupToken } from "../../../core/services/tokens";
import { writeCall } from "../../../core/services/tx";
import { Button, Note, Panel, PanelBody, Row, Rows } from "../../components/kit";
import { TokenLogo } from "../../components/TokenLogo";
import { TransactionReview } from "../../components/TransactionReview";
import { useActionGate } from "../../hooks/useActionGate";
import { useBroadcastHold } from "../../hooks/useBroadcastHold";
import { useLiveRead } from "../../hooks/useLiveRead";
import { UNLIMITED } from "../../lib/requestEffect";
import { reviewKey } from "../../lib/reviewKey";
import { parseHash } from "../../router";
import { useWallet } from "../../state/WalletContext";

/**
 * Token approvals this wallet signed on the active network, with the live
 * allowance read from the chain and a Revoke (approve to zero) through the
 * normal review. The list comes from the wallet's own records (approvals.ts),
 * never from a log scan; the allowances are read once per open, per Refresh and
 * after a revoke is mined, never polled.
 */
export interface ApprovalView {
  record: ApprovalRecord;
  token: Address;
  spender: Address;
  /** Display token; null when its metadata could not be read. */
  label: WalletToken | null;
  /** Null when the allowance read failed. */
  allowance: bigint | null;
}

async function readAllowances(
  owner: Address,
  network: WalletNetwork,
  records: readonly ApprovalRecord[],
): Promise<(bigint | null)[]> {
  const client = publicClientFor(network);
  const call = (record: ApprovalRecord) => ({
    address: getAddress(record.token),
    abi: erc20Abi,
    functionName: "allowance" as const,
    args: [owner, getAddress(record.spender)] as const,
  });
  // Multicall3 is known on the built-in chain only; a custom one reads in turn.
  if (isLitvmNetwork(network)) {
    const results = await client.multicall({ contracts: records.map(call), allowFailure: true })
      .catch(() => records.map(() => ({ status: "failure" as const, result: undefined })));
    return results.map((entry) => (entry.status === "success" ? entry.result as bigint : null));
  }
  const values: (bigint | null)[] = [];
  for (const record of records) {
    values.push(await client.readContract(call(record)).catch(() => null));
  }
  return values;
}

function tokenLabel(address: Address, network: WalletNetwork, meta: Awaited<ReturnType<typeof lookupToken>> | null): WalletToken | null {
  if (isLitvmNetwork(network)) {
    const builtin = BUILTIN_TOKENS.find((token) => token.address?.toLowerCase() === address.toLowerCase());
    if (builtin) return builtin;
  }
  return meta === null ? null : customToken({ address, ...meta });
}

export async function readApprovalViews(
  owner: Address,
  network: WalletNetwork,
): Promise<{ rows: ApprovalView[]; others: boolean }> {
  const book = await listApprovalBook(owner);
  const chain = String(network.chainId);
  const records = book[chain] ?? [];
  const others = Object.entries(book).some(([key, list]) => key !== chain && list.length > 0);
  // Nothing recorded on this chain: no RPC read at all.
  if (records.length === 0) return { rows: [], others };
  const tokens = [...new Set(records.map((record) => record.token))];
  const [allowances, metas] = await Promise.all([
    readAllowances(owner, network, records),
    Promise.all(tokens.map((token) => lookupToken(token, network).catch(() => null))),
  ]);
  const metaOf = new Map(tokens.map((token, index) => [token, metas[index] ?? null]));
  return {
    rows: records.map((record, index) => {
      const token = getAddress(record.token);
      return {
        record,
        token,
        spender: getAddress(record.spender),
        label: tokenLabel(token, network, metaOf.get(record.token) ?? null),
        allowance: allowances[index] ?? null,
      };
    }),
    others,
  };
}

/**
 * Revoke signs approve(spender, 0), which only revokes an ERC-20 allowance that
 * was read. On an ERC-721 (no decimals, so no label; allowance() reverts) the
 * same call approves token id 0 instead. A row whose allowance or token could
 * not be read shows "--" and Refresh, with no action.
 */
export function revocable(view: ApprovalView): boolean {
  return view.allowance !== null && view.allowance > 0n && view.label !== null;
}

function allowanceText(view: ApprovalView): ReactNode {
  if (view.allowance === null) return "--";
  if (view.allowance >= UNLIMITED) return <span className="w-token-warn">{t("apr.unlimited")}</span>;
  if (view.label === null) return t("apr.rawAmount", { value: view.allowance.toString() });
  return `${formatAmount(view.allowance, view.label.decimals, 6)} ${view.label.symbol}`;
}

function tokenText(view: ApprovalView): string {
  if (view.label === null) return shortenAddress(view.token);
  const warn = impersonatesBuiltin(view.label) ? ` ${t("tok.notOfficial")}` : "";
  return `${view.label.symbol}${warn} · ${shortenAddress(view.token)}`;
}

export function TokenApprovals(): ReactNode {
  const { address, network, notify } = useWallet();
  const [tick, setTick] = useState(0);
  const read = useLiveRead(
    address ? () => readApprovalViews(address, network) : null,
    [address, network.id, network.rpcUrl, tick],
    { live: false, identity: [address, network.id, network.rpcUrl] },
  );
  // The review is tied to the network it was opened on: another surface may
  // switch it, and the same address there may be another contract.
  const [review, setReview] = useState<(ApprovalView & { networkKey: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useActionGate();
  const broadcast = useBroadcastHold(address, network, []);
  const alive = useRef(true);
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    alive.current = true;
    // The Dapp screen's link lands here.
    if (parseHash(window.location.hash).params.get("panel") === "approvals") {
      panel.current?.scrollIntoView({ block: "start" });
    }
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setReview(null);
  }, [address, network.id, network.rpcUrl]);

  const fee = useLiveRead(
    review !== null && address
      ? async () => {
        const client = publicClientFor(network);
        const gas = await client.estimateContractGas({
          account: address,
          address: review.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [review.spender, 0n],
        });
        const fees = await client.estimateFeesPerGas().catch(async () => ({ maxFeePerGas: await client.getGasPrice() }));
        return gas * (fees.maxFeePerGas ?? 0n);
      }
      : null,
    [review?.record.token, review?.record.spender, address, network.id, network.rpcUrl],
    { live: false },
  );

  const rows = read.data?.rows ?? [];
  const symbol = review?.label?.symbol ?? (review ? shortenAddress(review.token) : "");
  const nativeToken = nativeTokenFor(network);

  const confirm = async (): Promise<void> => {
    if (busy || review === null || address === null || broadcast.held || fee.data === null) return;
    if (!revocable(review) || review.networkKey !== networkIdentity(network) || !gate.tryEnter()) return;
    const target = review;
    const submittedNetwork = network;
    setBusy(true);
    setError(null);
    // Also run when a held broadcast is later found mined. "Revoked" waits for a
    // successful receipt: a revoke that reverts or is dropped leaves the
    // allowance live.
    const sent = (hash: Hex): void => {
      notify(t("apr.txSent"), "ok", txUrl(hash, submittedNetwork));
      setReview(null);
      setTick((value) => value + 1);
      void publicClientFor(submittedNetwork)
        .waitForTransactionReceipt({ hash, timeout: 120_000 })
        .then((receipt) => {
          if (receipt.status === "success") notify(t("approvals.revoked"), "ok", txUrl(hash, submittedNetwork));
          else notify(t("err.txReverted"), "error", txUrl(hash, submittedNetwork));
          if (alive.current) setTick((value) => value + 1);
        })
        .catch(() => undefined);
    };
    try {
      sent(await writeCall({
        from: address,
        address: target.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [target.spender, 0n],
        kind: "approve",
        label: { key: "tx.revoke", params: { symbol } },
      }, { network: submittedNetwork, client: publicClientFor(submittedNetwork) }));
    } catch (cause) {
      // The node may hold it: keep the sheet, hold Confirm, link the hash.
      if (cause instanceof BroadcastUnknownError) {
        broadcast.hold(cause.hash, sent);
        notify(describeError(cause), "error", txUrl(cause.hash, submittedNetwork));
      }
      setError(describeError(cause));
    } finally {
      gate.leave();
      setBusy(false);
    }
  };

  const forget = async (view: ApprovalView): Promise<void> => {
    if (address === null || busy || !gate.tryEnter()) return;
    try {
      await forgetApproval(address, network.chainId, view.record.token, view.record.spender);
      setTick((value) => value + 1);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      gate.leave();
    }
  };

  return (
    <div id="token-approvals" ref={panel}>
      <Panel
        title={t("approvals.title")}
        aside={rows.length > 0 ? (
          <Button size="sm" variant="ghost" disabled={read.busy} onClick={() => setTick((value) => value + 1)}>
            {t("approvals.refresh")}
          </Button>
        ) : null}
      >
        <PanelBody>
          {read.loading && read.data === null ? (
            <Note>{t("common.working")}</Note>
          ) : rows.length === 0 ? (
            <Note>{read.error ?? t("approvals.empty")}</Note>
          ) : (
            rows.map((view) => (
              <div key={`${view.record.token}:${view.record.spender}`} className="w-set-form">
                <div className="w-split">
                  <span className="w-asset-main">
                    <span className="w-asset-symbol" title={view.token}>
                      {view.label !== null ? <TokenLogo token={view.label} size={20} /> : null} {tokenText(view)}
                    </span>
                    <span className="w-asset-sub">{t("approvals.spender")}</span>
                    <span className="w-asset-sub w-approval-spender">{groupHex(view.spender)}</span>
                    <span className="w-asset-sub">
                      {t("approvals.allowance")}: {allowanceText(view)}
                    </span>
                  </span>
                  {view.allowance === 0n ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forget(view)}>
                      {t("approvals.forget")}
                    </Button>
                  ) : revocable(view) ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy || broadcast.held}
                      onClick={() => {
                        setError(null);
                        setReview({ ...view, networkKey: networkIdentity(network) });
                      }}
                    >
                      {t("approvals.revoke")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {read.error !== null && rows.length > 0 ? (
            <div role="alert">
              <Note tone="error">{read.error}</Note>
            </div>
          ) : null}
          {error !== null && review === null ? (
            <div role="alert">
              <Note tone="error">{error}</Note>
            </div>
          ) : null}
          {read.data?.others ? <Note>{t("approvals.otherNetworks")}</Note> : null}
          <Note>{t("approvals.note")}</Note>
        </PanelBody>
      </Panel>
      {review !== null && address ? (
        <TransactionReview
          title={t("approvals.reviewTitle")}
          armKey={reviewKey([address, network.id, network.rpcUrl, review.record.token, review.record.spender, "revoke"])}
          busy={busy}
          ready={fee.data !== null && !broadcast.held}
          confirmLabel={t("approvals.revoke")}
          onClose={() => {
            if (!busy) setReview(null);
          }}
          onConfirm={() => void confirm()}
          error={error ?? fee.error}
        >
          <Rows>
            <Row label={t("common.token")} value={tokenText(review)} />
            <Row label={t("approvals.spender")} value={<span className="w-review-address">{groupHex(review.spender)}</span>} />
            <Row label={t("approvals.allowance")} value={allowanceText(review)} />
            <Row label={t("approvals.after")} value={review.label !== null ? `0 ${review.label.symbol}` : "0"} />
            <Row
              label={t("send.gasFee")}
              value={fee.data !== null ? `${formatFee(fee.data, nativeToken.decimals)} ${nativeToken.symbol}` : t("common.working")}
            />
            <Row label={t("common.network")} value={network.name} />
          </Rows>
        </TransactionReview>
      ) : null}
    </div>
  );
}
