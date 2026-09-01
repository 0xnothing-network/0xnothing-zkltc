import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { DynamicPoolDetail } from "@fi/components/DynamicPoolDetail";
import { PoolDetail } from "@fi/components/PoolDetail";
import { PageHeading, RouteLink } from "@fi/components/UiStates";
import { parsePairSlug } from "@fi/config/assets";

export default async function PoolPage({
  params,
  searchParams,
}: {
  params: Promise<{ pair: string }>;
  searchParams: Promise<{ action?: string | string[]; from?: string | string[] }>;
}) {
  const [{ pair: slug }, query] = await Promise.all([params, searchParams]);
  const pair = parsePairSlug(slug);
  const pool = isAddress(slug) ? getAddress(slug) : undefined;
  const fromEarn = query.from === "earn" && pair?.includes("zkLTC") === false;
  const initialMode = query.action === "remove" ? "remove" : "add";
  if (!pair && !pool) notFound();
  const displayPair = pair
    ? pair[0] === "NUSD" ? [pair[1], pair[0]] as const : pair
    : undefined;
  return (
    <div className="fi-page fi-trade-page">
      {pair ? (
        <>
          <PageHeading
            title={`${displayPair![0]} / ${displayPair![1]}`}
            action={fromEarn
              ? <RouteLink href={`/earn?pair=${slug}`}>Back to Earn</RouteLink>
              : <RouteLink href="/pools">Back to pools</RouteLink>}
          />
          <PoolDetail pair={pair} fromEarn={fromEarn} initialMode={initialMode} />
        </>
      ) : <DynamicPoolDetail key={pool} pool={pool!} />}
    </div>
  );
}
