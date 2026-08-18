"use client";

import { useQuery } from "@tanstack/react-query";
import { fiPath } from "@fi/config/paths";
import type { DataEnvelope, PoolPoint } from "@fi/lib/data";
import { fetchJson } from "@/lib/http";
import { FI_LIVE_MS } from "@/lib/liveData";
import { fiPollInterval, useFiVisibilityRefresh } from "@fi/lib/hooks/useFiPolling";

export const FI_POOLS_QUERY_KEY = ["fi-pools"] as const;

async function fetchPools(signal?: AbortSignal): Promise<{ pools: PoolPoint[]; warning?: string }> {
  const payload = await fetchJson<DataEnvelope<PoolPoint[]>>(
    fiPath("/api/data/pools"),
    { signal },
    "Pool request failed",
  );
  return { pools: payload.data, warning: payload.warning };
}

export function usePools() {
  const query = useQuery({
    queryKey: FI_POOLS_QUERY_KEY,
    queryFn: ({ signal }) => fetchPools(signal),
    staleTime: 12_000,
    refetchInterval: fiPollInterval("pools"),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  useFiVisibilityRefresh({
    key: "pools",
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: query.refetch,
    maxAgeMs: FI_LIVE_MS,
  });
  return {
    ...query,
    data: query.data?.pools,
    warning: query.data?.warning,
  };
}
