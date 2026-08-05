import "server-only";

import { deployment } from "@fi/config/deployment";
import type { DataEnvelope } from "@fi/lib/data";

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

function baseMeta(source: "goldsky" | "unconfigured", indexedBlock: number | null) {
  return {
    source,
    indexedBlock,
    generatedAt: new Date().toISOString(),
    rpcTail: {
      status: "pending" as const,
      fromBlock: indexedBlock === null
        ? Number(deployment.indexer.deploymentBlock)
        : indexedBlock + 1,
      merged: false as const,
    },
  };
}

export function unconfiguredEnvelope<T>(empty: T, warning = "Goldsky endpoint is not configured."): DataEnvelope<T> {
  return {
    data: empty,
    meta: baseMeta("unconfigured", null),
    warning,
  };
}

export async function queryGoldsky<TData, TResult>(
  query: string,
  variables: Record<string, unknown>,
  select: (data: TData) => TResult,
  empty: TResult,
): Promise<DataEnvelope<TResult>> {
  const endpoint = deployment.indexer.endpoint;
  if (!endpoint) return unconfiguredEnvelope(empty);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`Goldsky returned HTTP ${response.status}`);
  const payload = (await response.json()) as GraphQlResponse<TData & { _meta?: { block?: { number?: number } } }>;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message || "Indexer query failed").join("; "));
  }
  if (!payload.data) throw new Error("Goldsky returned no data");

  const indexedBlock = payload.data._meta?.block?.number ?? null;
  return {
    data: select(payload.data),
    meta: baseMeta("goldsky", indexedBlock),
  };
}
