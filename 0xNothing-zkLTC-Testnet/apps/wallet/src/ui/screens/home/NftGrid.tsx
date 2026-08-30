import { type ReactNode } from "react";
import { FALLBACK_TOKEN_LOGO } from "../../../config/assets";
import { t } from "../../../core/i18n";
import { loadPixelNfts } from "../../../core/services/nfts";
import { Empty, Note } from "../../components/kit";
import { useLiveRead } from "../../hooks/useLiveRead";
import { useWallet } from "../../state/WalletContext";

/**
 * The NFT tab: 0xPixel, the one collection on this chain. The artwork is built
 * from the on-chain pixel string, so a card is drawn without touching IPFS, a
 * metadata API or any host other than the RPC node.
 *
 * Not on the block ticker: a collection changes when the user does something, and
 * `tick` already covers that — polling two multicall waves every five seconds
 * for a list that rarely moves would be waste.
 */
export function NftGrid(): ReactNode {
  const { address, network, tick } = useWallet();
  const read = useLiveRead(address ? () => loadPixelNfts(address) : null, [address, tick], {
    live: false,
    identity: [address, network.id],
  });

  if (!network.builtin) {
    return <Empty>{t("network.protocolOnly", { network: "LitVM LiteForge" })}</Empty>;
  }

  if (read.loading) return <Empty>{t("nft.loading")}</Empty>;
  const rows = read.data ?? [];
  if (rows.length === 0) {
    return (
      <>
        {read.data !== null ? <Empty>{t("nft.empty")}</Empty> : null}
        {read.error !== null ? (
          <div className="w-stack">
            <Note tone="error">{read.error}</Note>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="w-nft-grid" aria-busy={read.busy}>
        {rows.map((nft) => (
          <a
            key={nft.tokenId.toString()}
            className="w-nft"
            href={`#/send?nft=${nft.tokenId.toString()}`}
          >
            <img
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
            <span className="w-nft-meta">
              <span className="w-nft-name">{nft.name}</span>
              <span className="w-nft-id">
                #{nft.tokenId.toString()} · {nft.gridSize}×{nft.gridSize}
              </span>
            </span>
          </a>
        ))}
      </div>
      {read.error !== null ? (
        <div className="w-stack">
          <Note tone="error">{read.error}</Note>
        </div>
      ) : null}
    </>
  );
}
