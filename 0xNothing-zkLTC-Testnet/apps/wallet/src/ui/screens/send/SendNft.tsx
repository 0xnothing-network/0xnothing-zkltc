import { type ReactNode, useEffect, useState } from "react";
import { FALLBACK_TOKEN_LOGO } from "../../../config/assets";
import { txUrl } from "../../../config/chain";
import { t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { shortenAddress } from "../../../core/lib/format";
import { loadPixelNfts, transferPixelNft } from "../../../core/services/nfts";
import { validateRecipient } from "../../../core/services/transfer";
import { Button, Empty, Note, Panel, Row, Rows } from "../../components/kit";
import { Screen } from "../../components/Screen";
import { TransactionReview } from "../../components/TransactionReview";
import { useLiveRead } from "../../hooks/useLiveRead";
import { goHome } from "../../router";
import { useWallet } from "../../state/WalletContext";

/**
 * Sending a 0xPixel NFT. Reached from the NFT tab, so the token is already
 * chosen and the only decision left is where it goes — and `transferNFT` is
 * final, which is why the address is echoed back before the button is armed.
 */
export function SendNft({ tokenId }: { tokenId: string }): ReactNode {
  const { address, network, notify, refresh, tick } = useWallet();
  const read = useLiveRead(address ? () => loadPixelNfts(address) : null, [address, tick], {
    live: false,
    identity: [address, network.id],
  });
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const valid = /^\d+$/u.test(tokenId);
  const nft = read.data?.find((entry) => entry.tokenId.toString() === tokenId) ?? null;
  const recipient = validateRecipient(to);
  const self = recipient !== null && address !== null
    && recipient.toLowerCase() === address.toLowerCase();

  useEffect(() => {
    setReviewOpen(false);
  }, [address, network.id, to, tokenId]);

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
    setReviewOpen(true);
  };

  const confirm = async (): Promise<void> => {
    if (busy || !reviewOpen || !address || !recipient || !nft) return;
    setBusy(true);
    setError(null);
    try {
      const hash = await transferPixelNft({
        from: address,
        to: recipient,
        tokenId: nft.tokenId,
        name: nft.name,
      });
      notify(t("nft.sentToast", { name: nft.name }), "ok", txUrl(hash, network));
      setReviewOpen(false);
      refresh();
      goHome();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t("nft.sendTitle")} onBack={goHome}>
      {!valid || (read.data !== null && nft === null) ? (
        <Empty>{t("nft.notFound")}</Empty>
      ) : (
        <form
          className="w-flow"
          aria-busy={busy || read.loading}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="w-flow-main">
            {nft ? (
            <div className="w-split">
              <span className="w-mono-break">
                {nft.name}
                <br />
                <span className="w-nft-id">
                  #{nft.tokenId.toString()} · {nft.gridSize}×{nft.gridSize}
                </span>
              </span>
              <img
                className="w-logo"
                data-pixel="true"
                data-size="lg"
                src={nft.image || FALLBACK_TOKEN_LOGO}
                alt={nft.name}
                loading="lazy"
                decoding="async"
                onError={(event) => {
                  event.currentTarget.src = FALLBACK_TOKEN_LOGO;
                }}
              />
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
          {to.length > 0 && recipient === null ? (
            <Note tone="error">{t("send.badAddress")}</Note>
          ) : null}
            {self ? <Note tone="warn">{t("send.selfAddress")}</Note> : null}
            <Note>{t("nft.irreversible")}</Note>
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
      {reviewOpen && nft !== null && recipient !== null ? (
        <TransactionReview
          title={t("apr.titleTx")}
          busy={busy}
          ready={address !== null}
          onClose={() => setReviewOpen(false)}
          onConfirm={() => void confirm()}
        >
          <div className="w-summary">
            <span className="w-summary-label">{nft.name}</span>
            <span className="w-summary-value">#{nft.tokenId.toString()}</span>
          </div>
          <Panel>
            <Rows>
              <Row label={t("send.recipient")} value={shortenAddress(recipient, 10, 6)} />
              <Row label={t("common.network")} value={network.name} />
            </Rows>
          </Panel>
        </TransactionReview>
      ) : null}
    </Screen>
  );
}
