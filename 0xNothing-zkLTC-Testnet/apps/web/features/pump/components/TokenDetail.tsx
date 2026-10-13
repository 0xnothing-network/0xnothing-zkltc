"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useAccount, useConfig, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { pumpGraduationControllerAbi, pumpGraduationRouterAbi, zeroXPumpAbi } from "@/features/pump/abis";
import { usePumpMarket } from "@/features/pump/hooks/usePumpData";
import {
  ipfsToGatewayUrl,
  normalizePumpIpfsPath,
  normalizePumpExternalUrl,
  PUMP_CHAIN_ID,
  PUMP_FACTORY_ADDRESS,
  PUMP_GRADUATION_ADAPTER_ADDRESS,
  PUMP_GRADUATION_ROUTER_ADDRESS,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import { formatDecimal, formatRelativeTime, formatWad, shortAddress } from "@/features/pump/format";
import type { PumpMarket } from "@/features/pump/types";
import { getAddressExplorerUrl } from "@/lib/explorer";
import { LazyPumpChart } from "@/features/pump/components/LazyPumpChart";
import { PumpTokenLogo } from "@/features/pump/components/PumpTokenLogo";
import { TradePanel } from "@/features/pump/components/TradePanel";
import { TradeHistory } from "@/features/pump/components/TradeHistory";
import { TokenHolders } from "@/features/pump/components/TokenHolders";
import { PumpConfigNotice, PumpErrorState, PumpInlineLoading } from "@/features/pump/components/PumpStates";
import { ExternalLink } from "@/components/ExternalLink";
import { useToast } from "@/components/Toast";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";
import { createPumpWalletGuard } from "@/features/pump/walletSession";
import { waitForProtocolReceipt } from "@/lib/transactionReceipt";
import { LITVM_ADD_CHAIN_PARAMETER } from "@/config/network";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { PixelProgress } from "@/components/ui/PixelProgress";
import { Tabs } from "@/components/ui/Tabs";

/** Market cap at which a curve becomes READY (matches the on-chain $6,000 target copy). */
const READY_TARGET_NUSD = 6_000;
const STATUS_TONE: Record<string, BadgeTone> = { TRADING: "trading", READY: "ready", GRADUATED: "graduated" };
const STATUS_LABEL: Record<string, string> = { TRADING: "Trading", READY: "Ready", GRADUATED: "Graduated" };
const CHIP = "inline-flex h-8 items-center gap-1 rounded-ui-sm border border-line bg-surface-2 px-2.5 font-num text-xs text-fg-2 hover:border-line-strong hover:text-fg focus-ring";

interface TokenMetadata {
  description?: string;
  external_url?: string;
  properties?: { website?: string; twitter?: string };
}

function parseTokenMetadata(value: unknown): TokenMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  const properties = metadata.properties && typeof metadata.properties === "object" && !Array.isArray(metadata.properties)
    ? metadata.properties as Record<string, unknown>
    : {};
  return {
    description: typeof metadata.description === "string" ? metadata.description : undefined,
    external_url: typeof metadata.external_url === "string" ? metadata.external_url : undefined,
    properties: {
      website: typeof properties.website === "string" ? properties.website : undefined,
      twitter: typeof properties.twitter === "string" ? properties.twitter : undefined,
    },
  };
}

