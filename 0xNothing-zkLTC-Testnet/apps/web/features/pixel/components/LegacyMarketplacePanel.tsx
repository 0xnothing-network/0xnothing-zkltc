"use client";

import Link from "next/link";
import { useState } from "react";
import { formatEther, type Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useConnect, usePublicClient, useSwitchChain } from "wagmi";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import { PIXEL_MARKETPLACE_ADDRESS } from "@/lib/publicConfig";
import { LegacyPixelMarketAbi, readLegacyPositions } from "@/lib/legacyPixelMarket";
import styles from "./NusdMarketplaceDashboard.module.css";

/** Exit-only page for the retired zkLTC PixelMarket: cancel own listings and offers. No trading. */
export function LegacyMarketplacePanel() {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: 4441 });
  const connection = useConnect();
  const switcher = useSwitchChain();
  const transaction = useProtocolTransaction();
  const [message, setMessage] = useState("");
  const positions = useQuery({
    queryKey: ["pixel-legacy-positions", PIXEL_MARKETPLACE_ADDRESS, address],
    queryFn: () => readLegacyPositions(client!, PIXEL_MARKETPLACE_ADDRESS, address as Address),
    enabled: Boolean(client && address), staleTime: 15_000, retry: 1,
  });
  const data = positions.data;
  const ready = Boolean(address && chainId === 4441 && data && !transaction.pending);

  async function cancel(functionName: "cancelListing" | "cancelOffer", id: bigint) {
    if (!ready) return;
    setMessage("");
    transaction.reset();
    const hash = await transaction.execute({ call: { address: PIXEL_MARKETPLACE_ADDRESS, abi: LegacyPixelMarketAbi, functionName, args: [id] } });
    if (hash) await positions.refetch();
  }

  return <section className={styles.page} aria-labelledby="legacy-market-title" lang="en">
    <div className={styles.topline}><span className={styles.eyebrow}>0xPixel / marketplace / legacy</span></div>
    <h1 id="legacy-market-title">Legacy zkLTC marketplace</h1>
    <p className={styles.notice}>
      The old zkLTC PixelMarket is retired. Its listings stay buyable in zkLTC while your NFT approval for it is live, so cancel them here.
      That contract paid sellers directly, so it holds no sale proceeds or credits. Escrowed zkLTC offers are refunded to your wallet when you cancel them.
      New trading happens on the <Link href="/0xpixel/marketplace">NUSD marketplace</Link>.
    </p>
    {!address
      ? <button className={styles.primaryButton} disabled={connection.isPending} onClick={() => {
          const connector = connection.connectors.find((item) => item.type === "injected") ?? connection.connectors[0];
          if (connector) void connection.connectAsync({ connector }).catch(() => setMessage("Could not connect wallet."));
        }}>Connect wallet</button>
      : chainId !== 4441
        ? <button className={styles.primaryButton} disabled={switcher.isPending} onClick={() => switcher.switchChain({ chainId: 4441 })}>Switch to LiteForge 4441</button>
        : null}
    {positions.isLoading ? <p role="status">Reading the legacy marketplace…</p> : null}
    {positions.isError ? <p className={styles.error} role="alert">Could not read the legacy marketplace. <button className={styles.textButton} onClick={() => void positions.refetch()}>Retry</button></p> : null}
    {data?.paused ? <p className={styles.error} role="alert">The legacy marketplace is paused. Listing cancellation is blocked by that contract until it is unpaused; offer cancellation still works.</p> : null}
    {data ? <>
      <h2 className={styles.sectionHeading}>Your zkLTC listings ({data.listings.length})</h2>
      {data.listings.length === 0 ? <p className={styles.emptyState}>No active listings from this wallet.</p> :
        <table className={styles.table}><thead><tr><th>Listing</th><th>NFT</th><th>Price</th><th /></tr></thead><tbody>
          {data.listings.map((listing) => <tr key={listing.id.toString()}>
            <td>#{listing.id.toString()}</td><td>{listing.collection.slice(0, 6)}…{listing.collection.slice(-4)} #{listing.tokenId.toString()}</td><td>{formatEther(listing.price)} zkLTC</td>
            <td><button className={styles.secondaryButton} disabled={!ready || data.paused} onClick={() => void cancel("cancelListing", listing.id)}>Cancel listing</button></td>
          </tr>)}
        </tbody></table>}
      <h2 className={styles.sectionHeading}>Your zkLTC offers ({data.offers.length})</h2>
      {data.offers.length === 0 ? <p className={styles.emptyState}>No escrowed offers from this wallet.</p> :
        <table className={styles.table}><thead><tr><th>Offer</th><th>NFT</th><th>Escrow</th><th /></tr></thead><tbody>
          {data.offers.map((offer) => <tr key={offer.id.toString()}>
            <td>#{offer.id.toString()}</td><td>{offer.collection.slice(0, 6)}…{offer.collection.slice(-4)} #{offer.tokenId.toString()}</td><td>{formatEther(offer.price)} zkLTC</td>
            <td><button className={styles.secondaryButton} disabled={!ready} onClick={() => void cancel("cancelOffer", offer.id)}>Cancel &amp; refund</button></td>
          </tr>)}
        </tbody></table>}
      {!data.offerScanComplete ? <p className={styles.formFootnote}>The offer scan hit its limit; older offers may be missing.</p> : null}
    </> : null}
    {transaction.message ? <p className={styles.transactionNotice} role="status">{transaction.message}</p> : null}
    {message ? <p className={styles.error} role="alert">{message}</p> : null}
  </section>;
}
