"use client";

import { useQuery } from "@tanstack/react-query";
import { fiPath } from "@fi/config/paths";
import type { DataEnvelope, PoolPoint } from "@fi/lib/data";
import { fetchJson } from "@/lib/http";
import { FI_LIVE_MS } from "@/lib/liveData";
import { fiPollInterval, useFiVisibilityRefresh } from "@fi/lib/hooks/useFiPolling";

export const FI_POOLS_QUERY_KEY = ["fi-pools"] as const;
/** The server may answer at once from an older snapshot while it refreshes; ask again soon. */
const SNAPSHOT_FRESH_MS = 20_000;
const OLD_SNAPSHOT_RETRY_MS = 4_000;

type PoolsResult = { pools: PoolPoint[]; warning?: string; generatedAt: number };

async function fetchPools(signal?: AbortSignal): Promise<PoolsResult> {
  const payload = await fetchJson<DataEnvelope<PoolPoint[]>>(
    fiPath("/api/data/pools"),
    { signal },
    "Pool request failed",
  );
  return { pools: payload.data, warning: payload.warning, generatedAt: Date.parse(payload.meta.generatedAt) };
}

function isOldSnapshot(result: PoolsResult | undefined): boolean {
  return Boolean(result && Number.isFinite(result.generatedAt) && Date.now() - result.generatedAt > SNAPSHOT_FRESH_MS);
}

export function usePools() {
  const query = useQuery({
    queryKey: FI_POOLS_QUERY_KEY,
    queryFn: ({ signal }) => fetchPools(signal),
    staleTime: 12_000,
    refetchInterval: (query) => isOldSnapshot(query.state.data) ? OLD_SNAPSHOT_RETRY_MS : fiPollInterval("pools"),
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
