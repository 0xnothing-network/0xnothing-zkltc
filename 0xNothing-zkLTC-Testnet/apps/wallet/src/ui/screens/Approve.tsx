import { type ReactNode, useEffect, useState } from "react";
import { type Address, hexToString, isHex } from "viem";
import { nativeTokenFor } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { BUILTIN_NETWORKS, LITVM_NETWORK } from "../../config/networks";
import { type MessageKey, t } from "../../core/i18n";
import { signerFor } from "../../core/keyring/vault";
import { describeError } from "../../core/lib/errors";
import { formatAmount, shortenAddress } from "../../core/lib/format";
import {
  type DappRequest,
  listPending,
  rejectRequest,
  resolveRequest,
  watchPending,
} from "../../core/services/dapp";
import { previewRaw, sendRaw } from "../../core/services/tx";
import { Button, Note, Panel, PanelBody, Row, Rows } from "../components/kit";
import { Screen } from "../components/Screen";
import { useLiveRead } from "../hooks/useLiveRead";
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

/** The four selectors worth naming: everything else is shown as raw calldata. */
const SELECTORS: Record<string, MessageKey> = {
  "0xa9059cbb": "apr.selTransfer",
  "0x095ea7b3": "apr.selApprove",
  "0x23b872dd": "apr.selTransferFrom",
  "0x42842e0e": "apr.selSafeTransferFrom",
};

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

function typedSummary(
  message: string,
): { domain: string; primaryType: string; chainId: number | null } | null {
  try {
    const parsed = JSON.parse(message) as {
      domain?: { name?: string; chainId?: number | string };
      primaryType?: string;
    };
    const chainId = parsed.domain?.chainId;
    return {
      domain: parsed.domain?.name ?? "—",
      primaryType: parsed.primaryType ?? "—",
      chainId: chainId === undefined ? null : Number(chainId),
    };
  } catch {
    return null;
  }
}

/** personal_sign carries hex-encoded UTF-8 far more often than plain text. */
function readable(message: string): string {
  if (!isHex(message)) return message;
  try {
    const text = hexToString(message);
    return /^[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]*$/u.test(text) ? text : message;
  } catch {
    return message;
  }
}
async function execute(request: DappRequest, signer: Address, host: string): Promise<string> {
  if (request.kind === "connect") return signer;
  if (request.kind === "switch-network") {
    if (!request.targetNetworkId) throw new Error(t("apr.unreadable"));
    return request.targetNetworkId;
  }
  if (request.kind === "transaction") {
    const tx = request.tx ?? {};
    return sendRaw({
      from: signer,
      to: tx.to,
      value: quantity(tx.value),
      data: tx.data,
      gas: quantity(tx.gas),
      label: { key: "tx.dapp", params: { host } },
      detail: tx.to,
    });
  }
  const account = await signerFor(signer);
  if (request.kind === "sign") {
    const message = request.message ?? "";
    return account.signMessage({ message: isHex(message) ? { raw: message } : message });
  }
  return account.signTypedData(JSON.parse(request.message ?? "{}") as never);
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
    && (request.networkId ?? LITVM_NETWORK.id) !== network.id;
  const targetNetwork = request?.kind === "switch-network"
    ? [...BUILTIN_NETWORKS, ...settings.customNetworks].find(
        (candidate) => candidate.id === request.targetNetworkId,
      ) ?? null
    : null;
  const tx = request?.kind === "transaction" ? (request.tx ?? {}) : null;

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
    if (busy || request === null || signer === null || mismatch || networkMismatch) return;
    setBusy(true);
    setError(null);
    try {
      const result = await execute(request, signer, hostOf(request.origin));
      await resolveRequest(request.id, result);
      if (request.kind === "transaction") {
        notify(t("apr.txSent"), "ok", txUrl(result, network));
        refresh();
      }
      await finish();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const reject = async (): Promise<void> => {
    if (busy || request === null) return;
    setBusy(true);
    setError(null);
    try {
      await rejectRequest(request.id);
      await finish();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
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
              {tx.data !== undefined && tx.data !== "0x" ? (
                <p className="w-code w-mono-break">{tx.data}</p>
              ) : null}
            </PanelBody>
          </Panel>
        ) : null}
        {request.kind === "sign" ? (
          <Panel title={t("apr.signTitle")}>
            <PanelBody>
              <p className="w-code w-mono-break">{readable(request.message ?? "")}</p>
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
              </Rows>
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
