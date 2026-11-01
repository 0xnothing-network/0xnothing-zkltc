import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { Address } from "viem";
import { nativeTokenFor } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { BUILTIN_NETWORKS, LITVM_NETWORK, networkIdentity } from "../../config/networks";
import { type MessageKey, t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatAmount, shortenAddress } from "../../core/lib/format";
import {
  claimPendingRequest,
  type DappRequest,
  listPending,
  rejectClaimedRequest,
  releasePendingRequestClaim,
  resolveRequest,
  watchPending,
} from "../../core/services/dapp";
import { executeDappRequest } from "../../core/services/dappExecution";
import { lookupToken, type TokenMetadata } from "../../core/services/tokens";
import { previewRaw } from "../../core/services/tx";
import { Button, Note, Panel, PanelBody, Row, Rows } from "../components/kit";
import { Screen } from "../components/Screen";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import {
  callEffect,
  deadlineDate,
  effectTokens,
  type RequestEffect,
  typedEffect,
  UNLIMITED,
} from "../lib/requestEffect";
import { readableSignMessage, typedSummary } from "../lib/typedData";
import { useRoute } from "../router";
import { useWallet } from "../state/WalletContext";

/**
 * The approval window. It is the only place in the extension where a page's
 * request meets a key, and it is a separate window opened by the worker rather
 * than a panel inside the popup — a popup closes on every stray click, which for
 * a signing prompt would be a way to lose track of what was approved.
 *
 * Hex quantities from the page are parsed here and nowhere else: everything
 * upstream keeps them as the strings the dapp sent, so there is one place where
 * a malformed amount can be caught.
 */
const KIND_TITLE: Record<DappRequest["kind"], MessageKey> = {
  connect: "apr.titleConnect",
  transaction: "apr.titleTx",
  sign: "apr.titleSign",
  "sign-typed": "apr.titleTyped",
  "switch-network": "apr.titleNetwork",
};

/** The selectors worth naming: everything else is shown as raw calldata. */
const SELECTORS: Record<string, MessageKey> = {
  "0xa9059cbb": "apr.selTransfer",
  "0x095ea7b3": "apr.selApprove",
  "0x39509351": "apr.selIncreaseAllowance",
  "0x23b872dd": "apr.selTransferFrom",
  "0x42842e0e": "apr.selSafeTransferFrom",
  "0xb88d4fde": "apr.selSafeTransferFrom",
  "0xa22cb465": "apr.selSetApprovalForAll",
};

/** Token reads per request: a hostile batch permit could name hundreds of tokens. */
const MAX_TOKEN_READS = 16;

/** `undefined` while the token is still being read, `null` once it proved unreadable. */
type TokenMeta = TokenMetadata | null | undefined;

function amountText(amount: bigint, meta: TokenMeta): string {
  if (meta === undefined) return "…";
  if (meta === null) return t("apr.rawAmount", { value: amount.toString() });
  return t("common.amountWithSymbol", {
    amount: formatAmount(amount, meta.decimals, 6),
    symbol: meta.symbol,
  });
}

