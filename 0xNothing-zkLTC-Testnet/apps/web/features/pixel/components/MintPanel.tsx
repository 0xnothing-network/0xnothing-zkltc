"use client";

import { memo, useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  useAccount,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useReadContract,
  usePublicClient,
  useSwitchChain,
} from "wagmi";
import { decodeEventLog, encodeFunctionData } from "viem";
import { publicClient, PIXEL_NFT_CONTRACT_ADDRESS, getMarketplaceTxUrl } from "@/lib/contract";
import { PixelNFTABI } from "@/lib/abi";
import { PixelButton } from "@/features/pixel/components/PixelButton";
import { pixelDataToPNG, pixelDataToPackedBytes } from "@/lib/gridParser";
import { useToast } from "@/components/Toast";
import { normalizeError } from "@/lib/errors";
import { LITVM_CHAIN_ID } from "@/lib/chainSwitch";
import { PixelLoadingIndicator } from "@/components/PageLoader";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";

interface MintPanelProps {
  pixelData: string[][];
  gridSize: number;
  isCanvasUpdating?: boolean;
  onMintSuccess: () => void;
}

const DEBOUNCE_MS = 600;
const TX_TOAST_DURATION = 12_000; // keep "submitted" toast visible longer

export const MintPanel = memo(function MintPanel({ pixelData, gridSize, isCanvasUpdating = false, onMintSuccess }: MintPanelProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [mounted, setMounted] = useState(false);

  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const wcClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const toast = useToast();

  // The wrong-network prompt lives in PixelHeader, which the /0xpixel layout
  // mounts on every page of the section. Repeating the effect here fired two
  // toasts and two switchChain() calls — so two wallet prompts — for one wrong
  // network. The manual guard inside handleMint below still covers the case
  // where the chain changes between mount and submit.

  const { data: mintReceipt, error: mintReceiptError, isLoading: isConfirming } =
    useWaitForTransactionReceipt({ hash: txHash ?? undefined });

  const firedRef = useRef(false);
  const mintLockRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preparedPixelDataRef = useRef<string[][] | null>(null);
  const toastIdsRef = useRef<{ submitted?: string; confirmed?: string }>({});

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const hasDrawing = useMemo(
    () => pixelData.some((row) => row.some((cell) => cell !== "transparent")),
    [pixelData]
  );

  const [previewBase64, setPreviewBase64] = useState("");
  const [debouncedPackedBytes, setDebouncedPackedBytes] = useState<`0x${string}`>("0x");

  // PNG encoding and byte packing are deferred until the current stroke is idle.
  useEffect(() => {
    preparedPixelDataRef.current = null;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!hasDrawing) {
      setPreviewBase64("");
      setDebouncedPackedBytes("0x");
      return;
    }
    setPreviewBase64("");
    setDebouncedPackedBytes("0x");
    const snapshot = pixelData;
    debounceTimerRef.current = setTimeout(() => {
      setPreviewBase64(pixelDataToPNG(snapshot, gridSize));
      setDebouncedPackedBytes(pixelDataToPackedBytes(snapshot, gridSize));
      preparedPixelDataRef.current = snapshot;
    }, DEBOUNCE_MS);
  }, [gridSize, hasDrawing, pixelData]);

  const isCheckingOriginal = (debouncedPackedBytes === "0x" || isCanvasUpdating) && hasDrawing;

  const { data: isOriginal } = useReadContract({
    address: PIXEL_NFT_CONTRACT_ADDRESS,
    abi: PixelNFTABI,
    functionName: "checkOriginal",
    args: [debouncedPackedBytes, BigInt(gridSize)],
    query: {
      enabled: debouncedPackedBytes !== "0x",
    },
  });

  // Once tx confirms, decode the Minted event from the receipt to get the
  // real tokenId. Calling onMintSuccess with a hard-coded 0n used to break
  // gallery refresh — this fixes that race.
  useEffect(() => {
    if (!mintReceipt || !txHash || firedRef.current) return;
    firedRef.current = true;
    releaseAction(mintLockRef);

    if (mintReceipt.status !== "success") {
      if (toastIdsRef.current.submitted) toast.dismiss(toastIdsRef.current.submitted);
      toast.error("Mint failed", "The mint transaction reverted on-chain.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        let tokenId: bigint | null = null;
        for (const log of mintReceipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: PixelNFTABI,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "Minted") {
              const args = decoded.args as { tokenId?: bigint };
              if (args?.tokenId !== undefined) tokenId = args.tokenId;
              break;
            }
          } catch {
            // not our event, skip
          }
        }

        if (cancelled) return;

        // Replace the "submitted" toast with a confirmation toast.
        if (toastIdsRef.current.submitted) toast.dismiss(toastIdsRef.current.submitted);
        toastIdsRef.current.confirmed = toast.success(
          "Minted successfully!",
          tokenId !== null
            ? `Your pixel NFT #${tokenId.toString()} is now on-chain.`
            : "Your pixel NFT is now on-chain."
        );

        onMintSuccess();
      } catch (err) {
        console.error("[Mint] failed to decode receipt:", err);
        if (cancelled) return;
        if (toastIdsRef.current.submitted) toast.dismiss(toastIdsRef.current.submitted);
        toastIdsRef.current.confirmed = toast.success(
          "Minted!",
          "Your pixel NFT was created. (We couldn't read the token id.)"
        );
        onMintSuccess();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mintReceipt, txHash, onMintSuccess, toast]);

  useEffect(() => {
    if (mintReceiptError) releaseAction(mintLockRef);
  }, [mintReceiptError]);

  const handleMint = useCallback(async () => {
    if (!isConnected || !address) {
      toast.warning("Connect your wallet", "Click CONNECT WALLET in the top-right to begin.");
      return;
    }
    if (chainId && chainId !== LITVM_CHAIN_ID) {
      toast.show({
        title: "Wrong Network",
        description: "Please switch to LitVM to mint",
        kind: "info",
        duration: 3000,
      });
      switchChain?.({ chainId: LITVM_CHAIN_ID });
      return;
    }
    if (!name.trim()) {
      toast.warning("Name your artwork", "Give your pixel art a name before minting.");
      return;
    }
    if (!hasDrawing) {
      toast.warning("Nothing to mint", "Draw at least one pixel first.");
      return;
    }
    if (isCanvasUpdating) {
      toast.info("Preparing artwork", "Wait a moment for the latest canvas changes to finish.");
      return;
    }
    if (isOriginal === false) {
      toast.info("Already minted", "This exact artwork has been claimed by someone else.");
      return;
    }
    if (preparedPixelDataRef.current !== pixelData || debouncedPackedBytes.length <= 2) {
      toast.info("Preparing artwork", "Wait a moment for the artwork check to finish.");
      return;
    }
    if (!tryAcquireAction(mintLockRef)) return;

    setIsLoading(true);
    setTxHash(null);
    firedRef.current = false;
    if (toastIdsRef.current.submitted) toast.dismiss(toastIdsRef.current.submitted);

    try {
      const packedPixelBytes = debouncedPackedBytes;

      const data = encodeFunctionData({
        abi: PixelNFTABI,
        functionName: "mint",
        args: [name.trim(), BigInt(gridSize), packedPixelBytes],
      });

      const client = wcClient ?? publicClient;
      const [estimatedGas, latestBlock] = await Promise.all([
        client.estimateContractGas({
          account: address,
          address: PIXEL_NFT_CONTRACT_ADDRESS,
          abi: PixelNFTABI,
          functionName: "mint",
          args: [name.trim(), BigInt(gridSize), packedPixelBytes],
        }),
        client.getBlock(),
      ]);
      const gasLimit = estimatedGas + estimatedGas / 5n + 100_000n;
      const safeBlockLimit = (latestBlock.gasLimit * 9n) / 10n;
      if (gasLimit > safeBlockLimit) {
        throw new Error("Artwork is too complex to mint within the current block gas limit");
      }

      const hash = await sendTransactionAsync({
        to: PIXEL_NFT_CONTRACT_ADDRESS,
        value: 0n,
        data,
        gas: gasLimit,
      });

      setTxHash(hash);

      toastIdsRef.current.submitted = toast.show({
        title: "Transaction submitted",
        description: "Waiting for confirmation on LitVM…",
        kind: "info",
        duration: TX_TOAST_DURATION,
        href: getMarketplaceTxUrl(hash),
        hrefLabel: "View on Explorer",
      });
    } catch (err: unknown) {
      releaseAction(mintLockRef);
      const normalized = normalizeError(err);
      console.error("Mint error:", err);
      toast.show({
        title: normalized.title,
        description: normalized.description,
        kind: normalized.kind,
      });
    } finally {
      setIsLoading(false);
    }
  }, [
    isConnected,
    address,
    name,
    hasDrawing,
    isOriginal,
    gridSize,
    wcClient,
    sendTransactionAsync,
    pixelData,
    isCanvasUpdating,
    debouncedPackedBytes,
    toast,
    chainId,
    switchChain,
  ]);

  const canMint =
    !isLoading &&
    !isConfirming &&
    !isCanvasUpdating &&
    !!name.trim() &&
    hasDrawing &&
    debouncedPackedBytes !== "0x" &&
    isOriginal === true;

  const gridByteSize = useMemo(() => {
    const pixels = gridSize * gridSize;
    return ((pixels * 7) / 1024).toFixed(1);
  }, [gridSize]);

  if (!mounted) {
    return (
      <div className="pixel-panel flex h-32 items-center justify-center p-4" role="status" aria-label="Mint panel loading">
        <PixelLoadingIndicator compact />
      </div>
    );
  }

  return (
    <div className="bg-[#1A1A2E] rounded-2xl border border-[#2D2D44] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#2D2D44]">
        <h3
          className="text-white font-bold text-sm"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          MINT YOUR ARTWORK
        </h3>
      </div>

      <div className="p-3 sm:p-4 space-y-4">
        <div
          className="relative rounded-xl overflow-hidden border"
          style={{
            background: "#0F0F23",
            aspectRatio: "1 / 1",
            borderColor: hasDrawing
              ? "rgba(99,102,241,0.15)"
              : "rgba(255,255,255,0.05)",
          }}
        >
          {hasDrawing && previewBase64 ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={`data:image/png;base64,${previewBase64}`}
              alt="NFT Preview"
              className="w-full h-full object-contain"
              style={{ imageRendering: "pixelated" }}
            />
          ) : hasDrawing ? (
            <div className="grid h-full w-full place-items-center" aria-label="Preparing preview">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-white/70" />
            </div>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
              <svg
                width="40"
                height="40"
                fill="none"
                stroke="rgba(255,255,255,0.1)"
                strokeWidth="1"
                viewBox="0 0 24 24"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M9 21V9" />
              </svg>
              <p
                className="text-[#374151] text-[10px] text-center px-4"
                style={{ fontFamily: "var(--font-departure)" }}
              >
                Draw something to see preview
              </p>
            </div>
          )}
          {hasDrawing ? (
            <div className="absolute top-2 right-2 flex items-center gap-1.5">
              {isCheckingOriginal ? (
                <span
                  className="flex items-center gap-1 text-[9px] px-2 py-1 rounded-md bg-black/40 text-indigo-300"
                  style={{ fontFamily: "var(--font-departure)" }}
                >
                  <span className="w-2.5 h-2.5 border border-indigo-400/50 border-t-indigo-400 rounded-full animate-spin" />
                  CHECKING
                </span>
              ) : isOriginal === false ? (
                <span
                  className="text-[9px] px-2 py-1 rounded-md bg-red-500/20 text-red-300 border border-red-500/30 font-bold"
                  style={{ fontFamily: "var(--font-departure)" }}
                >
                  TAKEN
                </span>
              ) : (
                <span
                  className="text-[9px] px-2 py-1 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold"
                  style={{ fontFamily: "var(--font-departure)" }}
                >
                  ORIGINAL
                </span>
              )}
            </div>
          ) : null}
        </div>

        <div
          className="flex items-center justify-between text-[11px]"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          <div className="flex items-center gap-1">
            <span className="text-[#64748B]">Grid:</span>
            <span className="text-white font-medium">
              {gridSize}x{gridSize}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[#64748B]">Size:</span>
            <span className="text-white font-medium">~{gridByteSize} KB</span>
          </div>
        </div>

        <div className="h-px bg-[#2D2D44]" />

        {!isConnected ? (
          <div className="flex items-center gap-3 py-1">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
              <svg
                width="16"
                height="16"
                fill="none"
                stroke="#6366F1"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7" />
                <path d="M16 16l2 2 4-4" />
              </svg>
            </div>
            <p className="text-[#64748B] text-sm">Connect wallet to mint</p>
          </div>
        ) : (
          <>
            <div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 32))}
                placeholder="Artwork name"
                maxLength={32}
                className="w-full bg-[#1A1A2E] border border-[#2D2D44] rounded-xl px-3.5 py-3 sm:py-2.5 text-white placeholder-[#374151] focus:outline-none focus:border-indigo-500/50 transition-all text-sm"
                style={{ fontFamily: "var(--font-departure)" }}
              />
            </div>

            <div>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 256))}
                placeholder="Description (optional, not stored on-chain)"
                maxLength={256}
                rows={2}
                className="w-full bg-[#1A1A2E] border border-[#2D2D44] rounded-xl px-3.5 py-3 sm:py-2.5 text-white placeholder-[#374151] focus:outline-none focus:border-indigo-500/50 transition-all resize-none text-sm"
                style={{ fontFamily: "var(--font-departure)" }}
              />
            </div>

            <PixelButton
              variant="indigo"
              onClick={handleMint}
              disabled={!canMint}
              loading={isLoading || isConfirming || isCheckingOriginal}
              className="w-full justify-center py-3"
            >
              {isConfirming
                ? "CONFIRMING..."
                : isCheckingOriginal
                ? "CHECKING..."
                : isOriginal === false
                ? "ALREADY MINTED"
                : !hasDrawing
                ? "DRAW FIRST"
                : !name.trim()
                ? "ENTER NAME"
                : (
                  <>
                    <svg
                      width="13"
                      height="13"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      style={{
                        display: "inline",
                        verticalAlign: "middle",
                        marginRight: 6,
                      }}
                    >
                      <path d="M12 2L2 7l10 5 10-5-10-5z" />
                      <path d="M2 17l10 5 10-5" />
                      <path d="M2 12l10 5 10-5" />
                    </svg>
                    MINT NFT
                  </>
                )}
            </PixelButton>
          </>
        )}
      </div>
    </div>
  );
});