function GraduationAction({ market, onComplete }: { market: PumpMarket; onComplete: () => void }) {
  const toast = useToast();
  const { address, isConnected, chainId } = useAccount();
  const walletConfig = useConfig();
  const publicClient = usePublicClient({ chainId: PUMP_CHAIN_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const submitLockRef = useRef(false);
  const [pending, setPending] = useState(false);
  const pumpAdmin = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "admin",
    query: { enabled: market.status === "READY" },
  });
  const pumpRouter = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "graduationRouter",
    query: { enabled: market.status === "READY", staleTime: Infinity },
  });
  const controllerAddress = pumpAdmin.data;
  const controllerReadEnabled = market.status === "READY" && Boolean(controllerAddress);
  const controllerPaused = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "graduationsPaused",
    query: { enabled: controllerReadEnabled },
  });
  const controllerPump = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "pump",
    query: { enabled: controllerReadEnabled, staleTime: Infinity },
  });
  const controllerRouter = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "router",
    query: { enabled: controllerReadEnabled, staleTime: Infinity },
  });
  const controllerAdapter = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: controllerAddress,
    abi: pumpGraduationControllerAbi,
    functionName: "adapter",
    query: { enabled: controllerReadEnabled, staleTime: Infinity },
  });
  const routerAdmin = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_GRADUATION_ROUTER_ADDRESS,
    abi: pumpGraduationRouterAbi,
    functionName: "admin",
    query: { enabled: market.status === "READY" },
  });
  const routerEnabled = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_GRADUATION_ROUTER_ADDRESS,
    abi: pumpGraduationRouterAbi,
    functionName: "enabled",
    query: { enabled: market.status === "READY" },
  });
  const adapterAllowed = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_GRADUATION_ROUTER_ADDRESS,
    abi: pumpGraduationRouterAbi,
    functionName: "isAdapterAllowed",
    args: [PUMP_GRADUATION_ADAPTER_ADDRESS],
    query: { enabled: market.status === "READY" },
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
    return <Link href={`/0xFi/pools/${market.pool}`} className="pump-button pump-button-primary">Trade on 0xFi →</Link>;
  }
  if (market.status !== "READY") return null;

  async function graduate() {
    if (!operational || !controllerAddress) return;
    if (!isConnected || !address) {
      toast.warning("Connect wallet", "Connect a wallet to submit graduation.");
      return;
    }
    if (chainId !== PUMP_CHAIN_ID) {
      switchChain({ chainId: PUMP_CHAIN_ID, addEthereumChainParameter: LITVM_ADD_CHAIN_PARAMETER });
      return;
    }
    if (!publicClient) {
      toast.error("RPC unavailable", "Refresh and try again.");
      return;
    }
    if (!tryAcquireAction(submitLockRef)) return;
    try {
      setPending(true);
      const assertWalletUnchanged = createPumpWalletGuard(walletConfig, address);
      assertWalletUnchanged();
      await publicClient.simulateContract({
        account: address,
        address: controllerAddress,
        abi: pumpGraduationControllerAbi,
        functionName: "graduateReady",
        args: [market.tokenAddress],
      });
      assertWalletUnchanged();
      const hash = await writeContractAsync({
        account: address,
        chainId: PUMP_CHAIN_ID,
        address: controllerAddress,
        abi: pumpGraduationControllerAbi,
        functionName: "graduateReady",
        args: [market.tokenAddress],
      });
      await waitForProtocolReceipt(publicClient, hash);
      toast.success("Graduated", "The 0xFi pool is live.");
      onComplete();
    } catch (error) {
      toast.handleError(error, "Graduation failed");
    } finally {
      releaseAction(submitLockRef);
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
  const metadataCid = market ? normalizePumpIpfsPath(market.metadataURI) : "";
  const metadataUrl = metadataCid
    ? `/api/pump/metadata?cid=${encodeURIComponent(metadataCid)}`
    : market ? ipfsToGatewayUrl(market.metadataURI) : "";
  const metadata = useQuery({
    queryKey: ["pump-token-metadata", metadataUrl],
    enabled: Boolean(metadataUrl),
    queryFn: async ({ signal }) => {
      const response = await fetch(metadataUrl, { signal });
      if (!response.ok || response.headers.get("X-Pump-Metadata-Status") === "unavailable") throw new Error("Metadata unavailable");
      return parseTokenMetadata(await response.json());
    },
    staleTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
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

  const website = normalizePumpExternalUrl(
    metadata.data?.external_url || metadata.data?.properties?.website || "",
  );
  const social = normalizePumpExternalUrl(metadata.data?.properties?.twitter || "");
  // On-chain metadata may predate the HTTPS-only upload validation, so
  // normalize every link before exposing it.
  const links = [
    { label: "Website", href: website },
    { label: "Social", href: social },
  ].filter(
    (item, index, items) => item.href &&
      items.findIndex((candidate) => candidate.href === item.href) === index,
  );

  const progress = Math.min(100, Math.max(0, (market.progressBps ?? 0) / 100));
  const remainingToReady = Math.max(0, READY_TARGET_NUSD * (1 - progress / 100));
  const graduated = market.status === "GRADUATED";

  return (
    <main className="pump-page ui pump-token-page font-ui text-fg max-lg:pb-24">
      {query.data?.configured === false ? <PumpConfigNotice /> : null}
      {query.data?.warning ? <p className="pump-source-note">{query.data.warning}</p> : null}
      <Link href="/0xPump" className="inline-flex items-center gap-1 text-sm text-fg-3 hover:text-fg focus-ring">&larr; Markets</Link>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <div className="grid min-w-0 gap-4">
          <section className="flex flex-wrap items-start gap-4" aria-label="Token">
            <div className="shrink-0 overflow-hidden rounded-ui-lg">
              <PumpTokenLogo
                imageUri={market.imageURI}
                name={market.name}
                symbol={market.symbol}
                size={64}
                priority
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-[30px]">{market.name}</h1>
                <Badge tone={STATUS_TONE[market.status] ?? "neutral"}>{STATUS_LABEL[market.status] ?? market.status}</Badge>
              </div>
              <p className="mt-1 font-num text-sm text-fg-3">${market.symbol} · created by {shortAddress(market.creator, 6, 4)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className={CHIP} title="Copy token address" onClick={() => { void navigator.clipboard.writeText(market.tokenAddress); toast.success("Address copied", shortAddress(market.tokenAddress)); }}>{shortAddress(market.tokenAddress, 6, 4)} <span aria-hidden="true">⧉</span></button>
                <ExternalLink className={CHIP} href={getAddressExplorerUrl(market.tokenAddress)}>Explorer ↗</ExternalLink>
                {links.map((item) => <ExternalLink className={CHIP} href={item.href} key={item.href} userGenerated>{item.label} ↗</ExternalLink>)}
              </div>
            </div>
            <div className="text-right max-sm:w-full max-sm:text-left">
              <p className="text-xs text-fg-3">Curve price · NUSD</p>
              <p className="font-num tnum text-[30px] font-semibold leading-tight">${formatDecimal(market.priceNusd)}</p>
              <p className="text-xs text-fg-3">{market.tradeCount > 0 && market.lastTradeAt ? `Last trade ${formatRelativeTime(market.lastTradeAt)}` : "No trades yet"}</p>
            </div>
          </section>

          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Market cap", `$${formatWad(market.marketCapNusd)}`],
              ["Total volume", `$${formatWad(market.volumeNusd)}`],
              ["Curve reserve", `$${formatWad(market.reserveNusd)}`],
              ["Trades", String(market.tradeCount ?? 0)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-ui-lg border border-line bg-surface-1 p-4 shadow-e1">
                <dt className="text-xs text-fg-3">{label}</dt>
                <dd className="mt-1 font-num tnum text-lg">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="pump-token-chart min-w-0">
            <LazyPumpChart token={market.tokenAddress} tokenName={market.name} />
          </div>

          <TokenDetailTabs market={market} description={metadata.data?.description} />
        </div>

        <aside id="trade" className="grid gap-4 scroll-mt-24 lg:sticky lg:top-[88px]" aria-label="Trade">
          {graduated ? (
            <section className="rounded-ui-lg border border-line bg-surface-1 p-5 shadow-e1">
              <p className="eyebrow">Graduated</p>
              <h2 className="mt-2 text-xl font-semibold">Trading moved to 0xFi</h2>
              <p className="mt-1 text-sm text-fg-2">This market reached READY and its liquidity migrated to an 0xFi pool. The bonding curve is closed.</p>
            </section>
          ) : (
            <TradePanel market={market} onComplete={() => void query.refetch()} />
          )}

          <section className="rounded-ui-lg border border-line bg-surface-1 p-5 shadow-e1" aria-label="Bonding curve">
            <div className="flex items-center justify-between gap-2">
              <p className="eyebrow">Bonding curve</p>
              <Badge tone={market.status === "TRADING" ? "trading" : market.status === "READY" ? "ready" : "graduated"}>{`${progress.toFixed(1)}%`}</Badge>
            </div>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="font-num tnum text-2xl font-semibold">${formatWad(market.marketCapNusd)}</span>
              <span className="font-num text-sm text-fg-3">/ $6,000 READY</span>
            </p>
            <PixelProgress className="mt-3" value={progress} size="lg" />
            <p className="mt-3 text-sm text-fg-2">
              {market.status === "TRADING"
                ? <>${remainingToReady.toLocaleString("en-US", { maximumFractionDigits: 0 })} more market cap until <strong className="text-fg">READY</strong>. At READY buys pause and the market can graduate to an 0xFi pool.</>
                : market.status === "READY" ? "Market-cap target reached." : "Liquidity migrated to 0xFi."}
            </p>
            {market.status === "READY" ? <p className="mt-2 text-xs text-fg-3">Buys are frozen at the $6,000 target. Graduate through the pinned 0xFi controller — the same <code>graduateReady</code> call the keeper uses. Sells freeze only while that path is live, and reopen after the exit delay if graduation never happens.</p> : null}
            <div className="pump-graduation-action mt-4 grid">
              <GraduationAction market={market} onComplete={() => void query.refetch()} />
            </div>
          </section>
        </aside>
      </div>

      {graduated ? null : (
        <div className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-[55] border-t border-line bg-bg/95 p-3 backdrop-blur lg:hidden">
          <a href="#trade" className="flex h-11 items-center justify-center rounded-ui-md bg-accent font-medium text-accent-ink focus-ring">
            Trade {market.symbol}
          </a>
        </div>
      )}
    </main>
  );
}

type DetailTab = "trades" | "holders" | "about";

/** Trades | Holders | About (spec §5 Pump Token). Own component so tab state stays local. */
function TokenDetailTabs({ market, description }: { market: PumpMarket; description?: string }) {
  const [tab, setTab] = useState<DetailTab>("trades");
  const items: ReadonlyArray<{ value: DetailTab; label: string }> = [
    { value: "trades", label: "Trades" },
    { value: "holders", label: "Holders" },
    { value: "about", label: "About" },
  ];
  return (
    <section className="rounded-ui-lg border border-line bg-surface-1 px-4 pb-4 shadow-e1">
      <Tabs label="Token activity" idBase="pump-token" value={tab} items={items} onChange={setTab} />
      <div role="tabpanel" id={`pump-token-panel-${tab}`} aria-labelledby={`pump-token-tab-${tab}`} className="pump-token-tabpanel pt-4">
        {tab === "trades" ? <TradeHistory token={market.tokenAddress} /> : null}
        {tab === "holders" ? <TokenHolders token={market.tokenAddress} symbol={market.symbol} /> : null}
        {tab === "about" ? (
          <div className="grid gap-2 text-sm text-fg-2">
            <p>{description || "The creator didn't add a description."}</p>
            <p className="text-xs text-fg-3">Created by <span className="font-num">{shortAddress(market.creator, 7, 6)}</span></p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
