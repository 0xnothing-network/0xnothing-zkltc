"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { pumpGraduationControllerAbi, pumpGraduationRouterAbi, zeroXPumpAbi } from "@/features/pump/abis";
import { usePumpMarket } from "@/features/pump/hooks/usePumpData";
import {
  ipfsToGatewayUrl,
  PUMP_CHAIN_ID,
  PUMP_FACTORY_ADDRESS,
  PUMP_GRADUATION_ADAPTER_ADDRESS,
  PUMP_GRADUATION_ROUTER_ADDRESS,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import { formatDecimal, formatRelativeTime, formatWad, shortAddress } from "@/features/pump/format";
import type { PumpMarket } from "@/features/pump/types";
import { getAddressExplorerUrl } from "@/lib/explorer";
import { PumpChart } from "@/features/pump/components/PumpChart";
import { TradePanel } from "@/features/pump/components/TradePanel";
import { TradeHistory } from "@/features/pump/components/TradeHistory";
import { TokenHolders } from "@/features/pump/components/TokenHolders";
import { PumpConfigNotice, PumpErrorState, PumpInlineLoading } from "@/features/pump/components/PumpStates";
import { useToast } from "@/components/Toast";

interface TokenMetadata {
  description?: string;
  external_url?: string;
  properties?: { website?: string; twitter?: string };
}

function GraduationAction({ market, onComplete }: { market: PumpMarket; onComplete: () => void }) {
  const toast = useToast();
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: PUMP_CHAIN_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState(false);
  const pumpAdmin = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "admin",
    query: { enabled: market.status === "READY", refetchInterval: 10_000 },
  });
  const pumpRouter = useReadContract({
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "graduationRouter",
    query: { enabled: market.status === "READY", staleTime: Infinity },
  });
  const controllerAddress = pumpAdmin.data;
  const controllerReadEnabled = market.status === "READY" && Boolean(controllerAddress);
  const controllerPaused = useReadContract({
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "graduationsPaused",
    query: { enabled: controllerReadEnabled, refetchInterval: 10_000 },
  });
  const controllerPump = useReadContract({
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "pump",
    query: { enabled: controllerReadEnabled, staleTime: Infinity },
  });
  const controllerRouter = useReadContract({
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "router",
    query: { enabled: controllerReadEnabled, staleTime: Infinity },
  });
  const controllerAdapter = useReadContract({
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "adapter",
    query: { enabled: controllerReadEnabled, staleTime: Infinity },
  });
  const routerAdmin = useReadContract({
    address: PUMP_GRADUATION_ROUTER_ADDRESS,
    abi: pumpGraduationRouterAbi,
    functionName: "admin",
    query: { enabled: market.status === "READY", refetchInterval: 10_000 },
  });
  const routerEnabled = useReadContract({
    address: PUMP_GRADUATION_ROUTER_ADDRESS,
    abi: pumpGraduationRouterAbi,
    functionName: "enabled",
    query: { enabled: market.status === "READY", refetchInterval: 10_000 },
  });
  const adapterAllowed = useReadContract({
    address: PUMP_GRADUATION_ROUTER_ADDRESS,
    abi: pumpGraduationRouterAbi,
    functionName: "isAdapterAllowed",
    args: [PUMP_GRADUATION_ADAPTER_ADDRESS],
    query: { enabled: market.status === "READY", refetchInterval: 10_000 },
  });
  const operational = Boolean(controllerAddress)
    && controllerPump.data?.toLowerCase() === PUMP_FACTORY_ADDRESS.toLowerCase()
    && pumpRouter.data?.toLowerCase() === PUMP_GRADUATION_ROUTER_ADDRESS.toLowerCase()
    && controllerRouter.data?.toLowerCase() === PUMP_GRADUATION_ROUTER_ADDRESS.toLowerCase()
    && controllerAdapter.data?.toLowerCase() === PUMP_GRADUATION_ADAPTER_ADDRESS.toLowerCase()
    && routerAdmin.data?.toLowerCase() === controllerAddress?.toLowerCase()
    && controllerPaused.data === false
    && routerEnabled.data === true
    && adapterAllowed.data === true;

  if (market.status === "GRADUATED" && market.pool !== ZERO_ADDRESS) {
    return <a href={`/0xFi/pools/${market.pool}`} className="pump-button pump-button-primary">0xFi pool</a>;
  }
  if (market.status !== "READY") return null;

  async function graduate() {
    if (!operational || !controllerAddress) return;
    if (!isConnected || !address) {
      toast.warning("Connect wallet", "Connect a wallet to submit graduation.");
      return;
    }
    if (chainId !== PUMP_CHAIN_ID) {
      switchChain({ chainId: PUMP_CHAIN_ID });
      return;
    }
    if (!publicClient) {
      toast.error("RPC unavailable", "Refresh and try again.");
      return;
    }
    try {
      setPending(true);
      await publicClient.simulateContract({
        account: address,
        address: controllerAddress,
        abi: pumpGraduationControllerAbi,
        functionName: "graduateReady",
        args: [market.tokenAddress],
      });
      const hash = await writeContractAsync({
        address: controllerAddress,
        abi: pumpGraduationControllerAbi,
        functionName: "graduateReady",
        args: [market.tokenAddress],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Graduation reverted");
      toast.success("Graduated", "The 0xFi pool is live.");
      onComplete();
    } catch (error) {
      toast.handleError(error, "Graduation failed");
    } finally {
      setPending(false);
    }
  }

  const label = !operational
    ? "Awaiting activation"
    : pending
      ? "Graduating"
      : !isConnected
        ? "Connect wallet"
        : chainId !== PUMP_CHAIN_ID
          ? "Switch network"
          : "Graduate";
  return <button type="button" className="pump-button pump-button-primary" disabled={!operational || pending} onClick={() => void graduate()}>{label}</button>;
}

export function TokenDetail({ token }: { token: Address }) {
  const toast = useToast();
  const query = usePumpMarket(token);
  const market = query.data?.market;
  const metadataUrl = market ? ipfsToGatewayUrl(market.metadataURI) : "";
  const metadata = useQuery({
    queryKey: ["pump-token-metadata", metadataUrl],
    enabled: Boolean(metadataUrl),
    queryFn: async ({ signal }) => {
      const response = await fetch(metadataUrl, { signal });
      if (!response.ok) throw new Error("Metadata unavailable");
      return response.json() as Promise<TokenMetadata>;
    },
    staleTime: 60 * 60 * 1000,
  });

  if (query.isLoading) {
    return <main className="pump-page"><PumpInlineLoading label="Loading token market" /></main>;
  }
  if (query.error) {
    return <main className="pump-page"><PumpErrorState message={query.error.message} onRetry={() => void query.refetch()} /></main>;
  }
  if (!market) {
    return (
      <main className="pump-page"><div className="pump-empty-state"><span className="pump-eyebrow">Market not found</span><h1>This token is not indexed by 0xPump</h1><Link href="/0xPump" className="pump-button pump-button-muted">Back to markets</Link></div></main>
    );
  }

  const imageUrl = ipfsToGatewayUrl(market.imageURI);
  const optimizeImage = market.imageURI.startsWith("ipfs://");
  const website = metadata.data?.external_url || metadata.data?.properties?.website;
  const social = metadata.data?.properties?.twitter;
  const links = [
    { label: "Website", href: website },
    { label: "Social", href: social },
  ].filter(
    (item, index, items): item is { label: string; href: string } =>
      Boolean(item.href && /^https?:\/\//i.test(item.href)) &&
      items.findIndex((candidate) => candidate.href === item.href) === index,
  );

  return (
    <main className="pump-page">
      {query.data?.configured === false ? <PumpConfigNotice /> : null}
      {query.data?.warning ? <p className="pump-source-note">{query.data.warning}</p> : null}
      <Link href="/0xPump" className="pump-back-link">&larr; All markets</Link>

      <section className="pump-token-identity">
        <div className="pump-detail-logo">
          {imageUrl && optimizeImage ? (
            <Image
              src={imageUrl}
              alt={`${market.name} logo`}
              width={96}
              height={96}
              sizes="(max-width: 640px) 60px, (max-width: 900px) 72px, 96px"
              priority
            />
          ) : imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt={`${market.name} logo`} decoding="async" fetchPriority="high" />
          ) : <span>{market.symbol.slice(0, 2)}</span>}
        </div>
        <div className="pump-token-identity-copy">
          <div className="pump-token-heading-line"><h1>{market.name}</h1><span className={`pump-status pump-status-${market.status.toLowerCase()}`}>{market.status}</span></div>
          <p>${market.symbol}</p>
          <div className="pump-token-links">
            <button type="button" title="Copy token address" onClick={() => { void navigator.clipboard.writeText(market.tokenAddress); toast.success("Address copied", shortAddress(market.tokenAddress)); }}>{shortAddress(market.tokenAddress, 7, 6)}</button>
            <a href={getAddressExplorerUrl(market.tokenAddress)} target="_blank" rel="noopener noreferrer">Explorer</a>
            {links.map((item) => <a href={item.href} key={item.href} target="_blank" rel="noopener noreferrer">{item.label}</a>)}
          </div>
        </div>
        <div className="pump-token-price"><span>Curve price</span><strong>${formatDecimal(market.priceNusd)}</strong><small>{market.tradeCount > 0 && market.lastTradeAt ? formatRelativeTime(market.lastTradeAt) : "No trades yet"}</small></div>
      </section>

      <section className="pump-detail-stats">
        <div><span>Market cap</span><strong>${formatWad(market.marketCapNusd)}</strong></div>
        <div><span>Total volume</span><strong>${formatWad(market.volumeNusd)}</strong></div>
        <div><span>Curve reserve</span><strong>${formatWad(market.reserveNusd)}</strong></div>
        <div><span>Trades</span><strong>{market.tradeCount}</strong></div>
        <div><span>Curve progress</span><strong>{(market.progressBps / 100).toFixed(2)}%</strong></div>
      </section>

      <div className="pump-detail-grid">
        <div className="pump-detail-main">
          <PumpChart token={market.tokenAddress} tokenName={market.name} />
          {metadata.data?.description ? <section className="pump-panel pump-about"><span className="pump-eyebrow">About</span><h2>{market.name}</h2><p>{metadata.data.description}</p><small>Created by {shortAddress(market.creator, 7, 6)}</small></section> : null}
        </div>
        <TradePanel market={market} onComplete={() => void query.refetch()} />
      </div>

      <section className="pump-graduation-line">
        <div><span>$6,000 READY target</span><strong>{market.status === "TRADING" ? `${(market.progressBps / 100).toFixed(1)}% funded` : market.status === "READY" ? "Market-cap target reached" : "Liquidity migrated"}</strong></div>
        <div className="pump-progress" role="progressbar" aria-label="Progress to READY" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, market.progressBps / 100)}><span style={{ width: `${Math.min(100, market.progressBps / 100)}%` }} /></div>
        <GraduationAction market={market} onComplete={() => void query.refetch()} />
      </section>

      <TokenHolders token={market.tokenAddress} symbol={market.symbol} />
      <TradeHistory token={market.tokenAddress} />
    </main>
  );
}
