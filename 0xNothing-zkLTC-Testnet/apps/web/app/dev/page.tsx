"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  Coin,
  Gauge,
  LockKey,
  ShieldCheck,
  Warning,
  Wallet,
  XCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useReadContracts,
  useSimulateContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { deployment, explorerAddressUrl } from "@fi/config/deployment";
import { dexFactoryAbi, dexPoolAbi, dexRouterAbi } from "@fi/lib/abis/dex";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { lendingPoolAbi } from "@fi/lib/abis/lending";
import { nusdAbi, pumpGraduationControllerAbi, zeroXPumpAbi } from "@/features/pump/abis";
import { litvm } from "@/config/wagmi";
import { PIXEL_MARKETPLACE_ADDRESS, PIXEL_NFT_ADDRESS, PUMP_GRADUATION_CONTROLLER_ADDRESS } from "@/lib/publicConfig";
import { PixelNFTABI } from "@/lib/abi";
import { publicClient } from "@/lib/contract";
import { STEADY_LIVE_MS } from "@/lib/liveData";
import { jitteredPollInterval } from "@/lib/pollJitter";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { parseAmount } from "@fi/lib/format";
import styles from "./dev.module.css";

const WAD = 18;
/**
 * One shared cadence for every scalar diagnostic read on this page. The old 6 s
 * literal on each of them polled faster than the 10 s block time, so a third of
 * the requests could only ever re-read a block this page had already seen, and
 * it was the last un-jittered interval in the app. Aligning them is deliberate:
 * the transport in lib/wagmi.ts batches with a 10 ms window, so reads that tick
 * together leave as one JSON-RPC batch instead of several.
 */
const DEV_POLL_MS = jitteredPollInterval("dev-diagnostics", STEADY_LIVE_MS);
const TOKEN_METADATA_STALE_MS = 60 * 60 * 1000;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const CANONICAL_FI_ASSET_ADDRESSES = new Set(
  [deployment.contracts.nusd, deployment.contracts.wzkltc, deployment.contracts.nbtc, deployment.contracts.neth]
    .filter((asset): asset is Address => Boolean(asset))
    .map((asset) => asset.toLowerCase()),
);

type RefreshDomain = "pump" | "fi" | "lending" | "pixel";

function shortAddress(value?: string) {
  if (!value) return "Not connected";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function amount(value?: bigint, symbol = "NUSD", decimals = WAD) {
  if (value === undefined) return "Loading";
  return `${Number(formatUnits(value, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbol}`;
}

function basisPoints(value?: bigint) {
  if (value === undefined) return "Loading";
  return `${Number(value) / 100}%`;
}

function sameAddress(a?: string, b?: string) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function batchNeedsRetry(value: unknown, expectedLength: number) {
  if (!Array.isArray(value) || value.length !== expectedLength) return true;
  return value.some((read) => !read || typeof read !== "object" || (read as { status?: string }).status !== "success");
}

function friendlyActionError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("user rejected") || message.includes("user denied") || message.includes("4001")) return "Signing was cancelled in the wallet.";
  if (message.includes("insufficient funds")) return "The connected wallet does not have enough native gas or token balance.";
  if (message.includes("unauthorized") || message.includes("onlyadmin") || message.includes("only owner")) return "The connected wallet is not authorized for this contract action.";
  if (message.includes("simulation") || message.includes("revert")) return "The contract simulation rejected this action. Verify the amount, role, destination and current pool state.";
  return "The wallet or RPC rejected this action. Verify the network and try again.";
}

function Metric({
  label,
  value,
  note,
  icon,
  accent = false,
  loading = false,
}: {
  label: string;
  value?: string;
  note?: string;
  icon: React.ReactNode;
  accent?: boolean;
  loading?: boolean;
}) {
  return (
    <div className={`${styles.card} ${accent ? styles.cardAccent : ""}`}>
      <div className={styles.cardTop}><span>{label}</span>{icon}</div>
      {loading ? <span className={styles.skeleton} aria-label="Loading" /> : <strong className={`${styles.value} ${accent ? styles.valueAccent : ""}`}>{value ?? "Unavailable"}</strong>}
      <span className={styles.subvalue}>{note ?? "Live RPC read"}</span>
    </div>
  );
}

