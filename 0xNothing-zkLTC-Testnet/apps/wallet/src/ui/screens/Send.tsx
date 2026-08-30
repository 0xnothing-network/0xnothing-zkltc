import { type ReactNode, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { nativeTokenFor } from "../../config/assets";
import { txUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { formatAmount, formatBalance, parseAmount, shortenAddress } from "../../core/lib/format";
import { NATIVE_GAS_RESERVE_WEI, spendableForSwap } from "../../core/lib/swapMath";
import { loadPortfolio } from "../../core/services/portfolio";
import { quoteSend, sendToken, validateRecipient } from "../../core/services/transfer";
import { AmountField } from "../components/AmountField";
import { Button, Note, Panel, Row, Rows } from "../components/kit";
import { Screen } from "../components/Screen";
import { TokenSelect } from "../components/TokenSelect";
import { TransactionReview } from "../components/TransactionReview";
import { useActionGate } from "../hooks/useActionGate";
import { useLiveRead } from "../hooks/useLiveRead";
import { reviewKey } from "../lib/reviewKey";
import { goHome, useRoute } from "../router";
import { useWallet } from "../state/WalletContext";
import { SendNft } from "./send/SendNft";

/**
 * Sending. `?token=<id>` preselects the asset — that is what a tap on the HOME
 * list sends — and `?nft=<tokenId>` hands the whole screen to the NFT form
 * instead: one route, because the user made the same gesture either way.
 */
export function Send(): ReactNode {
  const route = useRoute();
  const nft = route.params.get("nft");
  if (nft !== null) return <SendNft key={`nft:${nft}`} tokenId={nft} />;
  const initial = route.params.get("token");
  return <SendToken key={`token:${initial ?? "native"}`} initial={initial} />;
}

function SendToken({ initial }: { initial: string | null }): ReactNode {
  const { address, network, tokens, notify, refresh, tick } = useWallet();
  const nativeToken = nativeTokenFor(network);
  const [tokenId, setTokenId] = useState(initial ?? nativeToken.id);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewFeeWei, setReviewFeeWei] = useState<bigint | null>(null);
  const [reviewIdentity, setReviewIdentity] = useState<string | null>(null);
  const confirmGate = useActionGate();
  // Balances come from the same portfolio read HOME uses, so the number on the
  // row the user tapped and the number here are the same number.
  const read = useLiveRead(
    address ? () => loadPortfolio(address, tokens) : null,
    [address, network.id, network.rpcUrl, tokens, tick],
    { identity: [address, network.id, network.rpcUrl, tokens] },
  );
  const token = tokens.find((entry) => entry.id === tokenId) ?? nativeToken;
  const native = token.address === undefined;
  const balance = read.data?.rows.find((row) => row.token.id === token.id)?.balance ?? null;
  const nativeBalance = read.data?.rows.find((row) => row.token.id === nativeToken.id)?.balance
    ?? null;

  const recipient = validateRecipient(to);
  const parsed = parseAmount(amount, token.decimals);
  const spendable = balance === null ? null : spendableForSwap(balance, native);
  const over = parsed !== null && spendable !== null && parsed > spendable;
  const reserveBlocked = native
    && parsed !== null
    && parsed > 0n
    && balance !== null
    && parsed <= balance
    && over;
  const self = recipient !== null
    && address !== null
    && recipient.toLowerCase() === address.toLowerCase();

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
  const shortOnGas = feeWei !== null
    && nativeBalance !== null
    && (
      native
        ? parsed !== null && parsed + feeWei > nativeBalance
        : feeWei > nativeBalance
    );
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

  const fillMax = (): void => {
    if (balance === null) return;
    // MAX on the gas coin leaves the reserve behind, otherwise the transaction
    // that spends "everything" is the one that cannot pay for itself.
    setAmount(formatUnits(spendableForSwap(balance, native), token.decimals));
  };

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
      || !confirmGate.tryEnter()
    ) return;
    const submittedJob = job;
    const submittedNetwork = network;
    setBusy(true);
    setError(null);
    try {
      const hash = await sendToken(submittedJob);
      notify(
        t("send.toast", {
          amount: formatAmount(submittedJob.amount, submittedJob.token.decimals),
          symbol: submittedJob.token.symbol,
        }),
        "ok",
        txUrl(hash, submittedNetwork),
      );
      setAmount("");
      setTo("");
      setReviewOpen(false);
      setReviewIdentity(null);
      refresh();
      goHome();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      confirmGate.leave();
      setBusy(false);
    }
  };
  return (
    <Screen title={t("send.title")} onBack={goHome}>
      <form
        className="w-flow"
        aria-busy={busy || loading}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="w-flow-main">
          <TokenSelect
          label={t("send.asset")}
          tokens={tokens}
          value={token}
          disabled={busy}
          onChange={(next) => {
            setTokenId(next.id);
            setAmount("");
            setError(null);
          }}
        />

        <AmountField
          label={t("common.amount")}
          value={amount}
          invalid={amountInvalid}
          disabled={busy}
          onChange={(next) => {
            setAmount(next);
            setError(null);
          }}
          symbol={token.symbol}
          onMax={balance === null ? undefined : fillMax}
          hint={
            balance === null
              ? t("send.readingBalance")
              : t("send.balanceHint", {
                amount: formatBalance(balance, token.decimals),
                symbol: token.symbol,
              })
          }
        />
        {over ? (
          <Note tone="error">
            {reserveBlocked
              ? t("send.gasShort", {
                  amount: formatAmount(NATIVE_GAS_RESERVE_WEI, nativeToken.decimals),
                  symbol: nativeToken.symbol,
                })
              : t("send.overBalance")}
          </Note>
        ) : null}
        {read.error !== null ? <Note tone="error">{read.error}</Note> : null}

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
              setTo(event.target.value);
              setError(null);
            }}
          />
        </label>

        {to.length > 0 && recipient === null ? (
          <Note tone="error">{t("send.badAddress")}</Note>
        ) : null}
        {self ? <Note tone="warn">{t("send.selfAddress")}</Note> : null}
        {feeWei !== null ? (
          <Panel>
            <Rows>
              <Row
                label={t("send.gasFee")}
                value={`${formatAmount(feeWei, nativeToken.decimals)} ${nativeToken.symbol}`}
              />
            </Rows>
          </Panel>
        ) : null}
        {shortOnGas ? (
          <Note tone="warn">
            {t("send.gasShort", {
              amount: formatAmount(NATIVE_GAS_RESERVE_WEI, nativeToken.decimals),
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
          busy={busy}
          ready={!shortOnGas && reviewCurrent}
          onClose={() => setReviewOpen(false)}
          onConfirm={() => void confirm()}
        >
          <div className="w-summary">
            <span className="w-summary-label">{t("send.asset")}</span>
            <span className="w-summary-value">
              {formatAmount(job.amount, token.decimals, 6)} {token.symbol}
            </span>
          </div>
          <Panel>
            <Rows>
              <Row label={t("send.recipient")} value={shortenAddress(job.to, 10, 6)} />
              <Row
                label={t("send.gasFee")}
                value={`${formatAmount(
                  reviewFeeWei,
                  nativeToken.decimals,
                  6,
                )} ${nativeToken.symbol}`}
              />
              <Row label={t("common.network")} value={network.name} />
            </Rows>
          </Panel>
        </TransactionReview>
      ) : null}
    </Screen>
  );
}
