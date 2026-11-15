import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, getAddress, type Hex } from "viem";
import { erc165Abi } from "../../abis";
import { nativeTokenFor } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { BUILTIN_NETWORKS, LITVM_NETWORK, networkIdentity } from "../../config/networks";
import { type MessageKey, t } from "../../core/i18n";
import {
  ERC721_INTERFACE_ID,
  INCREASE_ALLOWANCE_SELECTOR,
  nftFromProbe,
  parseApproveCall,
  rewriteApproveAmount,
} from "../../core/lib/approveAmount";
import { describeError } from "../../core/lib/errors";
import { formatAmount, formatFee, groupHex, parseAmount, shortenAddress } from "../../core/lib/format";
import { publicClientFor } from "../../core/rpc/client";
import {
  approvalView,
  claimPendingRequest,
  DAPP_MAYBE_SENT_ERROR,
  type DappRequest,
  listPending,
  type PendingClaimOutcome,
  rejectClaimedRequest,
  rejectRequest,
  releasePendingRequestClaim,
  resolveRequest,
  unclaimedNotice,
  watchPending,
} from "../../core/services/dapp";
import { executeDappRequest } from "../../core/services/dappExecution";
import { probeChainId } from "../../core/services/rpcProbe";
import { listTokens, lookupToken, type TokenMetadata } from "../../core/services/tokens";
import { previewRaw } from "../../core/services/tx";
import { workerAwaits } from "../../core/services/walletEvents";
import { Identicon } from "../components/Identicon";
import { Button, Icon, Note, Panel, PanelBody, Row, Rows } from "../components/kit";
import { requestRpcPermission } from "../components/RpcAccessPrompt";
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
import { normalizeDecimalInput } from "../lib/decimalInput";
import { siteMark } from "../lib/officialSite";
import { foldedImpersonation } from "../lib/tokenLabel";
import { readableSignMessage, readableTypedData, signMessageRisk, typedSummary } from "../lib/typedData";
import { useRoute } from "../router";
import { useWallet } from "../state/WalletContext";
import { releaseRpcPermissionUnlessUsed } from "./settings/rpcRelease";

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
  "watch-asset": "apr.watchAssetTitle",
  "add-network": "apr.addNetworkTitle",
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

/**
 * Where funds or rights go, in full: checksummed, in groups of four. A look-alike
 * address made to match a known head and tail differs in the middle, which a
 * shortened form hides on the one screen meant to catch it.
 */
function FullAddress({ address }: { address: string }): ReactNode {
  let shown = address;
  try {
    shown = getAddress(address);
  } catch {
    // Not an address viem can checksum: shown as given, still in full.
  }
  return <span className="w-approve-address">{groupHex(shown)}</span>;
}

