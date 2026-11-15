import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatUnits, getAddress, type Hex } from "viem";
import { nativeTokenFor } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { chainScope } from "../../config/networks";
import { t } from "../../core/i18n";
import { BroadcastUnknownError, describeError } from "../../core/lib/errors";
import { formatAmount, formatBalance, formatFee, groupHex, parseAmount } from "../../core/lib/format";
import type { TxKind } from "../../core/services/history";
import { loadPortfolio, rowBalance, rowReadError } from "../../core/services/portfolio";
import { quoteSend, sendToken, validateRecipient } from "../../core/services/transfer";
import { AmountField } from "../components/AmountField";
import { Button, Note, Panel, Row, Rows } from "../components/kit";
import { RecentRecipients, RecipientWarning } from "../components/RecipientHints";
import { Screen } from "../components/Screen";
import { TokenLogo } from "../components/TokenLogo";
import { TokenSelect } from "../components/TokenSelect";
import { TransactionReview } from "../components/TransactionReview";
import { useActionGate } from "../hooks/useActionGate";
import { useBroadcastHold } from "../hooks/useBroadcastHold";
import { useLiveRead } from "../hooks/useLiveRead";
import { useRecipients } from "../hooks/useRecipients";
import { recipientName, recipientRisk, rememberRecipient } from "../lib/recipients";
import { reviewKey } from "../lib/reviewKey";
import { clearSendDraft, loadSendDraft, saveSendDraft } from "../lib/sendDraft";
import { sendLimits, sendMax } from "../lib/sendLimits";
import { sendTotalLines } from "../lib/sendTotal";
import { goHome, useRoute } from "../router";
import { useWallet } from "../state/WalletContext";
import { SendNft } from "./send/SendNft";

/** History kinds a Send confirm writes; a pending one holds a reopened screen. */
const SEND_KINDS: readonly TxKind[] = ["send"];

/**
 * Sending. `?token=<id>` preselects the asset — that is what a tap on the HOME
 * list sends — and `?nft=<tokenId>` hands the whole screen to the NFT form
 * instead: one route, because the user made the same gesture either way.
 */
export function Send(): ReactNode {
  const route = useRoute();
  const nft = route.params.get("nft");
  const collection = route.params.get("collection");
  if (nft !== null) return <SendNft key={`nft:${collection ?? "classic"}:${nft}`} tokenId={nft} collection={collection} />;
  const initial = route.params.get("token");
  return <SendToken key={`token:${initial ?? "native"}`} initial={initial} />;
}

