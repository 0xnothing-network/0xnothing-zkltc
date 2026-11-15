import { type ReactNode, useEffect, useState } from "react";
import { getAddress, type Hex } from "viem";
import { FALLBACK_TOKEN_LOGO } from "../../../config/assets";
import { txUrl } from "../../../config/chain";
import { chainScope } from "../../../config/networks";
import { CONTRACTS, PIXEL_COLLECTIONS } from "../../../config/contracts";
import { t } from "../../../core/i18n";
import { BroadcastUnknownError, describeError } from "../../../core/lib/errors";
import { groupHex } from "../../../core/lib/format";
import type { TxKind } from "../../../core/services/history";
import { findPixelNft, loadPixelNfts, transferPixelNft } from "../../../core/services/nfts";
import { validateRecipient } from "../../../core/services/transfer";
import { Button, Empty, Icon, Note, Panel, Row, Rows } from "../../components/kit";
import { RecentRecipients, RecipientWarning } from "../../components/RecipientHints";
import { Screen } from "../../components/Screen";
import { TransactionReview } from "../../components/TransactionReview";
import { useActionGate } from "../../hooks/useActionGate";
import { useBroadcastHold } from "../../hooks/useBroadcastHold";
import { useLiveRead } from "../../hooks/useLiveRead";
import { useRecipients } from "../../hooks/useRecipients";
import { recipientName, recipientRisk, rememberRecipient } from "../../lib/recipients";
import { reviewKey } from "../../lib/reviewKey";
import { goHome } from "../../router";
import { useWallet } from "../../state/WalletContext";

/** History kinds an NFT send writes; a pending one holds a reopened screen. */
const NFT_KINDS: readonly TxKind[] = ["nft"];

/**
 * Sending a 0xPixel NFT. Reached from the NFT tab, so the token is already
 * chosen and the only decision left is where it goes — and `transferNFT` is
 * final, which is why the address is echoed back before the button is armed.
 */
