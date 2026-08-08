"use client";

import { useQuery } from "@tanstack/react-query";
import { fiPath } from "@fi/config/paths";
import type { DataEnvelope, PoolPoint } from "@fi/lib/data";

export const FI_POOLS_QUERY_KEY = ["fi-pools"] as const;

async function fetchPools(): Promise<PoolPoint[]> {
  const response = await fetch(fiPath("/api/data/pools"));
  const payload = (await response.json()) as DataEnvelope<PoolPoint[]> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Pool request failed");
  return payload.data;
}

export function usePools() {
  return useQuery({
    queryKey: FI_POOLS_QUERY_KEY,
    queryFn: fetchPools,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