function SendToken({ initial }: { initial: string | null }): ReactNode {
  const { address, accounts, network, tokens, notify, refresh, tick } = useWallet();
  const nativeToken = nativeTokenFor(network);
  const [tokenId, setTokenId] = useState(initial ?? nativeToken.id);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  // The draft is written only after the user typed here, so opening Send (or
  // arriving from a Home row) never overwrites a saved draft with an empty form.
  const edited = useRef(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const known = useRecipients(address, network);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewFeeWei, setReviewFeeWei] = useState<bigint | null>(null);
  const [reviewIdentity, setReviewIdentity] = useState<string | null>(null);
  // Set when MAX filled the gas coin before a fee was quoted; the first quote
  // then brings MAX down to "balance - 2 x fee" once.
  const [maxRefine, setMaxRefine] = useState(false);
  const confirmGate = useActionGate();
  const broadcast = useBroadcastHold(address, network, SEND_KINDS);
  // Balances come from the same portfolio read HOME uses, so the number on the
  // row the user tapped and the number here are the same number.
  const read = useLiveRead(
    address ? () => loadPortfolio(address, tokens) : null,
    [address, network.id, network.rpcUrl, tokens, tick],
    { identity: [address, network.id, network.rpcUrl, tokens] },
  );
  const token = tokens.find((entry) => entry.id === tokenId) ?? nativeToken;
  const native = token.address === undefined;
  const balance = rowBalance(read.data?.rows, token.id);
  const nativeBalance = rowBalance(read.data?.rows, nativeToken.id);
  const readError = read.error ?? rowReadError(read.data?.rows, token.id);

  const recipient = validateRecipient(to);
  const parsed = parseAmount(amount, token.decimals);
  const over = sendLimits({ native, parsed, balance, nativeBalance, feeWei: null }).over;
  const self = recipient !== null
    && address !== null
    && recipient.toLowerCase() === address.toLowerCase();
  // The wallet's own accounts count as known recipients.
  const risk = recipient !== null && !self && known !== null
    ? recipientRisk(recipient, [...known.map((entry) => entry.address), ...accounts.map((entry) => entry.address)])
    : null;

  const job = address !== null
    && recipient !== null
    && parsed !== null
    && parsed > 0n
    && balance !== null
    && !over
    ? { from: address, to: recipient, token, amount: parsed }
    : null;

  // The fee is quoted once per edit, not once per block: an estimate that moves
  // under the user's finger while they read it is worse than a slightly old one.
  const quote = useLiveRead(job === null ? null : () => quoteSend(job), [
    address,
    to,
    token.id,
    token.address ?? "native",
    token.decimals,
    amount,
    job !== null,
    network.id,
    network.rpcUrl,
  ], { live: false, debounceMs: 180 });
  const feeWei = quote.data?.feeWei ?? null;
  const { shortOnGas } = sendLimits({ native, parsed, balance, nativeBalance, feeWei });
  const amountInvalid = amount.length > 0 && (parsed === null || parsed <= 0n || over);
  const loading = read.loading || quote.loading;
  const currentReviewIdentity = reviewKey([
    address,
    network.id,
    network.rpcUrl,
    tokenId,
    token.id,
    token.address,
    token.decimals,
    to,
    recipient,
    amount,
    parsed,
  ]);
  const reviewCurrent = reviewIdentity === currentReviewIdentity;

  useEffect(() => {
    setReviewOpen(false);
    setReviewFeeWei(null);
    setReviewIdentity(null);
  }, [address, amount, network.id, network.rpcUrl, to, tokenId, token.address, token.decimals]);

  // A draft is offered back only on a plain Send: a tap on a Home row asked for
  // that token. Once per account and network, and never over what was typed.
  useEffect(() => {
    if (initial !== null || address === null) return undefined;
    let alive = true;
    void loadSendDraft(address, network.id).then((draft) => {
      if (!alive || draft === null || edited.current) return;
      if (draft.tokenId !== nativeToken.id && !tokens.some((entry) => entry.id === draft.tokenId)) return;
      setTokenId(draft.tokenId);
      setTo(draft.to);
      setAmount(draft.amount);
      setDraftRestored(true);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [initial, address, network.id]);

  useEffect(() => {
    if (!edited.current || address === null) return;
    void saveSendDraft({ account: address, networkId: network.id, tokenId, to, amount }).catch(() => undefined);
  }, [address, network.id, tokenId, to, amount]);

  const markEdited = (): void => {
    edited.current = true;
    setDraftRestored(false);
  };

  const clearDraft = (): void => {
    edited.current = false;
    setDraftRestored(false);
    setTo("");
    setAmount("");
    setMaxRefine(false);
    void clearSendDraft().catch(() => undefined);
  };

  const fillMax = (): void => {
    if (balance === null) return;
    markEdited();
    // MAX on the gas coin leaves twice the quoted fee behind, otherwise the
    // transaction that spends "everything" is the one that cannot pay for itself.
    const max = sendMax(balance, native, token.decimals, feeWei);
    setMaxRefine(max.refine);
    setAmount(formatUnits(max.amount, token.decimals));
  };

  useEffect(() => {
    if (!maxRefine || !native || balance === null || feeWei === null) return;
    setMaxRefine(false);
    setAmount(formatUnits(sendMax(balance, native, token.decimals, feeWei).amount, token.decimals));
  }, [maxRefine, native, balance, feeWei, token.decimals]);

  const submit = (): void => {
    if (busy || job === null || shortOnGas || quote.loading || quote.data === null) return;
    setError(null);
    setReviewFeeWei(quote.data.feeWei);
    setReviewIdentity(currentReviewIdentity);
    setReviewOpen(true);
  };

  const confirm = async (): Promise<void> => {
    if (
      busy
      || !reviewOpen
      || !reviewCurrent
      || job === null
      || shortOnGas
      || reviewFeeWei === null
      || broadcast.held
      || !confirmGate.tryEnter()
    ) return;
    const submittedJob = job;
    const submittedNetwork = network;
    setBusy(true);
    setError(null);
    // Also run when a held broadcast is later found mined: the job went through.
    const sent = (hash: Hex): void => {
      notify(
        t("send.toast", {
          amount: formatAmount(submittedJob.amount, submittedJob.token.decimals),
          symbol: submittedJob.token.symbol,
        }),
        "ok",
        txUrl(hash, submittedNetwork),
      );
      void rememberRecipient(submittedJob.from, chainScope(submittedNetwork.id), submittedJob.to)
        .catch(() => undefined);
      edited.current = false;
      void clearSendDraft().catch(() => undefined);
      setError(null);
      setAmount("");
      setTo("");
      setReviewOpen(false);
      setReviewIdentity(null);
      refresh();
      goHome();
    };
    try {
      sent(await sendToken(submittedJob));
    } catch (cause) {
      // The node may hold it: keep the form, hold Confirm, link the hash.
      if (cause instanceof BroadcastUnknownError) {
        broadcast.hold(cause.hash, sent);
        // A reopened Send must not offer the same job back for a second tap.
        edited.current = false;
        void clearSendDraft().catch(() => undefined);
        notify(describeError(cause), "error", txUrl(cause.hash, submittedNetwork));
      }
      setError(describeError(cause));
    } finally {
      confirmGate.leave();
      setBusy(false);
    }
  };
  return (
    <Screen title={t("send.title")} onBack={goHome}>
      <form
        className="w-flow w-send-flow"
        aria-busy={busy || loading}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="w-flow-main">
          {draftRestored ? (
            <div className="w-draft" role="status">
              <Note>{t("send.draftRestored")}</Note>
              <Button type="button" size="sm" disabled={busy} onClick={clearDraft}>
                {t("hist.clear")}
              </Button>
            </div>
          ) : null}
          {/* The balance rides on the asset row, as in the suite's send screen. */}
          <TokenSelect
            label={t("send.asset")}
            tokens={tokens}
            value={token}
            disabled={busy}
            meta={
              balance === null
                ? t("send.readingBalance")
                : t("send.balanceHint", {
                  amount: formatBalance(balance, token.decimals),
                  symbol: token.symbol,
                })
            }
            onChange={(next) => {
              markEdited();
              setTokenId(next.id);
              setMaxRefine(false);
              setAmount("");
              setError(null);
            }}
          />

          <label className="w-field">
            <span className="w-label">{t("send.recipient")}</span>
            <input
              className="w-input"
              value={to}
              placeholder="0x…"
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              aria-label={t("send.recipient")}
              aria-invalid={to.length > 0 && recipient === null}
              onChange={(event) => {
                markEdited();
                setTo(event.target.value);
                setError(null);
              }}
            />
          </label>
          {to.length === 0 ? (
            <RecentRecipients
              known={known}
              disabled={busy}
              onPick={(picked) => {
                markEdited();
                setTo(picked);
                setError(null);
              }}
            />
          ) : null}

          {to.length > 0 && recipient === null ? (
            <Note tone="error">{t("send.badAddress")}</Note>
          ) : null}
          {self ? <Note tone="warn">{t("send.selfAddress")}</Note> : null}
          <RecipientWarning risk={risk} />

          <AmountField
            label={t("common.amount")}
            value={amount}
            invalid={amountInvalid}
            disabled={busy}
            onChange={(next) => {
              markEdited();
              setMaxRefine(false);
              setAmount(next);
              setError(null);
            }}
            symbol={(
              <>
                <TokenLogo token={token} size={16} />
                {token.symbol}
              </>
            )}
            onMax={balance === null ? undefined : fillMax}
          />
          {over ? <Note tone="error">{t("send.overBalance")}</Note> : null}
          {readError !== null ? <Note tone="error">{readError}</Note> : null}
          {feeWei !== null ? (
            <Panel>
              <Rows>
                <Row
                  label={t("send.gasFee")}
                  value={`${formatFee(feeWei, nativeToken.decimals)} ${nativeToken.symbol}`}
                />
              </Rows>
            </Panel>
          ) : null}
          {shortOnGas && feeWei !== null ? (
            <Note tone="warn">
              {t("send.feeShort", {
                fee: formatFee(feeWei, nativeToken.decimals),
                symbol: nativeToken.symbol,
              })}
            </Note>
          ) : null}
          {quote.error !== null ? <Note tone="warn">{quote.error}</Note> : null}
        </div>
        <div className="w-flow-actions">
          {error !== null ? <Note tone="error">{error}</Note> : null}
          <Button
            type="submit"
            variant="primary"
            block
            disabled={busy || job === null || shortOnGas || quote.loading || quote.data === null}
          >
            {busy ? t("send.sending") : loading ? t("common.working") : t("send.submit")}
          </Button>
        </div>
      </form>
      {reviewOpen && reviewCurrent && job !== null && reviewFeeWei !== null ? (
        <TransactionReview
          title={t("apr.titleTx")}
          armKey={currentReviewIdentity}
          busy={busy}
          ready={!shortOnGas && reviewCurrent && !broadcast.held}
          onClose={() => setReviewOpen(false)}
          onConfirm={() => void confirm()}
          error={error}
        >
          <div className="w-summary">
            <span className="w-summary-label">{t("send.asset")}</span>
            <span className="w-summary-value">
              {formatAmount(job.amount, token.decimals, 6)} {token.symbol}
            </span>
          </div>
          <Panel>
            <Rows>
              <Row
                label={t("send.recipient")}
                value={<span className="w-review-address">{groupHex(getAddress(job.to))}</span>}
              />
              {recipientName(known, job.to) !== null ? (
                <Row label={t("send.savedAs")} value={recipientName(known, job.to)} />
              ) : null}
              <Row
                label={t("send.gasFee")}
                value={`${formatFee(reviewFeeWei, nativeToken.decimals)} ${nativeToken.symbol}`}
              />
              <Row
                label={t("send.total")}
                value={(
                  <span className="w-review-total">
                    {sendTotalLines({
                      native,
                      amount: job.amount,
                      feeWei: reviewFeeWei,
                      decimals: token.decimals,
                      symbol: token.symbol,
                      nativeDecimals: nativeToken.decimals,
                      nativeSymbol: nativeToken.symbol,
                    }).map((line) => <span key={line}>{line}</span>)}
                  </span>
                )}
              />
              <Row label={t("common.network")} value={network.name} />
            </Rows>
          </Panel>
          <RecipientWarning risk={risk} />
        </TransactionReview>
      ) : null}
    </Screen>
  );
}
