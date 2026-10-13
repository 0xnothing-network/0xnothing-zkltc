"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther, type Address } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { PIXEL_MARKETPLACE_ADDRESS, getMarketplaceTxUrl } from "@/lib/contract";
import { MarketplaceAbi } from "@/lib/marketplaceAbi";
import { readLegacyListings, type LegacyListing } from "@/lib/legacyListings";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";
import { LITVM_CHAIN_ID } from "@/lib/chainSwitch";
import { createWalletSessionGuard } from "@/lib/walletSession";
import { useProtocolReceipt } from "@/lib/useProtocolReceipt";

type OwnedToken = { collection: Address; tokenId: bigint; name: string };

/**
 * Warns a wallet whose NFTs are still listed on the retired zkLTC marketplace.
 * Those listings remain purchasable at their old native price, so each one gets
 * a direct cancel action. Renders nothing when the wallet has none.
 */
export function LegacyListingsNotice({ address, tokens }: { address: Address; tokens: readonly OwnedToken[] }) {
  const client = usePublicClient({ chainId: LITVM_CHAIN_ID });
  const tokenKey = tokens.map((token) => `${token.collection.toLowerCase()}:${token.tokenId}`).sort().join(",");
  const legacy = useQuery({
    queryKey: ["pixel-legacy-listings", address, tokenKey],
    queryFn: () => readLegacyListings(client!, PIXEL_MARKETPLACE_ADDRESS, address, tokens),
    enabled: Boolean(client && tokens.length),
    staleTime: 30_000,
    retry: 1,
  });
  const { data: paused } = useReadContract({ address: PIXEL_MARKETPLACE_ADDRESS, abi: MarketplaceAbi, functionName: "paused", chainId: LITVM_CHAIN_ID });
  const listings = legacy.data ?? [];
  if (!listings.length) return null;
  const names = new Map(tokens.map((token) => [`${token.collection.toLowerCase()}:${token.tokenId}`, token.name]));

  return (
    <section
      className="mb-4 px-4 py-3 rounded-lg bg-(--warning)/10 border border-(--warning)/30 text-(--warning) text-sm space-y-3"
      style={{ fontFamily: "var(--font-ui)" }}
      aria-labelledby="legacy-listings-title"
      role="alert"
    >
      <div>
        <h2 id="legacy-listings-title" className="font-bold text-(--warning)">
          {listings.length} NFT{listings.length === 1 ? " is" : "s are"} still listed on the old zkLTC marketplace
        </h2>
        <p className="text-xs text-(--warning)/90 mt-1">
          Anyone can still buy {listings.length === 1 ? "it" : "them"} there at the old zkLTC price. Cancel the old listing to keep your NFT, then relist it for NUSD if you want to sell.
          {paused === true ? " The old marketplace is paused, so cancelling is unavailable; revoke its NFT approval in your wallet instead." : ""}
        </p>
      </div>
      <ul className="space-y-2">
        {listings.map((listing) => (
          <li key={listing.listingId.toString()} className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-(--text-1)">
              {names.get(`${listing.collection.toLowerCase()}:${listing.tokenId}`) || "Untitled"} #{listing.tokenId.toString()}
              <span className="text-(--text-2)"> · {formatEther(listing.price)} zkLTC</span>
            </span>
            <LegacyCancelButton listing={listing} disabled={paused === true} onDone={() => void legacy.refetch()} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function LegacyCancelButton({ listing, disabled, onDone }: { listing: LegacyListing; disabled: boolean; onDone: () => void }) {
  const { address, chainId } = useAccount();
  const walletConfig = useConfig();
  const [sessionError, setSessionError] = useState("");
  const { writeContractAsync, isPending, data: txHash, error } = useWriteContract();
  const { data: receipt, isLoading: waiting, error: receiptError } = useProtocolReceipt({ chainId: LITVM_CHAIN_ID, hash: txHash });
  const lock = useRef(false);
  const fired = useRef(false);

  useEffect(() => {
    if (receipt?.status === "success" && !fired.current) {
      fired.current = true;
      onDone();
    }
  }, [receipt, onDone]);

  useEffect(() => {
    if (receipt || receiptError) releaseAction(lock);
  }, [receipt, receiptError]);

  async function cancel() {
    fired.current = false;
    if (!address || chainId !== LITVM_CHAIN_ID) {
      setSessionError("Connect your wallet on LitVM LiteForge before cancelling.");
      return;
    }
    if (!tryAcquireAction(lock)) return;
    try {
      setSessionError("");
      createWalletSessionGuard(walletConfig, address, LITVM_CHAIN_ID)();
      await writeContractAsync({
        account: address,
        chainId: LITVM_CHAIN_ID,
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "cancelListing",
        args: [listing.listingId],
      });
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : "Unable to cancel this listing");
      releaseAction(lock);
    }
  }

  const busy = isPending || waiting;
  const failure = sessionError || (error || receiptError)?.message || (receipt?.status === "reverted" ? "Cancel transaction reverted" : "");
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={() => void cancel()} disabled={busy || disabled} className="pixel-btn pixel-btn-red pixel-btn-sm">
        {busy ? (waiting ? "Confirming…" : "Submitting…") : "CANCEL OLD LISTING"}
      </button>
      {receipt?.status === "success" && txHash ? (
        <a className="text-xs underline" href={getMarketplaceTxUrl(receipt.transactionHash)} target="_blank" rel="noopener noreferrer">Cancelled · view transaction</a>
      ) : null}
      {failure ? <p className="text-xs text-(--negative) break-all max-w-xs">{failure}</p> : null}
    </div>
  );
}