export default function DevPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const switchChain = useSwitchChain();
  const { writeContractAsync, isPending: isWriting } = useWriteContract();
  const writeLockRef = useRef(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [fiWithdrawAmount, setFiWithdrawAmount] = useState("");
  const [fiWithdrawToken, setFiWithdrawToken] = useState("nusd");
  const [lendingWithdrawAmount, setLendingWithdrawAmount] = useState("");
  const [confirmPumpWithdrawal, setConfirmPumpWithdrawal] = useState(false);
  const [confirmFiWithdrawal, setConfirmFiWithdrawal] = useState(false);
  const [confirmLendingWithdrawal, setConfirmLendingWithdrawal] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [actionSuccess, setActionSuccess] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [txDomain, setTxDomain] = useState<RefreshDomain | undefined>();
  const txReceipt = useWaitForTransactionReceipt({ chainId: litvm.id, hash: txHash });

  const nusd = deployment.contracts.nusd;
  const pump = deployment.contracts.pump;
  const dexRouter = deployment.contracts.dexRouter;
  const dexFactory = deployment.contracts.dexFactory;
  const lendingPool = deployment.contracts.lendingPool;
  const pumpController = deployment.contracts.pumpGraduationController ?? PUMP_GRADUATION_CONTROLLER_ADDRESS;

  const pumpAdmin = useReadContract({ chainId: litvm.id, address: pump, abi: zeroXPumpAbi, functionName: "admin", query: { enabled: Boolean(pump), refetchInterval: DEV_POLL_MS } });
  const controllerGovernance = useReadContract({ chainId: litvm.id, address: pumpController, abi: pumpGraduationControllerAbi, functionName: "governance", query: { enabled: Boolean(pumpController && pump), refetchInterval: DEV_POLL_MS } });
  const controllerPump = useReadContract({ chainId: litvm.id, address: pumpController, abi: pumpGraduationControllerAbi, functionName: "pump", query: { enabled: Boolean(pumpController && pump), refetchInterval: DEV_POLL_MS } });
  const pumpFees = useReadContract({ chainId: litvm.id, address: pump, abi: zeroXPumpAbi, functionName: "accruedProtocolFeesNusd", query: { enabled: Boolean(pump), refetchInterval: DEV_POLL_MS } });
  const pumpTradeFee = useReadContract({ chainId: litvm.id, address: pump, abi: zeroXPumpAbi, functionName: "tradeFeeBps", query: { enabled: Boolean(pump), refetchInterval: DEV_POLL_MS } });
  const pumpCreateFee = useReadContract({ chainId: litvm.id, address: pump, abi: zeroXPumpAbi, functionName: "createFee", query: { enabled: Boolean(pump), refetchInterval: DEV_POLL_MS } });
  const pumpMarkets = useReadContract({ chainId: litvm.id, address: pump, abi: zeroXPumpAbi, functionName: "totalMarkets", query: { enabled: Boolean(pump), refetchInterval: DEV_POLL_MS } });
  const pumpNusdBalance = useReadContract({ chainId: litvm.id, address: nusd, abi: nusdAbi, functionName: "balanceOf", args: pump ? [pump] : undefined, query: { enabled: Boolean(nusd && pump), refetchInterval: DEV_POLL_MS } });

  const fiLpFee = useReadContract({ chainId: litvm.id, address: dexRouter, abi: dexRouterAbi, functionName: "LP_FEE_BPS", query: { enabled: Boolean(dexRouter), refetchInterval: DEV_POLL_MS } });
  const fiRouteFee = useReadContract({ chainId: litvm.id, address: dexRouter, abi: dexRouterAbi, functionName: "ROUTE_SURCHARGE_BPS", query: { enabled: Boolean(dexRouter), refetchInterval: DEV_POLL_MS } });
  const fiFactoryOwner = useReadContract({ chainId: litvm.id, address: dexFactory, abi: dexFactoryAbi, functionName: "owner", query: { enabled: Boolean(dexFactory), refetchInterval: DEV_POLL_MS } });
  const fiRouterFactory = useReadContract({ chainId: litvm.id, address: dexRouter, abi: dexRouterAbi, functionName: "factory", query: { enabled: Boolean(dexRouter), refetchInterval: DEV_POLL_MS } });
  const fiPairCount = useReadContract({ chainId: litvm.id, address: dexFactory, abi: dexFactoryAbi, functionName: "allPairsLength", query: { enabled: Boolean(dexFactory), refetchInterval: 15000 } });
  const fiPairIndexes = useMemo(() => {
    const count = fiPairCount.data === undefined ? 0 : Number(fiPairCount.data);
    return Array.from({ length: Math.min(Number.isSafeInteger(count) ? count : 0, 256) }, (_, index) => BigInt(index));
  }, [fiPairCount.data]);
  const fiPairAddressContracts = useMemo(
    () => fiPairIndexes.map((index) => ({ chainId: litvm.id, address: dexFactory as Address, abi: dexFactoryAbi, functionName: "allPairs" as const, args: [index] as const })),
    [dexFactory, fiPairIndexes],
  );
  const fiPairAddresses = useReadContracts({
    contracts: fiPairAddressContracts,
    query: {
      enabled: Boolean(dexFactory && fiPairIndexes.length),
      staleTime: Infinity,
      refetchInterval: (query) => batchNeedsRetry(query.state.data, fiPairAddressContracts.length) ? 15_000 : false,
    },
  });
  const fiPairs = useMemo(() => fiPairAddresses.data?.flatMap((read) => read.status === "success" && typeof read.result === "string" && isAddress(read.result) ? [getAddress(read.result)] : []) ?? [], [fiPairAddresses.data]);
  const fiPairTokenContracts = useMemo(() => fiPairs.flatMap((pair) => [
    { chainId: litvm.id, address: pair, abi: dexPoolAbi, functionName: "token0" as const },
    { chainId: litvm.id, address: pair, abi: dexPoolAbi, functionName: "token1" as const },
  ]), [fiPairs]);
  const fiPairTokens = useReadContracts({
    contracts: fiPairTokenContracts,
    query: {
      enabled: fiPairs.length > 0,
      staleTime: Infinity,
      refetchInterval: (query) => batchNeedsRetry(query.state.data, fiPairTokenContracts.length) ? 15_000 : false,
    },
  });
  const fiDiscoveredAssets = useMemo(() => {
    const assets = fiPairTokens.data?.flatMap((read) => read.status === "success" && typeof read.result === "string" && isAddress(read.result) ? [getAddress(read.result)] : []) ?? [];
    return Array.from(new Set(assets));
  }, [fiPairTokens.data]);
  const fiDynamicAssets = useMemo(
    () => fiDiscoveredAssets.filter((asset) => !CANONICAL_FI_ASSET_ADDRESSES.has(asset.toLowerCase())),
    [fiDiscoveredAssets],
  );
  const fiDiscoveredAssetMetadataContracts = useMemo(() => fiDynamicAssets.flatMap((asset) => [
    { chainId: litvm.id, address: asset, abi: erc20Abi, functionName: "symbol" as const },
    { chainId: litvm.id, address: asset, abi: erc20Abi, functionName: "decimals" as const },
  ]), [fiDynamicAssets]);
  const fiDiscoveredAssetMetadata = useReadContracts({
    contracts: fiDiscoveredAssetMetadataContracts,
    query: {
      enabled: fiDynamicAssets.length > 0,
      staleTime: TOKEN_METADATA_STALE_MS,
      refetchInterval: (query) => batchNeedsRetry(query.state.data, fiDiscoveredAssetMetadataContracts.length) ? 60_000 : false,
    },
  });
  const fiDiscoveredAssetLiveContracts = useMemo(() => fiDynamicAssets.flatMap((asset) => [
    { chainId: litvm.id, address: dexRouter as Address, abi: dexRouterAbi, functionName: "accruedRouterFees" as const, args: [asset] as const },
    { chainId: litvm.id, address: asset, abi: erc20Abi, functionName: "balanceOf" as const, args: [dexRouter as Address] as const },
  ]), [dexRouter, fiDynamicAssets]);
  const fiDiscoveredAssetLiveReads = useReadContracts({
    contracts: fiDiscoveredAssetLiveContracts,
    query: { enabled: Boolean(dexRouter && fiDynamicAssets.length), refetchInterval: DEV_POLL_MS },
  });
  const fiNusdFees = useReadContract({ chainId: litvm.id, address: dexRouter, abi: dexRouterAbi, functionName: "accruedRouterFees", args: nusd ? [nusd] : undefined, query: { enabled: Boolean(dexRouter && nusd), refetchInterval: DEV_POLL_MS } });
  const fiNusdRouterBalance = useReadContract({ chainId: litvm.id, address: nusd, abi: nusdAbi, functionName: "balanceOf", args: dexRouter ? [dexRouter] : undefined, query: { enabled: Boolean(dexRouter && nusd), refetchInterval: DEV_POLL_MS } });
  const fiWzkLtcFees = useReadContract({ chainId: litvm.id, address: dexRouter, abi: dexRouterAbi, functionName: "accruedRouterFees", args: deployment.contracts.wzkltc ? [deployment.contracts.wzkltc] : undefined, query: { enabled: Boolean(dexRouter && deployment.contracts.wzkltc), refetchInterval: DEV_POLL_MS } });
  const fiWzkLtcRouterBalance = useReadContract({ chainId: litvm.id, address: deployment.contracts.wzkltc, abi: erc20Abi, functionName: "balanceOf", args: dexRouter ? [dexRouter] : undefined, query: { enabled: Boolean(dexRouter && deployment.contracts.wzkltc), refetchInterval: DEV_POLL_MS } });
  const fiNbtcFees = useReadContract({ chainId: litvm.id, address: dexRouter, abi: dexRouterAbi, functionName: "accruedRouterFees", args: deployment.contracts.nbtc ? [deployment.contracts.nbtc] : undefined, query: { enabled: Boolean(dexRouter && deployment.contracts.nbtc), refetchInterval: DEV_POLL_MS } });
  const fiNbtcRouterBalance = useReadContract({ chainId: litvm.id, address: deployment.contracts.nbtc, abi: erc20Abi, functionName: "balanceOf", args: dexRouter ? [dexRouter] : undefined, query: { enabled: Boolean(dexRouter && deployment.contracts.nbtc), refetchInterval: DEV_POLL_MS } });
  const fiNethFees = useReadContract({ chainId: litvm.id, address: dexRouter, abi: dexRouterAbi, functionName: "accruedRouterFees", args: deployment.contracts.neth ? [deployment.contracts.neth] : undefined, query: { enabled: Boolean(dexRouter && deployment.contracts.neth), refetchInterval: DEV_POLL_MS } });
  const fiNethRouterBalance = useReadContract({ chainId: litvm.id, address: deployment.contracts.neth, abi: erc20Abi, functionName: "balanceOf", args: dexRouter ? [dexRouter] : undefined, query: { enabled: Boolean(dexRouter && deployment.contracts.neth), refetchInterval: DEV_POLL_MS } });
  const lendingOwner = useReadContract({ chainId: litvm.id, address: lendingPool, abi: lendingPoolAbi, functionName: "owner", query: { enabled: Boolean(lendingPool), refetchInterval: DEV_POLL_MS } });
  const lendingInterest = useReadContract({ chainId: litvm.id, address: lendingPool, abi: lendingPoolAbi, functionName: "protocolInterestNusd", query: { enabled: Boolean(lendingPool), refetchInterval: DEV_POLL_MS } });
  const lendingNusdBalance = useReadContract({ chainId: litvm.id, address: nusd, abi: nusdAbi, functionName: "balanceOf", args: lendingPool ? [lendingPool] : undefined, query: { enabled: Boolean(nusd && lendingPool), refetchInterval: DEV_POLL_MS } });

  const pixelDevWallet = useReadContract({ chainId: litvm.id, address: PIXEL_NFT_ADDRESS, abi: PixelNFTABI, functionName: "devWallet", query: { refetchInterval: DEV_POLL_MS } });
  const pixelPending = useReadContract({ chainId: litvm.id, address: PIXEL_NFT_ADDRESS, abi: PixelNFTABI, functionName: "pendingWithdrawals", args: address ? [address] : undefined, query: { enabled: Boolean(address), refetchInterval: DEV_POLL_MS } });
  const pixelBalance = useBalance({ chainId: litvm.id, address: PIXEL_NFT_ADDRESS, query: { refetchInterval: DEV_POLL_MS } });

  const controllerOwnsPump = Boolean(pumpAdmin.data && sameAddress(pumpAdmin.data, pumpController));
  const controllerMatchesPump = Boolean(pump && controllerOwnsPump && controllerPump.data && sameAddress(controllerPump.data, pump));
  const pumpAuthority = controllerOwnsPump && controllerMatchesPump ? controllerGovernance.data : pumpAdmin.data;
  const pumpAdminMismatch = Boolean(pumpAuthority && address && !sameAddress(address, pumpAuthority));
  const onExpectedChain = chainId === litvm.id;
  const pumpReady = Boolean(pump && nusd);
  const fiReady = Boolean(dexRouter && nusd && dexFactory && fiRouterFactory.data && sameAddress(fiRouterFactory.data, dexFactory));

  const refreshTransactionDomain = useCallback((domain: RefreshDomain | undefined) => {
    let refetches: Array<() => Promise<unknown>> = [];
    if (domain === "pump") {
      refetches = [pumpFees.refetch, pumpNusdBalance.refetch];
    } else if (domain === "fi") {
      refetches = [fiDiscoveredAssetLiveReads.refetch, fiNusdFees.refetch, fiNusdRouterBalance.refetch, fiWzkLtcFees.refetch, fiWzkLtcRouterBalance.refetch, fiNbtcFees.refetch, fiNbtcRouterBalance.refetch, fiNethFees.refetch, fiNethRouterBalance.refetch];
    } else if (domain === "lending") {
      refetches = [lendingInterest.refetch, lendingNusdBalance.refetch];
    } else if (domain === "pixel") {
      refetches = [pixelPending.refetch, pixelBalance.refetch];
    }
    void Promise.allSettled(refetches.map((refetch) => refetch()));
  }, [pumpFees.refetch, pumpNusdBalance.refetch, fiDiscoveredAssetLiveReads.refetch, fiNusdFees.refetch, fiNusdRouterBalance.refetch, fiWzkLtcFees.refetch, fiWzkLtcRouterBalance.refetch, fiNbtcFees.refetch, fiNbtcRouterBalance.refetch, fiNethFees.refetch, fiNethRouterBalance.refetch, lendingInterest.refetch, lendingNusdBalance.refetch, pixelPending.refetch, pixelBalance.refetch]);

  useEffect(() => {
    if (!txHash) return;
    if (txReceipt.isError) {
      releaseAction(writeLockRef);
      setTxHash(undefined);
      setTxDomain(undefined);
      setActionSuccess(undefined);
      setActionError("Transaction receipt could not be confirmed by the LitVM RPC. Verify it in the explorer before retrying.");
      return;
    }
    if (!txReceipt.data?.status || txReceipt.data.transactionHash !== txHash) return;
    releaseAction(writeLockRef);
    setTxHash(undefined);
    setTxDomain(undefined);
    if (txReceipt.data.status === "reverted") {
      setActionSuccess(undefined);
      setActionError("Transaction reverted on LitVM testnet. No protocol state was changed.");
      return;
    }
    setActionError(undefined);
    setActionSuccess("Transaction confirmed on LitVM testnet.");
    setConfirmPumpWithdrawal(false);
    setConfirmFiWithdrawal(false);
    setConfirmLendingWithdrawal(false);
    refreshTransactionDomain(txDomain);
  }, [refreshTransactionDomain, txDomain, txHash, txReceipt.data, txReceipt.isError]);

  async function submitContractWrite(request: Parameters<typeof writeContractAsync>[0], domain: RefreshDomain) {
    if (!tryAcquireAction(writeLockRef)) return;
    setActionError(undefined);
    setActionSuccess(undefined);
    try {
      if (!address) throw new Error("Connect the governance wallet before signing.");
      const simulation = await publicClient.simulateContract({ ...request, account: address, chainId: litvm.id } as never);
      const hash = await writeContractAsync(simulation.request as unknown as Parameters<typeof writeContractAsync>[0]);
      setTxDomain(domain);
      setTxHash(hash);
    } catch (error) {
      releaseAction(writeLockRef);
      setActionError(friendlyActionError(error));
    }
  }

  const validWithdrawAmount = useMemo(() => parseAmount(withdrawAmount, WAD) ?? 0n, [withdrawAmount]);
  const validLendingWithdrawAmount = useMemo(() => parseAmount(lendingWithdrawAmount, WAD) ?? 0n, [lendingWithdrawAmount]);
  const isPumpAdmin = Boolean(address && pumpAuthority && sameAddress(address, pumpAuthority));
  const isFiOwner = Boolean(address && fiFactoryOwner.data && sameAddress(address, fiFactoryOwner.data));
  const isLendingOwner = Boolean(address && lendingOwner.data && sameAddress(address, lendingOwner.data));
  const isPixelDev = Boolean(address && pixelDevWallet.data && sameAddress(address, pixelDevWallet.data));
  const disableControls = !isConnected || !onExpectedChain || isWriting || Boolean(txHash);
  const canonicalFiFeeOptions = useMemo(() => [
    { key: "nusd", label: "NUSD", address: nusd, data: fiNusdFees.data, balance: fiNusdRouterBalance.data, decimals: WAD },
    { key: "wzkltc", label: "wzkLTC", address: deployment.contracts.wzkltc, data: fiWzkLtcFees.data, balance: fiWzkLtcRouterBalance.data, decimals: WAD },
    { key: "nbtc", label: "nBTC", address: deployment.contracts.nbtc, data: fiNbtcFees.data, balance: fiNbtcRouterBalance.data, decimals: WAD },
    { key: "neth", label: "nETH", address: deployment.contracts.neth, data: fiNethFees.data, balance: fiNethRouterBalance.data, decimals: WAD },
  ] as const, [nusd, fiNusdFees.data, fiNusdRouterBalance.data, fiWzkLtcFees.data, fiWzkLtcRouterBalance.data, fiNbtcFees.data, fiNbtcRouterBalance.data, fiNethFees.data, fiNethRouterBalance.data]);
  const discoveredFiFeeOptions = useMemo(() => {
    const options: Array<{ key: string; label: string; address: Address; data?: bigint; balance?: bigint; decimals: number }> = [];
    for (let index = 0; index < fiDynamicAssets.length; index += 1) {
      const offset = index * 2;
      const symbolRead = fiDiscoveredAssetMetadata.data?.[offset];
      const decimalsRead = fiDiscoveredAssetMetadata.data?.[offset + 1];
      const feeRead = fiDiscoveredAssetLiveReads.data?.[offset];
      const balanceRead = fiDiscoveredAssetLiveReads.data?.[offset + 1];
      const symbol = symbolRead?.status === "success" && typeof symbolRead.result === "string" ? symbolRead.result.trim() : "";
      const decimals = decimalsRead?.status === "success" && typeof decimalsRead.result === "number" ? decimalsRead.result : -1;
      const fee = feeRead?.status === "success" && typeof feeRead.result === "bigint" ? feeRead.result : undefined;
      const balance = balanceRead?.status === "success" && typeof balanceRead.result === "bigint" ? balanceRead.result : undefined;
      const address = fiDynamicAssets[index];
      if (!address || !symbol || symbol.length > 24 || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 || fee === undefined || balance === undefined) continue;
      options.push({ key: address.toLowerCase(), label: symbol, address, data: fee, balance, decimals });
    }
    return options;
  }, [fiDynamicAssets, fiDiscoveredAssetMetadata.data, fiDiscoveredAssetLiveReads.data]);
  const fiFeeOptions = useMemo(() => [...canonicalFiFeeOptions, ...discoveredFiFeeOptions], [canonicalFiFeeOptions, discoveredFiFeeOptions]);
  const selectedFiFee = useMemo(() => fiFeeOptions.find((item) => item.key === fiWithdrawToken), [fiFeeOptions, fiWithdrawToken]);
  const selectedFiMax = selectedFiFee?.data !== undefined && selectedFiFee.balance !== undefined
    ? (selectedFiFee.data < selectedFiFee.balance ? selectedFiFee.data : selectedFiFee.balance)
    : 0n;
  const selectedFiDecimals = selectedFiFee?.decimals ?? WAD;
  const validFiWithdrawAmount = useMemo(() => parseAmount(fiWithdrawAmount, selectedFiDecimals) ?? 0n, [fiWithdrawAmount, selectedFiDecimals]);
  const lendingMax = lendingInterest.data !== undefined && lendingNusdBalance.data !== undefined
    ? (lendingInterest.data < lendingNusdBalance.data ? lendingInterest.data : lendingNusdBalance.data)
    : 0n;
  const lendingSimulation = useSimulateContract({
    chainId: litvm.id,
    address: lendingPool,
    abi: lendingPoolAbi,
    functionName: "withdrawProtocolInterest",
    args: [validLendingWithdrawAmount, address || ZERO],
    query: { enabled: Boolean(onExpectedChain && lendingPool && address && isLendingOwner && validLendingWithdrawAmount > 0n && validLendingWithdrawAmount <= lendingMax) },
  });
  const pumpWithdrawTarget = controllerOwnsPump ? pumpController : pump;
  const pumpWithdrawAbi = controllerOwnsPump ? pumpGraduationControllerAbi : zeroXPumpAbi;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/">
            <span className={styles.brandMark}>0x</span>
            <span className={styles.brandText}><strong>0xNothing</strong><span>Developer console</span></span>
          </Link>
          <div className={styles.headerActions}>
            <span className={styles.network}><span className={styles.networkDot} />{onExpectedChain ? "LitVM testnet" : `Chain ${chainId || "unknown"}`}</span>
            <span className={styles.address}>{shortAddress(address)}</span>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>Operator surface / testnet</span>
            <h1>Control the rails.<br />Read every balance.</h1>
            <p>Live contract reads for 0xPump and 0xFi. Actions are shown only when the connected wallet and deployed ABI support them.</p>
          </div>
          <div className={styles.heroAside}>
            <span className={styles.eyebrow}>Safety boundary</span>
            <strong>Client gating is not contract security.</strong>
            <p>Every write is still authorized by the deployed contract. Verify the destination and network in your wallet before signing.</p>
          </div>
        </section>

        {!isConnected ? (
          <div className={styles.banner}><Wallet size={17} weight="bold" /><span>Connect a wallet to unlock operator context. This page never reads a private key and cannot bypass onchain authorization.</span><ConnectWalletButton className={styles.button} label="Connect wallet" /></div>
        ) : !onExpectedChain ? (
          <div className={`${styles.banner} ${styles.bannerError}`}><Warning size={17} weight="bold" /><span>Wrong network. Switch to LitVM LiteForge (chain {litvm.id}) before signing an action. Reads may be unavailable until you switch.</span><button className={styles.button} onClick={() => switchChain.mutate({ chainId: litvm.id })} disabled={switchChain.isPending}>{switchChain.isPending ? "Switching" : "Switch network"}</button></div>
        ) : null}

        {actionError ? <div className={`${styles.banner} ${styles.bannerError}`}><XCircle size={17} weight="bold" /><span>{actionError}</span></div> : null}
        {actionSuccess ? <div className={styles.banner}><CheckCircle size={17} weight="bold" /><span>{actionSuccess}</span></div> : null}
        {txHash ? <div className={styles.banner}><CircleNotch size={17} weight="bold" className="animate-spin" /><span>Transaction pending. <a className={styles.monoLink} href={`${deployment.chain.explorerUrl}/tx/${txHash}`} target="_blank" rel="noreferrer">View on explorer <ArrowSquareOut size={12} /></a></span></div> : null}

        <section className={styles.section}>
          <div className={styles.sectionHeader}><div><span className={styles.eyebrow}>Protocol revenue</span><h2>Where fees sit</h2></div><p className={styles.sectionNote}>Only balances and withdrawal methods exposed by the published ABIs appear here.</p></div>
          <div className={`${styles.grid} ${styles.gridThree}`}>
            <div className={styles.card + " " + styles.formCard}>
              <div className={styles.cardTop}><span>0xPump</span><Coin size={16} /></div>
              {!pumpReady ? <div className={styles.empty}><strong>Not published</strong><p>0xPump address is absent from the testnet manifest.</p></div> : <><strong className={styles.value}>{amount(pumpFees.data as bigint | undefined)}</strong><span className={styles.subvalue}>Accrued protocol fees</span><span className={styles.address}>NUSD held: {amount(pumpNusdBalance.data as bigint | undefined)}<br />Trade fee: {basisPoints(pumpTradeFee.data as bigint | undefined)} · Create fee: {amount(pumpCreateFee.data as bigint | undefined)}<br />Markets: {pumpMarkets.data === undefined ? "Loading" : String(pumpMarkets.data)}<br />Authority: {shortAddress(pumpAuthority as string | undefined)}{controllerOwnsPump ? " via graduation controller" : " direct"}</span><div className={styles.field}><label htmlFor="withdraw-amount">Admin withdrawal amount</label><input id="withdraw-amount" inputMode="decimal" value={withdrawAmount} onChange={(event) => { setWithdrawAmount(event.target.value); setConfirmPumpWithdrawal(false); }} placeholder="0" /></div><label className={styles.checkbox}><input type="checkbox" checked={confirmPumpWithdrawal} onChange={(event) => setConfirmPumpWithdrawal(event.target.checked)} />I verified the recipient is this connected authority wallet.</label><button className={`${styles.button} ${styles.buttonDanger}`} disabled={disableControls || !isPumpAdmin || !pumpWithdrawTarget || validWithdrawAmount === 0n || !confirmPumpWithdrawal || (pumpFees.data as bigint | undefined ?? 0n) < validWithdrawAmount} onClick={() => submitContractWrite({ address: pumpWithdrawTarget || ZERO, abi: pumpWithdrawAbi, functionName: "withdrawProtocolFees", args: [address || ZERO, validWithdrawAmount] }, "pump")}>Withdraw Pump fees</button>{pumpAdminMismatch ? <span className={styles.subvalue}>Authority required: {shortAddress(pumpAuthority as string | undefined)}</span> : null}</>}
            </div>
            <div className={styles.card + " " + styles.formCard}>
              <div className={styles.cardTop}><span>0xFi router</span><Gauge size={16} /></div>
              {!fiReady ? <div className={styles.empty}><strong>Router address missing</strong><p>Fee reads stay unavailable until the testnet manifest publishes the DEX router.</p></div> : <><strong className={styles.value}>{amount(fiNusdRouterBalance.data as bigint | undefined)}</strong><span className={styles.subvalue}>NUSD currently held by router</span><span className={styles.address}>LP fee: {basisPoints(fiLpFee.data as bigint | undefined)}<br />Router fee: 0.1% direct · 0.2% multihop<br />Multihop surcharge: {basisPoints(fiRouteFee.data as bigint | undefined)} once per routed path</span><div className={styles.address}>Accrued fee ledger<br />{fiFeeOptions.map((item) => <span key={item.key}>{item.label} ({shortAddress(item.address)}): {amount(item.data as bigint | undefined, item.label, item.decimals)} · balance {amount(item.balance as bigint | undefined, item.label, item.decimals)}<br /></span>)}</div><div className={styles.field}><label htmlFor="fi-token">Fee token</label><select id="fi-token" value={fiWithdrawToken} onChange={(event) => { setFiWithdrawToken(event.target.value); setConfirmFiWithdrawal(false); }}>{fiFeeOptions.map((item) => <option key={item.key} value={item.key}>{item.label} · {shortAddress(item.address)}</option>)}</select></div><div className={styles.field}><label htmlFor="fi-withdraw-amount">Withdrawal amount</label><input id="fi-withdraw-amount" inputMode="decimal" value={fiWithdrawAmount} onChange={(event) => { setFiWithdrawAmount(event.target.value); setConfirmFiWithdrawal(false); }} placeholder="0" /></div><label className={styles.checkbox}><input type="checkbox" checked={confirmFiWithdrawal} onChange={(event) => setConfirmFiWithdrawal(event.target.checked)} />I verified the token, recipient and factory owner authority before signing.</label><button className={`${styles.button} ${styles.buttonDanger}`} disabled={disableControls || !isFiOwner || !selectedFiFee?.address || validFiWithdrawAmount === 0n || !confirmFiWithdrawal || selectedFiMax < validFiWithdrawAmount} onClick={() => submitContractWrite({ address: dexRouter || ZERO, abi: dexRouterAbi, functionName: "withdrawRouterFees", args: [selectedFiFee?.address || ZERO, address || ZERO, validFiWithdrawAmount] }, "fi")}>Withdraw 0xFi fees</button>{!isFiOwner ? <span className={styles.subvalue}>Factory owner required: {shortAddress(fiFactoryOwner.data as string)}</span> : null}</>}
            </div>
            <div className={styles.card + " " + styles.formCard}>
              <div className={styles.cardTop}><span>Safe withdrawal policy</span><ShieldCheck size={16} /></div>
              <strong className={styles.value}>ABI-first</strong>
              <span className={styles.subvalue}>Available actions are restricted to real contract methods.</span>
              <p>0xPump withdrawal follows its deployed authority path. 0xFi withdrawal requires the factory owner and uses the router fee ledger per token. Every write remains subject to onchain authorization.</p>
              <div className={styles.status + " " + styles.statusGood}><span className={styles.statusDot} />No invented custody path</div>
            </div>
            <div className={styles.card + " " + styles.formCard}>
              <div className={styles.cardTop}><span>Lending interest</span><Coin size={16} /></div>
              {!lendingPool ? <div className={styles.empty}><strong>Pool not published</strong><p>Lending revenue reads stay unavailable until the testnet manifest publishes the pool.</p></div> : <><strong className={styles.value}>{amount(lendingInterest.data as bigint | undefined)}</strong><span className={styles.subvalue}>Protocol interest ledger</span><span className={styles.address}>NUSD held: {amount(lendingNusdBalance.data as bigint | undefined)}<br />Safe maximum: {amount(lendingMax)}<br />Owner: {shortAddress(lendingOwner.data as string | undefined)}</span><div className={styles.field}><label htmlFor="lending-withdraw-amount">Withdrawal amount</label><input id="lending-withdraw-amount" inputMode="decimal" value={lendingWithdrawAmount} onChange={(event) => { setLendingWithdrawAmount(event.target.value); setConfirmLendingWithdrawal(false); }} placeholder="0" /></div><label className={styles.checkbox}><input type="checkbox" checked={confirmLendingWithdrawal} onChange={(event) => setConfirmLendingWithdrawal(event.target.checked)} />I verified the NUSD recipient and lending owner authority.</label><button className={`${styles.button} ${styles.buttonDanger}`} disabled={disableControls || !isLendingOwner || validLendingWithdrawAmount === 0n || validLendingWithdrawAmount > lendingMax || !confirmLendingWithdrawal || !lendingSimulation.data} onClick={() => submitContractWrite({ address: lendingPool || ZERO, abi: lendingPoolAbi, functionName: "withdrawProtocolInterest", args: [validLendingWithdrawAmount, address || ZERO] }, "lending")}>Withdraw lending interest</button>{lendingSimulation.error ? <span className={styles.subvalue}>Simulation rejected this amount. Adjust to the safe maximum.</span> : null}{!isLendingOwner ? <span className={styles.subvalue}>Owner required: {shortAddress(lendingOwner.data as string)}</span> : null}</>}
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}><div><span className={styles.eyebrow}>Pixel and marketplace</span><h2>Direct settlement surfaces</h2></div><p className={styles.sectionNote}>Pixel claims are limited to the caller's own pending balance. Marketplace fees settle directly to its immutable dev wallet.</p></div>
          <div className={`${styles.grid} ${styles.gridThree}`}>
            <div className={styles.card + " " + styles.formCard}>
              <div className={styles.cardTop}><span>0xPixel</span><Coin size={16} /></div>
              <strong className={styles.value}>{amount(pixelPending.data as bigint | undefined, "zkLTC")}</strong>
              <span className={styles.subvalue}>Pending withdrawal for connected wallet</span>
              <span className={styles.address}>Dev wallet: {shortAddress(pixelDevWallet.data as string | undefined)}<br />Contract balance: {pixelBalance.data ? `${formatUnits(pixelBalance.data.value, pixelBalance.data.decimals)} ${pixelBalance.data.symbol}` : "Loading"}</span>
              <button className={styles.button} disabled={disableControls || !isPixelDev || (pixelPending.data as bigint | undefined ?? 0n) === 0n} onClick={() => submitContractWrite({ address: PIXEL_NFT_ADDRESS, abi: PixelNFTABI, functionName: "withdraw", args: [] }, "pixel")}>Claim own Pixel balance</button>
              {!isPixelDev ? <span className={styles.subvalue}>Only the connected dev wallet can claim its own pending balance.</span> : null}
            </div>
            <div className={styles.card + " " + styles.formCard}>
              <div className={styles.cardTop}><span>0xMarketplace</span><ShieldCheck size={16} /></div>
              <strong className={styles.value}>Direct settlement</strong>
              <span className={styles.subvalue}>No admin withdrawal action is exposed here.</span>
              <span className={styles.address}>Marketplace: {shortAddress(PIXEL_MARKETPLACE_ADDRESS)}<br />Fees are forwarded directly to the immutable dev wallet at settlement time.<br />There is no pooled fee balance for this console to claim.</span>
              <a className={styles.monoLink} href={explorerAddressUrl(PIXEL_MARKETPLACE_ADDRESS)} target="_blank" rel="noreferrer">Open marketplace <ArrowSquareOut size={12} /></a>
            </div>
            <div className={styles.card + " " + styles.formCard}>
              <div className={styles.cardTop}><span>Authority model</span><LockKey size={16} /></div>
              <strong className={styles.value}>Onchain first</strong>
              <span className={styles.subvalue}>The browser gate is UX only.</span>
              <p>Pump, 0xFi and Pixel each enforce their own authorization rules. Confirm the destination, recipient and chain in the wallet before signing.</p>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}><div><span className={styles.eyebrow}>Runbook</span><h2>Operator checks</h2></div></div>
          <div className={`${styles.grid} ${styles.gridThree}`}>
            <Metric label="Network" value={onExpectedChain ? "LitVM LiteForge" : "Wrong chain"} note={`Chain ${litvm.id}`} icon={onExpectedChain ? <CheckCircle size={16} /> : <Warning size={16} />} accent={onExpectedChain} />
            <Metric label="Wallet gate" value={isConnected ? "Connected" : "Connect wallet"} note={shortAddress(address)} icon={isConnected ? <Wallet size={16} /> : <LockKey size={16} />} accent={isConnected} />
            <Metric label="RPC refresh" value="6 seconds" note="Read-only health polling" icon={<ArrowsClockwise size={16} />} />
          </div>
        </section>
      </main>
    </div>
  );
}
