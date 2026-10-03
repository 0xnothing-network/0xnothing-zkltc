"use client";

import { useProtocolReceipt } from "@/lib/useProtocolReceipt";

import { memo, useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { parseEther, formatEther } from "viem";
import {
  PIXEL_MARKETPLACE_ADDRESS,
  getTokenExplorerUrl,
  getMarketplaceTxUrl,
} from "@/lib/contract";
import { PixelNFTABI } from "@/lib/abi";
import { MarketplaceAbi } from "@/lib/marketplaceAbi";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";
import { LITVM_CHAIN_ID } from "@/lib/chainSwitch";
import { createWalletSessionGuard } from "@/lib/walletSession";

export interface OwnedNft {
  collection: `0x${string}`;
  tokenId: bigint;
  name: string;
  imageUrl: string;
  listing: {
    listingId: bigint;
    price: bigint;
  } | null;
}

interface CardProps {
  nft: OwnedNft;
  isPaused: boolean;
  onChanged: () => void;
  priority?: boolean;
}

export const OwnedNftCard = memo(function OwnedNftCard({ nft, isPaused, onChanged, priority = false }: CardProps) {
  const [mode, setMode] = useState<"idle" | "list">("idle");
  const [price, setPrice] = useState("");

  return (
    <div
      className="nft-card group bg-[#1A1A2E] rounded-xl sm:rounded-2xl overflow-hidden border border-[#2D2D44] hover:border-indigo-500/50 transition-[border-color,box-shadow,transform] duration-300 hover:shadow-xl hover:shadow-indigo-500/10"
    >
      <Link
        href={getTokenExplorerUrl(nft.collection, nft.tokenId)}
        target="_blank"
        rel="noopener noreferrer"
        className="block relative aspect-square bg-[#0F0F23] flex items-center justify-center overflow-hidden"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={nft.imageUrl}
          alt={nft.name}
          className="w-full h-full object-contain transition-transform group-hover:scale-105"
          style={{ imageRendering: "pixelated" }}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
        />
        {nft.listing ? (
          <div
            className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 px-1.5 sm:px-2 py-1 rounded-md bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[8px] sm:text-[10px] font-bold max-w-[calc(100%-12px)] truncate"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            FOR SALE · {formatEther(nft.listing.price)} zkLTC
          </div>
        ) : null}
      </Link>
      <div className="p-3 sm:p-4 space-y-2.5 sm:space-y-3">
        <div>
          <div
            className="text-[10px] text-[#64748B] uppercase tracking-wider"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            0xPIXEL
          </div>
          <h3
            className="text-white font-bold text-sm sm:text-base truncate"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            {nft.name || "Untitled"}
          </h3>
          <div
            className="text-[#94A3B8] text-[11px] sm:text-xs mt-0.5"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            #{nft.tokenId.toString()}
          </div>
        </div>

        {nft.listing ? (
          <CancelListingControl
            listingId={nft.listing.listingId}
            disabled={isPaused}
            onSuccess={onChanged}
          />
        ) : mode === "list" ? (
          <ListForSaleControl
            collection={nft.collection}
            tokenId={nft.tokenId}
            price={price}
            onPriceChange={setPrice}
            onCancel={() => {
              setMode("idle");
              setPrice("");
            }}
            disabled={isPaused}
            onSuccess={() => {
              setMode("idle");
              setPrice("");
              onChanged();
            }}
          />
        ) : (
          <button
            onClick={() => setMode("list")}
            disabled={isPaused}
            className="pixel-btn pixel-btn-indigo w-full"
            style={{ padding: "12px 12px" }}
          >
            LIST FOR SALE
          </button>
        )}
      </div>
    </div>
  );
});

function ListForSaleControl({
  collection,
  tokenId,
  price,
  onPriceChange,
  onCancel,
  onSuccess,
  disabled,
}: {
  collection: `0x${string}`;
  tokenId: bigint;
  price: string;
  onPriceChange: (s: string) => void;
  onCancel: () => void;
  onSuccess: () => void;
  disabled: boolean;
}) {
  const { address, isConnected, chainId } = useAccount();
  const walletConfig = useConfig();
  const [sessionError, setSessionError] = useState("");
  const submissionRef = useRef<{ account: `0x${string}`; collection: `0x${string}`; tokenId: bigint; price: bigint; assertWalletUnchanged: () => void } | null>(null);
  const { writeContractAsync, isPending, data: approveHash, error: approveErr } =
    useWriteContract();
  const { data: approveReceipt, isLoading: waitingApprove, error: approveReceiptErr } =
    useProtocolReceipt({ chainId: LITVM_CHAIN_ID, hash: approveHash });
  const {
    writeContractAsync: writeListAsync,
    isPending: listing,
    data: listHash,
    error: listErr,
  } = useWriteContract();
  const { data: listReceipt, isLoading: waitingList, error: listReceiptErr } =
    useProtocolReceipt({ chainId: LITVM_CHAIN_ID, hash: listHash });
  const firedRef = useRef(false);
  const submitLockRef = useRef(false);
  const handledApprovalRef = useRef<`0x${string}` | undefined>(undefined);
  const approved = approveReceipt?.status === "success";
  const listed = listReceipt?.status === "success";

  useEffect(() => {
    if (listed && !firedRef.current) {
      firedRef.current = true;
      onSuccess();
    }
  }, [listed, onSuccess]);

  useEffect(() => {
    if (
      listReceipt ||
      listReceiptErr ||
      approveReceipt?.status === "reverted" ||
      approveReceiptErr
    ) {
      releaseAction(submitLockRef);
    }
  }, [approveReceipt, approveReceiptErr, listReceipt, listReceiptErr]);

  const priceWei = useMemo(() => {
    if (!/^\d+(?:\.\d+)?$/.test(price)) return null;
    try {
      const parsed = parseEther(price);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [price]);
  const priceValid = priceWei !== null;
  const busy = isPending || waitingApprove || listing || waitingList;

  const doList = useCallback(async () => {
    const submission = submissionRef.current;
    if (!submission) return;
    try {
      submission.assertWalletUnchanged();
      await writeListAsync({
        account: submission.account,
        chainId: LITVM_CHAIN_ID,
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "list",
        args: [submission.collection, submission.tokenId, submission.price],
      });
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to list this NFT");
      releaseAction(submitLockRef);
      // surfaced via listErr
    }
  }, [writeListAsync]);

  useEffect(() => {
    if (approved && approveHash && price && !firedRef.current && !listing && !listHash && handledApprovalRef.current !== approveHash) {
      handledApprovalRef.current = approveHash;
      void doList();
    }
  }, [approved, approveHash, price, listing, listHash, doList]);

  const handleSubmit = async () => {
    firedRef.current = false;
    if (priceWei === null || disabled) return;
    if (!isConnected || !address || chainId !== LITVM_CHAIN_ID) {
      setSessionError("Connect your wallet on LitVM LiteForge before listing.");
      return;
    }
    if (!tryAcquireAction(submitLockRef)) return;
    try {
      setSessionError("");
      const assertWalletUnchanged = createWalletSessionGuard(walletConfig, address, LITVM_CHAIN_ID);
      assertWalletUnchanged();
      submissionRef.current = { account: address, collection, tokenId, price: priceWei, assertWalletUnchanged };
      await writeContractAsync({
        account: address,
        chainId: LITVM_CHAIN_ID,
        address: collection,
        abi: PixelNFTABI,
        functionName: "approve",
        args: [PIXEL_MARKETPLACE_ADDRESS, tokenId],
      });
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to approve this NFT");
      releaseAction(submitLockRef);
      // surfaced via approveErr
    }
  };

  return (
    <div className="space-y-2">
      <input
        type="number"
        step="0.001"
        min="0"
        value={price}
        onChange={(e) => onPriceChange(e.target.value)}
        placeholder="Price (zkLTC)"
        className="w-full bg-[#0F0F23] border border-[#2D2D44] text-white text-sm rounded-lg px-3 py-3 sm:py-2 focus:outline-none focus:border-indigo-500"
        style={{ fontFamily: "var(--font-departure)" }}
        disabled={busy}
      />
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="pixel-btn pixel-btn-secondary pixel-btn-sm"
        >
          CANCEL
        </button>
        <button
          onClick={handleSubmit}
          disabled={busy || !priceValid || disabled}
          className="pixel-btn pixel-btn-emerald pixel-btn-sm"
        >
          {busy ? (
            <span className="flex items-center justify-center gap-1">
              <span className="pixel-spinner" />
              {waitingApprove
                ? "Approving…"
                : waitingList
                ? "Listing…"
                : "Submitting…"}
            </span>
          ) : (
            "CONFIRM"
          )}
        </button>
      </div>
      {approveHash ? (
        <a
          href={getMarketplaceTxUrl(approveReceipt?.transactionHash ?? approveHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-[10px] text-indigo-300 hover:text-indigo-200 underline"
        >
          Approval tx ↗
        </a>
      ) : null}
      {sessionError || approveErr || listErr || approveReceiptErr || listReceiptErr || approveReceipt?.status === "reverted" || listReceipt?.status === "reverted" ? (
        <p className="text-xs text-red-300 break-all">
          {sessionError || (approveErr || listErr || approveReceiptErr || listReceiptErr)?.message ||
            (approveReceipt?.status === "reverted"
              ? "Approval transaction reverted"
              : "Listing transaction reverted")}
        </p>
      ) : null}
    </div>
  );
}

function CancelListingControl({
  listingId,
  disabled,
  onSuccess,
}: {
  listingId: bigint;
  disabled: boolean;
  onSuccess: () => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const walletConfig = useConfig();
  const [sessionError, setSessionError] = useState("");
  const { writeContractAsync, isPending, data: txHash, error } =
    useWriteContract();
  const { data: receipt, isLoading: waiting, error: receiptError } = useProtocolReceipt({
    chainId: LITVM_CHAIN_ID,
    hash: txHash,
  });
  const firedRef = useRef(false);
  const cancelLockRef = useRef(false);

  useEffect(() => {
    if (receipt?.status === "success" && !firedRef.current) {
      firedRef.current = true;
      onSuccess();
    }
  }, [receipt, onSuccess]);

  useEffect(() => {
    if (receipt || receiptError) releaseAction(cancelLockRef);
  }, [receipt, receiptError]);

  const handleCancel = async () => {
    firedRef.current = false;
    if (disabled || !isConnected || !address || chainId !== LITVM_CHAIN_ID) {
      setSessionError("Connect your wallet on LitVM LiteForge before cancelling.");
      return;
    }
    if (!tryAcquireAction(cancelLockRef)) return;
    try {
      setSessionError("");
      createWalletSessionGuard(walletConfig, address, LITVM_CHAIN_ID)();
      await writeContractAsync({
        account: address,
        chainId: LITVM_CHAIN_ID,
        address: PIXEL_MARKETPLACE_ADDRESS,
        abi: MarketplaceAbi,
        functionName: "cancelListing",
        args: [listingId],
      });
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to cancel this listing");
      releaseAction(cancelLockRef);
      // surfaced via error
    }
  };

  const busy = isPending || waiting;

  return (
    <div className="space-y-1">
      <button
        onClick={handleCancel}
        disabled={busy || disabled}
        className="pixel-btn pixel-btn-red w-full"
        style={{ padding: "12px 12px" }}
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <span className="pixel-spinner" />{" "}
            {waiting ? "Confirming…" : "Submitting…"}
          </span>
        ) : (
          "REMOVE LISTING"
        )}
      </button>
      {sessionError || error || receiptError || receipt?.status === "reverted" ? (
        <p className="text-xs text-red-300 break-all">
          {sessionError || (error || receiptError)?.message || "Cancel transaction reverted"}
        </p>
      ) : null}
    </div>
  );
}
