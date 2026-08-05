import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { DynamicPoolDetail } from "@/components/DynamicPoolDetail";
import { PoolDetail } from "@/components/PoolDetail";
import { PageHeading, RouteLink } from "@/components/UiStates";
import { parsePairSlug } from "@/config/assets";

export default async function PoolPage({ params }: { params: Promise<{ pair: string }> }) {
  const { pair: slug } = await params;
  const pair = parsePairSlug(slug);
  const pool = isAddress(slug) ? getAddress(slug) : undefined;
  if (!pair && !pool) notFound();
  return (
    <div className="fi-page fi-trade-page">
      {pair ? (
        <>
          <PageHeading title={`${pair[0]}/${pair[1]}`} action={<RouteLink href="/">Markets</RouteLink>} />
          <PoolDetail pair={pair} />
        </>
      ) : <DynamicPoolDetail pool={pool!} />}
    </div>
  );
}