/** The account that signs, with its picture so another account is seen at a glance. */
function SignerAddress({ signer }: { signer: Address | null }): ReactNode {
  if (signer === null) return "…";
  return (
    <span className="w-signer">
      <Identicon address={signer} size={14} />
      {shortenAddress(signer)}
    </span>
  );
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
          <Row label={t("send.recipient")} value={<FullAddress address={effect.to} />} />
          <Row label={t("common.amount")} value={amountText(effect.amount, metaOf(effect.token))} />
        </>
      );
    case "nft-transfer":
      return (
        <>
          <Row label={t("apr.from")} value={shortenAddress(effect.from, 10, 6)} />
          <Row label={t("send.recipient")} value={<FullAddress address={effect.to} />} />
          <Row label={t("apr.tokenId")} value={`#${effect.tokenId.toString()}`} />
        </>
      );
    case "approve": {
      const until = deadlineDate(effect.validUntil);
      return (
        <>
          <Row label={t("apr.spender")} value={<FullAddress address={effect.spender} />} />
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
          <Row label={t("apr.operator")} value={<FullAddress address={effect.operator} />} />
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

/** How long Approve stays disarmed after a request appears or the window is raised. */
const APPROVE_ARM_MS = 800;

/**
 * A plain-http page off this machine is shown with its scheme, so it cannot
 * pass for the https site of the same name; loopback is a developer's own box.
 */
/** Host with port of a proposed RPC or explorer; the full URL is shown beside it. */
function rpcHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function insecureOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol !== "https:"
      && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return true;
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
  // Claims this window kept on transactions it signed whose outcome is unknown:
  // a second Approve must not sign them again, and Reject must not call them rejected.
  const heldClaims = useRef(new Map<string, string>());
  // The request Approve or Reject is working on. Its claim reaches storage, and so
  // this window's queue, before claimPendingRequest returns; the window must keep
  // showing it meanwhile, not swap it out or close.
  const working = useRef<string | null>(null);

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
  // Rows another window claimed are not shown: the worker answers them.
  const ownsClaim = (id: string): boolean => working.current === id || heldClaims.current.has(id);
  const { request, actionable } = approvalView(queue ?? [], wanted, ownsClaim);
  const actionableCount = actionable.length;
  useEffect(() => {
    if (wanted !== null && queueError === null && queue !== null && actionableCount === 0) window.close();
  }, [queue, queueError, wanted, actionableCount]);

  // The window swaps in the next queued request in place, and the worker raises
  // it whenever a page asks again. Approve stays disarmed for a moment after
  // either, so a double click or a stray Enter meant for the previous request
  // (or for the page) cannot approve one the user has not seen.
  const [armedId, setArmedId] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const rearm = (): void => {
      if (document.visibilityState === "visible") setFocusTick((tick) => tick + 1);
    };
    window.addEventListener("focus", rearm);
    document.addEventListener("visibilitychange", rearm);
    return () => {
      window.removeEventListener("focus", rearm);
      document.removeEventListener("visibilitychange", rearm);
    };
  }, []);
  const requestId = request?.id ?? null;
  // Asking wakes a worker that died while the request was shown; its startup sweep
  // then answers the rows the dead one left, and the window follows the queue.
  useEffect(() => {
    if (requestId !== null) void workerAwaits(requestId);
  }, [requestId]);
  useEffect(() => {
    setArmedId(null);
    if (requestId === null) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    const timer = window.setTimeout(() => setArmedId(requestId), APPROVE_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [requestId, focusTick]);
  const armed = requestId !== null && armedId === requestId;
  // A hash or unreadable bytes are signed only once the user ticks that they
  // understand. The tick names the request it was given for, so the next request
  // in the queue starts unticked.
  const signRisk = request?.kind === "sign" ? signMessageRisk(request.message ?? "") : "text";
  const [riskAckId, setRiskAckId] = useState<string | null>(null);
  const riskBlocked = signRisk !== "text" && (requestId === null || riskAckId !== requestId);

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
  // What the dapp asked for. Lowering a spending cap changes an amount, never a
  // token, so the tokens to read come from here; everything shown and signed
  // below reads `signedData`.
  const requestedEffect = request === null
    ? null
    : tx !== null
      ? callEffect(tx.to, tx.data)
      : request.kind === "sign-typed"
        ? typedEffect(request.message ?? "")
        : null;
  // Past the cap a token shows raw units: `metaOf` answers null for it.
  const tokens = effectTokens(requestedEffect).slice(0, MAX_TOKEN_READS);
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

  // Spending cap: an exact ERC-20 approve or increaseAllowance may be signed with
  // a lower amount. The same selector is ERC-721's approve(to, tokenId), where
  // "lowering" would approve another NFT, so the editor needs readable decimals
  // AND a contract that says it is not an ERC-721.
  const requested = tx === null || tx.to === undefined ? null : parseApproveCall(tx.data);
  const capToken = requested !== null && requestedEffect?.kind === "approve" ? requestedEffect.grants[0]?.token : undefined;
  const capMeta: TokenMeta = capToken === undefined ? null : metaOf(capToken);
  const nftRead = useLiveRead(
    requested !== null && capToken !== undefined
      ? () => publicClientFor(network)
          .readContract({ address: capToken, abi: erc165Abi, functionName: "supportsInterface", args: [ERC721_INTERFACE_ID] })
          .then((answer) => ({ nft: nftFromProbe({ answer }) }), (error: unknown) => ({ nft: nftFromProbe({ error }) }))
      : null,
    [request?.id ?? "", network.id, network.rpcUrl, capToken ?? ""],
    { live: false },
  );
  const capReading = requested !== null && (capMeta === undefined || nftRead.data === null);
  const editable = requested !== null && capMeta != null && nftRead.data?.nft === false;
  const [cap, setCap] = useState<{ id: string; text: string } | null>(null);
  const capText = cap !== null && cap.id === request?.id ? cap.text : "";
  const capInput = editable ? normalizeDecimalInput(capText) : "";
  const capAmount = requested === null
    ? null
    : capInput === "" || capMeta == null ? requested.amount : parseAmount(capInput, capMeta.decimals);
  const capError = requested === null || capInput === "" || capMeta == null
    ? null
    : capAmount === null
      ? t("apr.capInvalid", { decimals: capMeta.decimals })
      : capAmount > requested.amount ? t("apr.capTooHigh") : null;
  // The bytes Approve signs: the dapp's own unless a valid lower cap was typed.
  const signedData: Hex | undefined = tx === null
    ? undefined
    : !editable || capInput === "" || capAmount === null || capError !== null
      ? tx.data
      : rewriteApproveAmount(tx.data, capAmount) ?? tx.data;
  const signedCall = parseApproveCall(signedData);
  const effect = tx !== null ? callEffect(tx.to, signedData) : requestedEffect;
  // In the token's units only where the editor is offered; otherwise the word
  // may be a token id, and it is shown as the raw integer it is.
  const capAmountText = (amount: bigint): string => {
    if (amount >= UNLIMITED) return t("apr.unlimited");
    if (capReading) return "…";
    if (!editable || capMeta == null) return t("apr.rawAmount", { value: amount.toString() });
    return t("common.amountWithSymbol", {
      amount: formatAmount(amount, capMeta.decimals, capMeta.decimals),
      symbol: capMeta.symbol,
    });
  };

  // wallet_watchAsset: everything shown is read from the contract on this
  // network; the page's own symbol and decimals appear only where they differ.
  const asset = request?.kind === "watch-asset" ? (request.asset ?? null) : null;
  const assetRead = useLiveRead(
    asset !== null
      ? () => Promise.all([
          lookupToken(asset.address, network).catch(() => null),
          listTokens(network).catch(() => []),
        ])
      : null,
    [request?.id ?? "", network.id, network.rpcUrl, asset?.address ?? ""],
    { live: false },
  );
  const assetMeta: TokenMeta = asset === null ? null : assetRead.data === null ? undefined : assetRead.data[0];
  const assetAdded = asset !== null && assetRead.data !== null && assetRead.data[1].some(
    (token) => token.address?.toLowerCase() === asset.address,
  );
  const assetClaimDiffers = asset !== null && assetMeta != null && (
    (asset.symbol !== undefined && asset.symbol !== assetMeta.symbol)
    || (asset.decimals !== undefined && asset.decimals !== assetMeta.decimals)
  );
  const assetImpersonates = assetMeta != null && foldedImpersonation(assetMeta.symbol, assetMeta.name);
  const assetBlocked = request?.kind === "watch-asset" && (
    asset === null
    || assetMeta == null
    || (assetImpersonates && !assetAdded && (requestId === null || riskAckId !== requestId))
  );

  // wallet_addEthereumChain: the wallet asks the proposed RPC itself, from this
  // window only while the request is shown, and Approve waits for a match.
  const chain = request?.kind === "add-network" ? (request.chain ?? null) : null;
  const probe = useLiveRead(
    chain !== null ? () => probeChainId(chain.rpcUrl).then((got) => ({ got })) : null,
    [request?.id ?? "", chain?.rpcUrl ?? ""],
    { live: false },
  );
  const probeState: "checking" | "verified" | "mismatch" | "unreachable" = probe.data === null
    ? "checking"
    : probe.data.got === null
      ? "unreachable"
      : chain !== null && probe.data.got === BigInt(chain.chainId) ? "verified" : "mismatch";
  const chainBlocked = request?.kind === "add-network" && (chain === null || probeState !== "verified");
  // The request this window asked a host permission for, so Reject or a failed
  // approve can give back a grant no saved network uses.
  const permissionAskedFor = useRef<string | null>(null);
  const releaseAskedPermission = async (current: DappRequest): Promise<void> => {
    if (current.kind !== "add-network" || !current.chain || permissionAskedFor.current !== current.id) return;
    permissionAskedFor.current = null;
    await releaseRpcPermissionUnlessUsed(current.chain.rpcUrl).catch(() => undefined);
  };
  const checkAgain = (): void => {
    if (chain === null || request === null) return;
    // In the click, before any await: Chrome asks only from a user gesture.
    const asked = requestRpcPermission(chain.rpcUrl);
    permissionAskedFor.current = request.id;
    void asked.finally(() => probe.reload());
  };

  const preview = useLiveRead(
    tx !== null && signer !== null
      ? () =>
          previewRaw({
            from: signer,
            to: tx.to,
            value: quantity(tx.value),
            data: signedData,
            gas: quantity(tx.gas),
          })
      : null,
    [
      request?.id ?? "",
      signer ?? "",
      tx?.to ?? "",
      tx?.value ?? "",
      signedData ?? "",
      tx?.gas ?? "",
    ],
    { live: false },
  );

  /** The window exists for the queue; when the queue is empty it should go. */
  const finish = async (): Promise<void> => {
    const rest = await listPending();
    if (wanted !== null && approvalView(rest, wanted, ownsClaim).actionable.length === 0) window.close();
  };
  /** No claim: say why and follow the queue; the queue effect closes an empty window. */
  const unclaimed = async (
    current: DappRequest,
    reason: Extract<PendingClaimOutcome, { reason: unknown }>["reason"],
  ): Promise<void> => {
    const { notice, rejectExpired } = unclaimedNotice(
      reason,
      current.kind === "transaction" && heldClaims.current.has(current.id),
    );
    if (rejectExpired) await rejectRequest(current.id, "Request expired").catch(() => undefined);
    await moveOn(current.id, t(notice));
  };
  /**
   * Shows `text` and follows the queue. Under the request it is about while that
   * request is still shown; once it is gone the next one takes its place, so the
   * text goes to a toast instead of reading as a verdict on the new request.
   */
  const moveOn = async (id: string, text: string): Promise<void> => {
    const rest = await listPending();
    if (rest.some((entry) => entry.id === id)) setError(text);
    else notify(text, "info");
    setQueue(rest);
  };
  const approve = async (): Promise<void> => {
    if (
      busy
      || request === null
      || !armed
      || signer === null
      || mismatch
      || networkMismatch
      || riskBlocked
      || assetBlocked
      || chainBlocked
      || capError !== null
      || !actionGate.tryEnter()
    ) return;
    // The bytes on screen when Approve was pressed, before anything awaits.
    const data = signedData;
    // Before any await: Chrome grants a host permission only inside the click.
    const rpcGranted = request.kind === "add-network" && request.chain
      ? requestRpcPermission(request.chain.rpcUrl)
      : null;
    if (rpcGranted !== null) permissionAskedFor.current = request.id;
    working.current = request.id;
    setBusy(true);
    setError(null);
    let approvalClaim: string | null = null;
    let executionCompleted = false;
    let signed = false;
    try {
      if (rpcGranted !== null && !(await rpcGranted)) {
        setError(t("set.networkPermission"));
        return;
      }
      // A row whose worker no longer waits has no page to answer: its dapp already
      // saw 4900, so approving it would sign for no one. A claimed row may be out
      // already and is left alone; the claim attempt below reports it.
      if (
        request.approvalClaim === undefined
        && !heldClaims.current.has(request.id)
        && !(await workerAwaits(request.id))
      ) {
        await rejectRequest(request.id, "Request expired").catch(() => undefined);
        await moveOn(request.id, t("apr.expired"));
        return;
      }
      const outcome = await claimPendingRequest(request.id);
      if (!("claim" in outcome)) {
        await unclaimed(request, outcome.reason);
        return;
      }
      approvalClaim = outcome.claim;
      const result = await executeDappRequest(
        request, signer, hostOf(request.origin), network, approvalClaim,
        () => { signed = true; },
        request.kind === "watch-asset" ? (assetMeta ?? undefined) : undefined,
        request.kind === "transaction" ? { data } : undefined,
      );
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
      // A signature keeps its claim but no window holds it, so the row leaves this
      // window's view: the error goes to a toast rather than onto the next request.
      if (signed && request.kind !== "transaction") notify(describeError(cause), "error");
      else setError(describeError(cause));
      if (!executionCompleted) await releaseAskedPermission(request);
    } finally {
      // Nothing was signed, so the same request may be approved or rejected again.
      // Once signed the claim is kept: the transaction may be out, and signing the
      // same intent a second time would send it twice.
      if (approvalClaim !== null && !executionCompleted && !signed) {
        await releasePendingRequestClaim(request.id, approvalClaim).catch(() => undefined);
      } else if (approvalClaim !== null && request.kind === "transaction" && signed) {
        heldClaims.current.set(request.id, approvalClaim);
      }
      working.current = null;
      actionGate.leave();
      setBusy(false);
    }
  };

  const reject = async (): Promise<void> => {
    if (busy || request === null || !actionGate.tryEnter()) return;
    working.current = request.id;
    setBusy(true);
    setError(null);
    let approvalClaim: string | null = null;
    let settled = false;
    try {
      // A transaction this window signed may be out: its dapp is told so, never
      // "rejected", and the window moves on to the next request.
      const held = request.kind === "transaction" ? heldClaims.current.get(request.id) : undefined;
      if (held !== undefined) {
        await rejectClaimedRequest(request.id, held, DAPP_MAYBE_SENT_ERROR, -32603);
        heldClaims.current.delete(request.id);
        await moveOn(request.id, t("apr.maybeSent"));
        return;
      }
      const outcome = await claimPendingRequest(request.id);
      if (!("claim" in outcome)) {
        await unclaimed(request, outcome.reason);
        return;
      }
      approvalClaim = outcome.claim;
      settled = await rejectClaimedRequest(request.id, approvalClaim);
      await releaseAskedPermission(request);
      if (!settled) {
        setQueue(await listPending());
        return;
      }
      await finish();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      if (approvalClaim !== null && !settled) {
        await releasePendingRequestClaim(request.id, approvalClaim).catch(() => undefined);
      }
      working.current = null;
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
  const insecure = insecureOrigin(request.origin);
  // From the browser-reported origin only: the page title is the page's own text.
  const mark = siteMark(request.origin);
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
    <Screen title={t(KIND_TITLE[request.kind])} bare>
      <div className="w-flow w-approve-flow" aria-busy={busy}>
        <div className="w-flow-main">
          <div className="w-approve-bar">
            <img className="w-approve-mark" src="./icons/icon-128.png" alt="" width={20} height={20} />
            <div
              className="w-approve-origin"
              data-insecure={insecure ? "true" : undefined}
              data-lookalike={mark === "lookalike" ? "true" : undefined}
            >
              <span className="w-asset-symbol">
                {insecure ? request.origin : host}
                {mark === "official" ? (
                  <span className="w-approve-official">
                    <Icon name="check" size={10} />
                    {t("apr.official")}
                  </span>
                ) : null}
              </span>
              <span className="w-asset-sub">{request.title ?? request.origin}</span>
            </div>
            {actionable.length > 1 ? (
              <p className="w-queue">{t("apr.queueMore", { count: actionable.length - 1 })}</p>
            ) : null}
          </div>
          <h1 className="w-approve-title">{t(KIND_TITLE[request.kind])}</h1>
          {mark === "lookalike" ? (
            <div role="alert">
              <Note tone="error">{t("apr.lookalike")}</Note>
            </div>
          ) : null}
        {request.kind === "connect" ? (
          <Panel title={t("apr.connectTitle")}>
            <PanelBody>
              <Rows>
                <Row
                  label={t("apr.seeAddress")}
                  value={<SignerAddress signer={signer} />}
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
        {request.kind === "watch-asset" ? (
          <Panel title={t("apr.watchAssetTitle")}>
            <PanelBody>
              <Rows>
                <Row
                  label={t("apr.watchAssetContract")}
                  value={asset === null ? t("apr.unreadableValue") : <FullAddress address={asset.address} />}
                />
                <Row label={t("tok.symbol")} value={assetMeta === undefined ? "…" : (assetMeta?.symbol ?? "—")} />
                <Row label={t("tok.name")} value={assetMeta === undefined ? "…" : (assetMeta?.name ?? "—")} />
                <Row
                  label={t("tok.decimals")}
                  value={assetMeta === undefined ? "…" : (assetMeta?.decimals.toString() ?? "—")}
                />
                {assetClaimDiffers && asset !== null ? (
                  <Row
                    label={t("apr.watchAssetClaimed")}
                    value={<code className="w-code">{`${asset.symbol ?? "—"} · ${asset.decimals ?? "—"}`}</code>}
                    tone="red"
                  />
                ) : null}
              </Rows>
              {assetClaimDiffers ? <Note tone="warn">{t("apr.watchAssetMismatch")}</Note> : null}
              {assetMeta === null ? <Note tone="error">{t("apr.watchAssetUnreadable")}</Note> : null}
              {assetAdded ? <Note>{t("apr.watchAssetAlready")}</Note> : null}
              {assetImpersonates && assetMeta != null && !assetAdded ? (
                <>
                  <div className="w-approve-risk">
                    <Note tone="error">{t("tok.notOfficialWarn", { symbol: assetMeta.symbol })}</Note>
                  </div>
                  <label className="w-check-row w-approve-ack">
                    <input
                      className="w-check"
                      type="checkbox"
                      checked={riskAckId === request.id}
                      disabled={busy}
                      onChange={(event) => setRiskAckId(event.target.checked ? request.id : null)}
                    />
                    <span className="w-hint">{t("apr.watchAssetAck")}</span>
                  </label>
                </>
              ) : null}
            </PanelBody>
          </Panel>
        ) : null}
        {request.kind === "add-network" ? (
          <Panel title={t("apr.addNetworkTitle")}>
            <PanelBody>
              {chain === null ? (
                <Note tone="error">{t("apr.unreadable")}</Note>
              ) : (
                <>
                  <Rows>
                    <Row
                      label={t("apr.addNetworkChainId")}
                      value={`${chain.chainId} (0x${chain.chainId.toString(16)})`}
                    />
                    <Row label={t("set.networkName")} value={chain.name} />
                    <Row
                      label={t("apr.addNetworkCurrency")}
                      value={`${chain.symbol} · ${chain.currencyName} · ${chain.decimals}`}
                    />
                    <Row
                      label={t("set.rpcUrl")}
                      value={<span className="w-asset-symbol">{rpcHostOf(chain.rpcUrl)}</span>}
                    />
                    <Row
                      label={t("apr.addNetworkExplorer")}
                      value={chain.explorerUrl === "" ? t("apr.addNetworkNoExplorer") : rpcHostOf(chain.explorerUrl)}
                    />
                    {probeState === "verified" ? (
                      <Row
                        label={t("apr.addNetworkCheck")}
                        value={t("apr.addNetworkVerified", { chainId: chain.chainId })}
                        tone="green"
                      />
                    ) : null}
                  </Rows>
                  {/* Path and query can carry an API key or a route: shown in full. */}
                  <p className="w-code w-mono-break">{chain.rpcUrl}</p>
                  {probeState === "checking" ? <Note>{t("apr.addNetworkChecking")}</Note> : null}
                  {probeState === "mismatch" ? (
                    <Note tone="error">
                      {t("apr.addNetworkMismatch", { got: probe.data?.got?.toString() ?? "—" })}
                    </Note>
                  ) : null}
                  {probeState === "unreachable" ? (
                    <>
                      <Note tone="warn">{t("apr.addNetworkUnreachable")}</Note>
                      <Button size="sm" disabled={busy || probe.busy} onClick={checkAgain}>
                        {t("apr.addNetworkRetry")}
                      </Button>
                    </>
                  ) : null}
                  <Note tone="warn">{t("set.customNetworkNote")}</Note>
                  <Note>{t("apr.addNetworkNoSwitch")}</Note>
                </>
              )}
            </PanelBody>
          </Panel>
        ) : null}
        {tx !== null ? (
          <>
            <Panel title={t("apr.txTitle")}>
              <PanelBody>
                <Rows>
                  <Row
                    label={t("apr.signer")}
                    value={<SignerAddress signer={signer} />}
                  />
                  <Row
                    label={t("apr.sendTo")}
                    value={tx.to === undefined ? t("apr.deploy") : <FullAddress address={tx.to} />}
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
                </Rows>
              </PanelBody>
            </Panel>
            {/* An ERC-721 approve names one token id, not a spending cap: a hashed
                id would read as "Unlimited" here. */}
            {requested !== null && nftRead.data?.nft !== true ? (
              <Panel title={t("apr.capTitle")}>
                <PanelBody>
                  <Rows>
                    <Row
                      label={t("apr.capRequested")}
                      value={capAmountText(requested.amount)}
                      tone={requested.amount >= UNLIMITED ? "red" : undefined}
                    />
                    <Row
                      label={t(requested.selector === INCREASE_ALLOWANCE_SELECTOR ? "apr.capAddedChosen" : "apr.capChosen")}
                      value={capAmountText(signedCall?.amount ?? requested.amount)}
                      tone={(signedCall?.amount ?? requested.amount) >= UNLIMITED ? "red" : undefined}
                    />
                  </Rows>
                  {editable ? (
                    <>
                      <label className="w-field">
                        <span className="w-label">{t("apr.capInput")}</span>
                        <input
                          className="w-input"
                          inputMode="decimal"
                          value={capText}
                          readOnly={busy}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={requested.amount >= UNLIMITED || capMeta == null
                            ? t("apr.capPlaceholder")
                            : formatAmount(requested.amount, capMeta.decimals, capMeta.decimals)}
                          aria-invalid={capError !== null}
                          onChange={(event) => setCap({ id: request.id, text: event.target.value })}
                        />
                      </label>
                      {capError !== null ? (
                        <div role="alert">
                          <Note tone="error">{capError}</Note>
                        </div>
                      ) : (
                        <Note>{t("apr.capHint")}</Note>
                      )}
                      {capText !== "" ? (
                        <Button size="sm" disabled={busy} onClick={() => setCap(null)}>
                          {t("apr.capReset")}
                        </Button>
                      ) : null}
                    </>
                  ) : capReading ? null : (
                    <Note>{t("apr.capLocked")}</Note>
                  )}
                </PanelBody>
              </Panel>
            ) : null}
            {/* The grant warning sits between what is signed and what it costs. */}
            {grantNote !== null ? (
              <div className="w-approve-risk">
                <Note tone="warn">{t(grantNote)}</Note>
              </div>
            ) : null}
            {/* The fee as its own two-column card: gas limit left, max fee right. */}
            <dl className="w-approve-fee">
              <div>
                <dt>{t("apr.gas")}</dt>
                <dd>{(preview.data?.gas ?? gasGiven)?.toString() ?? "…"}</dd>
              </div>
              <div>
                <dt>{t("apr.maxFee")}</dt>
                <dd>
                  {preview.data?.feeWei === undefined || preview.data.feeWei === null
                    ? "…"
                    : t("common.amountWithSymbol", {
                        amount: formatFee(preview.data.feeWei, nativeToken.decimals),
                        symbol: nativeToken.symbol,
                      })}
                </dd>
              </div>
            </dl>
            {signedData !== undefined && signedData !== "0x" ? (
              <p className="w-code w-mono-break w-approve-raw">{signedData}</p>
            ) : null}
          </>
        ) : null}
        {request.kind === "sign" ? (
          <Panel title={t("apr.signTitle")}>
            <PanelBody>
              <p className="w-code w-mono-break">{readableSignMessage(request.message ?? "")}</p>
              {signRisk === "text" ? (
                <Note>{t("apr.signNote")}</Note>
              ) : (
                <>
                  <div className="w-approve-risk">
                    <Note tone="error">{t(signRisk === "hash" ? "apr.signHashWarn" : "apr.signBinaryWarn")}</Note>
                  </div>
                  <label className="w-check-row w-approve-ack">
                    <input
                      className="w-check"
                      type="checkbox"
                      checked={riskAckId === request.id}
                      disabled={busy}
                      onChange={(event) => setRiskAckId(event.target.checked ? request.id : null)}
                    />
                    <span className="w-hint">{t("apr.signRiskAck")}</span>
                  </label>
                </>
              )}
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
              <p className="w-code w-mono-break">{readableTypedData(request.message ?? "")}</p>
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
                busy || !armed || signer === null || mismatch || networkMismatch || unreadable || wrongChain
                || riskBlocked || assetBlocked || chainBlocked || capError !== null
              }
              onClick={() => void approve()}
            >
              {busy
                ? t("apr.working")
                : request.kind === "connect"
                  ? t("apr.connect")
                  : request.kind === "switch-network"
                    ? t("apr.switchNetwork")
                  : request.kind === "watch-asset"
                    ? t(assetAdded ? "common.done" : "apr.watchAssetAdd")
                  : request.kind === "add-network"
                    ? t("apr.addNetworkAdd")
                  : t("apr.sign")}
            </Button>
          </div>
          <Note>{t("apr.footer", { chainId: network.chainId, host })}</Note>
        </div>
      </div>
    </Screen>
  );
}