/** Who gets what, decoded from the request; rendered inside the panel's rows. */
function EffectRows({
  effect,
  metaOf,
}: {
  effect: RequestEffect;
  metaOf: (token: Address) => TokenMeta;
}): ReactNode {
  switch (effect.kind) {
    case "transfer":
      return (
        <>
          {effect.from !== null ? (
            <Row label={t("apr.from")} value={shortenAddress(effect.from, 10, 6)} />
          ) : null}
          <Row label={t("send.recipient")} value={shortenAddress(effect.to, 10, 6)} />
          <Row label={t("common.amount")} value={amountText(effect.amount, metaOf(effect.token))} />
        </>
      );
    case "nft-transfer":
      return (
        <>
          <Row label={t("apr.from")} value={shortenAddress(effect.from, 10, 6)} />
          <Row label={t("send.recipient")} value={shortenAddress(effect.to, 10, 6)} />
          <Row label={t("apr.tokenId")} value={`#${effect.tokenId.toString()}`} />
        </>
      );
    case "approve": {
      const until = deadlineDate(effect.validUntil);
      return (
        <>
          <Row label={t("apr.spender")} value={shortenAddress(effect.spender, 10, 6)} />
          {effect.grants.map((grant, index) => {
            const meta = metaOf(grant.token);
            const unlimited = grant.amount >= UNLIMITED;
            return (
              <Fragment key={index}>
                <Row
                  label={t("common.token")}
                  value={meta ? `${meta.symbol} · ${shortenAddress(grant.token)}` : shortenAddress(grant.token, 10, 6)}
                />
                <Row
                  label={t("apr.allowance")}
                  value={unlimited ? t("apr.unlimited") : amountText(grant.amount, meta)}
                  tone={unlimited ? "red" : grant.amount === 0n ? "green" : undefined}
                />
              </Fragment>
            );
          })}
          {effect.signed ? (
            <Row
              label={t("apr.validUntil")}
              value={until ?? t("apr.never")}
              tone={until === null ? "red" : undefined}
            />
          ) : null}
        </>
      );
    }
    case "approve-all":
      return (
        <>
          <Row label={t("apr.operator")} value={shortenAddress(effect.operator, 10, 6)} />
          <Row
            label={t("apr.allowance")}
            value={effect.approved ? t("apr.allNfts") : t("apr.revoked")}
            tone={effect.approved ? "red" : "green"}
          />
        </>
      );
  }
}

function selectorLabel(selector: string): string | null {
  const key = SELECTORS[selector];
  return key === undefined ? null : t(key);
}

function quantity(value: string | undefined): bigint | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return BigInt(value);
  } catch {
    throw new Error(t("apr.badQuantity", { value }));
  }
}