export function SendNft({ tokenId, collection }: { tokenId: string; collection: string | null }): ReactNode {
  const { address, accounts, network, notify, refresh, tick } = useWallet();
  const read = useLiveRead(address ? () => loadPixelNfts(address) : null, [
    address,
    network.id,
    network.rpcUrl,
    tick,
  ], {
    live: false,
    identity: [address, network.id, network.rpcUrl],
  });
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewIdentity, setReviewIdentity] = useState<string | null>(null);
  const confirmGate = useActionGate();
  const broadcast = useBroadcastHold(address, network, NFT_KINDS);
  const known = useRecipients(address, network);

  // Existing bookmarks without a collection refer to the original NFT contract.
  const selectedCollection = collection ?? CONTRACTS.pixelClassicNft;
  const valid = /^\d+$/u.test(tokenId) && PIXEL_COLLECTIONS.some((entry) => entry.address.toLowerCase() === selectedCollection.toLowerCase());
  const nft = read.data ? findPixelNft(read.data, selectedCollection, tokenId) : null;
  const recipient = validateRecipient(to);
  const self = recipient !== null && address !== null
    && recipient.toLowerCase() === address.toLowerCase();
  // The wallet's own accounts count as known recipients.
  const risk = recipient !== null && !self && known !== null
    ? recipientRisk(recipient, [...known.map((entry) => entry.address), ...accounts.map((entry) => entry.address)])
    : null;
  const currentReviewIdentity = reviewKey([
    address,
    network.id,
    network.rpcUrl,
    to,
    recipient,
    tokenId,
    selectedCollection,
    nft?.collection,
    nft?.tokenId,
    nft?.name,
  ]);
  const reviewCurrent = reviewIdentity === currentReviewIdentity;

  useEffect(() => {
    setReviewOpen(false);
    setReviewIdentity(null);
  }, [address, network.id, network.rpcUrl, to, tokenId, selectedCollection]);

  if (!network.builtin) {
    return (
      <Screen title={t("nft.sendTitle")} onBack={goHome}>
        <div className="w-stack">
          <Note tone="warn">{t("network.protocolOnly", { network: "LitVM LiteForge" })}</Note>
        </div>
      </Screen>
    );
  }

  const submit = (): void => {
    if (busy || !address || !recipient || !nft) return;
    setError(null);
    setReviewIdentity(currentReviewIdentity);
    setReviewOpen(true);
  };

  const confirm = async (): Promise<void> => {
    if (
      busy
      || !reviewOpen
      || !reviewCurrent
      || !address
      || !recipient
      || !nft
      || broadcast.held
      || !confirmGate.tryEnter()
    ) return;
    const submitted = {
      from: address,
      to: recipient,
      tokenId: nft.tokenId,
      name: nft.name,
      collection: nft.collection,
    };
    const submittedNetwork = network;
    setBusy(true);
    setError(null);
    // Also run when a held broadcast is later found mined: the job went through.
    const sent = (hash: Hex): void => {
      notify(t("nft.sentToast", { name: submitted.name }), "ok", txUrl(hash, submittedNetwork));
      void rememberRecipient(submitted.from, chainScope(submittedNetwork.id), submitted.to).catch(() => undefined);
      setError(null);
      setReviewOpen(false);
      setReviewIdentity(null);
      refresh();
      goHome();
    };
    try {
      sent(await transferPixelNft(submitted));
    } catch (cause) {
      // The node may hold it: keep the form, hold Confirm, link the hash.
      if (cause instanceof BroadcastUnknownError) {
        broadcast.hold(cause.hash, sent);
        notify(describeError(cause), "error", txUrl(cause.hash, submittedNetwork));
      }
      setError(describeError(cause));
    } finally {
      confirmGate.leave();
      setBusy(false);
    }
  };
  return (
    <Screen title={t("nft.sendTitle")} onBack={goHome}>
      {!valid || (read.data !== null && nft === null) ? (
        <Empty>{t("nft.notFound")}</Empty>
      ) : (
        <form
          className="w-flow w-send-flow w-send-nft"
          aria-busy={busy || read.loading}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="w-flow-main">
            {nft ? (
              <div className="w-split w-nft-card">
                <img
                  className="w-logo"
                  data-pixel="true"
                  data-size="lg"
                  src={nft.image || FALLBACK_TOKEN_LOGO}
                  alt={nft.name}
                  loading="lazy"
                  decoding="async"
                  onError={(event) => {
                    if (event.currentTarget.dataset.fallback === "true") return;
                    event.currentTarget.dataset.fallback = "true";
                    event.currentTarget.src = FALLBACK_TOKEN_LOGO;
                  }}
                />
                <span className="w-mono-break">
                  {nft.name}
                  <br />
                  <span className="w-nft-id">
                    {nft.collectionName} #{nft.tokenId.toString()} · {nft.gridSize}×{nft.gridSize}
                  </span>
                </span>
              </div>
            ) : read.error !== null ? (
              <Note tone="error">{read.error}</Note>
            ) : (
              <Note>{t("nft.reading")}</Note>
            )}

            <label className="w-field">
              <span className="w-label">{t("send.recipient")}</span>
              <input
                className="w-input"
                value={to}
                placeholder="0x…"
                disabled={busy}
                autoFocus
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
            {to.length === 0 ? (
              <RecentRecipients
                known={known}
                disabled={busy}
                onPick={(picked) => {
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
            <p className="w-hint w-flow-note">
              <Icon name="info" size={14} />
              <span>{t("nft.irreversible")}</span>
            </p>
          </div>
          <div className="w-flow-actions">
            {error ? <Note tone="error">{error}</Note> : null}
            <Button
              type="submit"
              variant="primary"
              block
              disabled={busy || !recipient || !nft}
            >
              {busy ? t("send.sending") : t("nft.sendTitle")}
            </Button>
          </div>
        </form>
      )}
      {reviewOpen && reviewCurrent && nft !== null && recipient !== null ? (
        <TransactionReview
          title={t("apr.titleTx")}
          armKey={currentReviewIdentity}
          busy={busy}
          ready={address !== null && reviewCurrent && !broadcast.held}
          onClose={() => setReviewOpen(false)}
          onConfirm={() => void confirm()}
          error={error}
        >
          <div className="w-summary">
            <span className="w-summary-label">{nft.name}</span>
            <span className="w-summary-value">{nft.collectionName} #{nft.tokenId.toString()}</span>
          </div>
          <Panel>
            <Rows>
              <Row
                label={t("send.recipient")}
                value={<span className="w-review-address">{groupHex(getAddress(recipient))}</span>}
              />
              {recipientName(known, recipient) !== null ? (
                <Row label={t("send.savedAs")} value={recipientName(known, recipient)} />
              ) : null}
              <Row label={t("common.network")} value={network.name} />
            </Rows>
          </Panel>
          <RecipientWarning risk={risk} />
        </TransactionReview>
      ) : null}
    </Screen>
  );
}
