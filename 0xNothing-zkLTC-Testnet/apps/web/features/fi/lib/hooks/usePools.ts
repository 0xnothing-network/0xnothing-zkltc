"use client";

import { useQuery } from "@tanstack/react-query";
import { fiPath } from "@fi/config/paths";
import type { DataEnvelope, PoolPoint } from "@fi/lib/data";
import { FI_LIVE_MS } from "@/lib/liveData";

export const FI_POOLS_QUERY_KEY = ["fi-pools"] as const;

async function fetchPools(): Promise<{ pools: PoolPoint[]; warning?: string }> {
  const response = await fetch(fiPath("/api/data/pools"));
  const payload = (await response.json()) as DataEnvelope<PoolPoint[]> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Pool request failed");
  return { pools: payload.data, warning: payload.warning };
}

export function usePools() {
  const query = useQuery({
    queryKey: FI_POOLS_QUERY_KEY,
    queryFn: fetchPools,
    staleTime: 12_000,
    refetchInterval: FI_LIVE_MS,
    refetchIntervalInBackground: false,
  });
  return {
    ...query,
    data: query.data?.pools,
    warning: query.data?.warning,
  };
}