/** Display never throws on a malformed payload; approving it does. */
function safeQuantity(value: string | undefined): bigint | null {
  try {
    return quantity(value) ?? 0n;
  } catch {
    return null;
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
export function Approve(): ReactNode {
  const route = useRoute();
  const { address, network, settings, notify, refresh } = useWallet();
  const nativeToken = nativeTokenFor(network);
  const [queue, setQueue] = useState<DappRequest[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionGate = useActionGate();
  const [error, setError] = useState<string | null>(null);

  // The worker may queue a second request while the first is being read, so the
  // window follows storage rather than the id it was opened with.
  useEffect(() => {
    let alive = true;
    let changed = false;
    const unwatch = watchPending((next) => {
      changed = true;
      if (!alive) return;
      setQueue(next);
      setQueueError(null);
    });
    void listPending()
      .then((initial) => {
        // Do not let a slower initial read overwrite a newer storage event.
        if (alive && !changed) setQueue(initial);
      })
      .catch((cause: unknown) => {
        if (!alive || changed) return;
        setQueue([]);
        setQueueError(describeError(cause));
      });
    return () => {
      alive = false;
      unwatch();
    };
  }, []);

  const wanted = route.params.get("id");
  useEffect(() => {
    if (wanted !== null && queueError === null && queue?.length === 0) window.close();
  }, [queue, queueError, wanted]);

  const request = queue?.find((entry) => entry.id === wanted) ?? queue?.[0] ?? null;
  const signer = request?.account ?? address;
  const mismatch = request?.account !== undefined
    && (address === null || request.account.toLowerCase() !== address.toLowerCase());
  const networkMismatch = request !== null
    && ((request.networkId ?? LITVM_NETWORK.id) !== network.id
      || (request.networkIdentity !== undefined && request.networkIdentity !== networkIdentity(network)));
  const targetNetwork = request?.kind === "switch-network"
    ? [...BUILTIN_NETWORKS, ...settings.customNetworks].find(
        (candidate) => candidate.id === request.targetNetworkId,
      ) ?? null
    : null;
  const tx = request?.kind === "transaction" ? (request.tx ?? {}) : null;
  const effect = request === null
    ? null
    : tx !== null
      ? callEffect(tx.to, tx.data)
      : request.kind === "sign-typed"
        ? typedEffect(request.message ?? "")
        : null;
  // Past the cap a token shows raw units: `metaOf` answers null for it.
  const tokens = effectTokens(effect).slice(0, MAX_TOKEN_READS);
  const tokenMeta = useLiveRead(
    tokens.length > 0
      ? () => Promise.all(tokens.map((token) => lookupToken(token, network).catch(() => null)))
      : null,
    [request?.id ?? "", network.id, network.rpcUrl, tokens.join(",")],
    { live: false },
  );
  const metaOf = (token: Address): TokenMeta => {
    const index = tokens.indexOf(token);
    if (index < 0) return null;
    return tokenMeta.data === null ? undefined : (tokenMeta.data[index] ?? null);
  };

  const preview = useLiveRead(
    tx !== null && signer !== null
      ? () =>
          previewRaw({
            from: signer,
            to: tx.to,
            value: quantity(tx.value),
            data: tx.data,
            gas: quantity(tx.gas),
          })
      : null,
    [
      request?.id ?? "",
      signer ?? "",
      tx?.to ?? "",
      tx?.value ?? "",
      tx?.data ?? "",
      tx?.gas ?? "",
    ],
    { live: false },
  );

  /** The window exists for the queue; when the queue is empty it should go. */
  const finish = async (): Promise<void> => {
    const rest = await listPending();
    if (wanted !== null && rest.length === 0) window.close();
  };
  const approve = async (): Promise<void> => {
    if (
      busy
      || request === null
      || signer === null
      || mismatch
      || networkMismatch
      || !actionGate.tryEnter()
    ) return;
    setBusy(true);
    setError(null);
    let approvalClaim: string | null = null;
    let executionCompleted = false;
    try {
      approvalClaim = await claimPendingRequest(request.id);
      if (approvalClaim === null) {
        window.close();
        return;
      }
      const result = await executeDappRequest(request, signer, hostOf(request.origin), network, approvalClaim);
      executionCompleted = true;
      const settled = await resolveRequest(request.id, result, approvalClaim);
      if (request.kind === "transaction") {
        notify(t("apr.txSent"), "ok", txUrl(result, network));
        refresh();
      }
      if (!settled) {
        await finish();
        return;
      }
      await finish();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      if (
        approvalClaim !== null
        && !executionCompleted
        && request.kind !== "transaction"
      ) {
        await releasePendingRequestClaim(request.id, approvalClaim).catch(() => undefined);
      }
      actionGate.leave();
      setBusy(false);
    }
  };

  const reject = async (): Promise<void> => {
    if (busy || request === null || !actionGate.tryEnter()) return;
    setBusy(true);
    setError(null);
    let approvalClaim: string | null = null;
    let settled = false;
    try {
      approvalClaim = await claimPendingRequest(request.id);
      if (approvalClaim === null) {
        window.close();
        return;
      }
      settled = await rejectClaimedRequest(request.id, approvalClaim);
      if (!settled) {
        window.close();
        return;
      }
      await finish();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      if (approvalClaim !== null && !settled) {
        await releasePendingRequestClaim(request.id, approvalClaim).catch(() => undefined);
      }
      actionGate.leave();
      setBusy(false);
    }
  };
  if (queue === null) {
    return (
      <Screen title={t("apr.emptyTitle")}>
        <div className="w-stack" aria-live="polite">
          <Note>{t("app.opening")}</Note>
        </div>
      </Screen>
    );
  }
  if (request === null) {
    return (
      <Screen title={t("apr.emptyTitle")}>
        <div className="w-stack">
          {queueError !== null ? (
            <div role="alert">
              <Note tone="error">{queueError}</Note>
            </div>
          ) : null}
          <Note>{t("apr.emptyBody")}</Note>
          <Button block onClick={() => window.close()}>
            {t("common.close")}
          </Button>
        </div>
      </Screen>
    );
  }

  const host = hostOf(request.origin);
  const valueWei = tx === null ? null : safeQuantity(tx.value);
  const gasGiven = tx === null || tx.gas === undefined ? undefined : safeQuantity(tx.gas);
  const selector = tx?.data !== undefined && tx.data.length >= 10 ? tx.data.slice(0, 10) : null;
  const typed = request.kind === "sign-typed" ? typedSummary(request.message ?? "") : null;
  const wrongChain = typed !== null && typed.chainId !== null && typed.chainId !== network.chainId;
  const grantNote: MessageKey | null = effect?.kind === "approve" && effect.grants.some((grant) => grant.amount > 0n)
    ? (effect.signed ? "apr.permitNote" : "apr.approveNote")
    : effect?.kind === "approve-all" && effect.approved
      ? "apr.approveAllNote"
      : null;
  const unreadable = (tx !== null && valueWei === null)
    || (tx !== null && tx.gas !== undefined && gasGiven === null)
    || (request.kind === "sign-typed" && typed === null)
    || (request.kind === "switch-network" && targetNetwork === null);

  return (
    <Screen title={t(KIND_TITLE[request.kind])}>
      <div className="w-flow" aria-busy={busy}>
        <div className="w-flow-main">
          <div className="w-approve-origin">
          <span className="w-asset-symbol">{host}</span>
          <span className="w-asset-sub">{request.title ?? request.origin}</span>
          </div>
          {queue.length > 1 ? (
            <p className="w-queue">{t("apr.queueMore", { count: queue.length - 1 })}</p>
          ) : null}
        {request.kind === "connect" ? (
          <Panel title={t("apr.connectTitle")}>
            <PanelBody>
              <Rows>
                <Row
                  label={t("apr.seeAddress")}
                  value={signer === null ? "…" : shortenAddress(signer)}
                />
                <Row label={t("apr.seeBalance")} value={t("common.yes")} />
                <Row label={t("apr.askSign")} value={t("apr.askSignValue")} />
                <Row label={t("apr.moveFunds")} value={t("common.no")} tone="green" />
              </Rows>
              <Note>{t("apr.connectNote")}</Note>
            </PanelBody>
          </Panel>
        ) : null}
        {request.kind === "switch-network" ? (
          <Panel title={t("apr.networkTitle")}>
            <PanelBody>
              <Rows>
                <Row label={t("apr.currentNetwork")} value={network.name} />
                <Row
                  label={t("apr.requestedNetwork")}
                  value={targetNetwork?.name ?? t("apr.unreadableValue")}
                  tone={targetNetwork === null ? "red" : "green"}
                />
                <Row
                  label={t("apr.dataChainId")}
                  value={targetNetwork?.chainId.toString() ?? "—"}
                />
              </Rows>
              <Note>{t("apr.switchNote")}</Note>
            </PanelBody>
          </Panel>
        ) : null}
        {tx !== null ? (
          <Panel title={t("apr.txTitle")}>
            <PanelBody>
              <Rows>
                <Row
                  label={t("apr.signer")}
                  value={signer === null ? "…" : shortenAddress(signer)}
                />
                <Row
                  label={t("apr.sendTo")}
                  value={tx.to === undefined ? t("apr.deploy") : shortenAddress(tx.to, 10, 6)}
                  tone={tx.to === undefined ? "red" : undefined}
                />
                <Row
                  label={t("apr.valueAttached", { symbol: nativeToken.symbol })}
                  value={
                    valueWei === null
                      ? t("apr.unreadableValue")
                      : t("common.amountWithSymbol", {
                          amount: formatAmount(valueWei, nativeToken.decimals, 6),
                          symbol: nativeToken.symbol,
                        })
                  }
                  tone={valueWei !== null && valueWei > 0n ? "green" : undefined}
                />
                <Row
                  label={t("apr.functionCalled")}
                  value={
                    selector === null
                      ? t("apr.plainTransfer", { symbol: nativeToken.symbol })
                      : (selectorLabel(selector) ?? t("apr.contractCall", { selector }))
                  }
                />
                {effect !== null ? <EffectRows effect={effect} metaOf={metaOf} /> : null}
                <Row
                  label={t("apr.gas")}
                  value={(preview.data?.gas ?? gasGiven)?.toString() ?? "…"}
                />
                <Row
                  label={t("apr.maxFee")}
                  value={
                    preview.data?.feeWei === undefined || preview.data.feeWei === null
                      ? "…"
                      : t("common.amountWithSymbol", {
                          amount: formatAmount(preview.data.feeWei, nativeToken.decimals, 6),
                          symbol: nativeToken.symbol,
                        })
                  }
                />
              </Rows>
              {grantNote !== null ? <Note tone="warn">{t(grantNote)}</Note> : null}
              {tx.data !== undefined && tx.data !== "0x" ? (
                <p className="w-code w-mono-break">{tx.data}</p>
              ) : null}
            </PanelBody>
          </Panel>
        ) : null}
        {request.kind === "sign" ? (
          <Panel title={t("apr.signTitle")}>
            <PanelBody>
              <p className="w-code w-mono-break">{readableSignMessage(request.message ?? "")}</p>
              <Note>{t("apr.signNote")}</Note>
            </PanelBody>
          </Panel>
        ) : null}
        {request.kind === "sign-typed" ? (
          <Panel title={t("apr.typedTitle")}>
            <PanelBody>
              <Rows>
                <Row label={t("apr.domain")} value={typed?.domain ?? "—"} />
                <Row label={t("apr.primaryType")} value={typed?.primaryType ?? "—"} />
                <Row
                  label={t("apr.dataChainId")}
                  value={typed?.chainId === null || typed === null ? "—" : typed.chainId.toString()}
                  tone={wrongChain ? "red" : undefined}
                />
                {effect !== null ? <EffectRows effect={effect} metaOf={metaOf} /> : null}
              </Rows>
              {grantNote !== null ? <Note tone="warn">{t(grantNote)}</Note> : null}
              <p className="w-code w-mono-break">{request.message ?? ""}</p>
              <Note>{t("apr.typedNote")}</Note>
            </PanelBody>
          </Panel>
        ) : null}
        {mismatch ? (
          <Note tone="error">
            {t("apr.mismatch", { wallet: signer === null ? "—" : shortenAddress(signer) })}
          </Note>
        ) : null}
        {networkMismatch ? <Note tone="error">{t("apr.networkChanged")}</Note> : null}
        {wrongChain ? (
          <Note tone="error">{t("apr.wrongChain", { chainId: network.chainId })}</Note>
        ) : null}
        {unreadable ? <Note tone="error">{t("apr.unreadable")}</Note> : null}
        {preview.data?.revert !== undefined && preview.data.revert !== null ? (
          <Note tone="warn">{t("apr.gasFailed", { reason: preview.data.revert })}</Note>
        ) : null}
        {preview.error !== null ? <Note tone="warn">{preview.error}</Note> : null}
        {error !== null ? (
          <div role="alert">
            <Note tone="error">{error}</Note>
          </div>
        ) : null}
        </div>
        <div className="w-flow-actions">
          <div className="w-btn-row">
            <Button block disabled={busy} onClick={() => void reject()}>
              {t("apr.reject")}
            </Button>
            <Button
              variant="primary"
              block
              disabled={
                busy || signer === null || mismatch || networkMismatch || unreadable || wrongChain
              }
              onClick={() => void approve()}
            >
              {busy
                ? t("apr.working")
                : request.kind === "connect"
                  ? t("apr.connect")
                  : request.kind === "switch-network"
                    ? t("apr.switchNetwork")
                  : t("apr.sign")}
            </Button>
          </div>
          <Note>{t("apr.footer", { chainId: network.chainId, host })}</Note>
        </div>
      </div>
    </Screen>
  );
}
