import { NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { deployment } from "@fi/config/deployment";
import { farmFactoryAbi, farmGaugeAbi } from "@fi/lib/abis/farm";
import type { DataEnvelope } from "@fi/lib/data";
import { queryGoldsky, unconfiguredEnvelope } from "@fi/lib/server/goldsky";

type FarmRow = {
  id: string;
  totalStaked: string;
  totalFunded: string;
  totalPaid: string;
  rewardRate: string;
  periodFinish: string;
  depositsPaused: boolean;
  pool: { id: string };
};
type Result = { gauges?: FarmRow[] };

const MAX_GAUGES = 1_000;
const CACHE_TTL_MS = 15_000;
const QUERY = `query Farms {
  _meta { block { number } }
  gauges(first: 1000) {
    id totalStaked totalFunded totalPaid rewardRate periodFinish depositsPaused pool { id }
  }
}`;
const client = createPublicClient({ transport: http(deployment.chain.rpcUrl) });

async function loadRpcFarms(): Promise<{ rows: FarmRow[]; blockNumber: bigint }> {
  const factories = [
    deployment.contracts.farmFactory,
    deployment.contracts.synthFeeGaugeFactory,
  ].filter((factory): factory is Address => Boolean(factory));
  if (factories.length === 0) throw new Error("Gauge factories are not configured");
  const [lengths, blockNumber] = await Promise.all([
    Promise.all(factories.map((factory) => client.readContract({
      address: factory,
      abi: farmFactoryAbi,
      functionName: "allGaugesLength",
    }))),
    client.getBlockNumber(),
  ]);
  const totalLength = lengths.reduce((sum, length) => sum + length, 0n);
  if (totalLength > BigInt(MAX_GAUGES)) throw new Error("Gauge count exceeds the discovery limit");
  const discovered = await Promise.all(factories.map((factory, factoryIndex) => Promise.all(
    Array.from({ length: Number(lengths[factoryIndex]) }, (_, index) => client.readContract({
      address: factory,
      abi: farmFactoryAbi,
      functionName: "allGauges",
      args: [BigInt(index)],
    })),
  )));
  const gauges = [...new Set(discovered.flat().map((gauge) => gauge.toLowerCase()))] as Address[];
  const rows = await Promise.all(gauges.map(async (gauge: Address): Promise<FarmRow> => {
    const [pool, totalStaked, totalFunded, totalPaid, rewardRate, periodFinish, depositsPaused] = await Promise.all([
      client.readContract({ address: gauge, abi: farmGaugeAbi, functionName: "stakingToken" }),
      client.readContract({ address: gauge, abi: farmGaugeAbi, functionName: "totalSupply" }),
      client.readContract({ address: gauge, abi: farmGaugeAbi, functionName: "totalFunded" }),
      client.readContract({ address: gauge, abi: farmGaugeAbi, functionName: "totalPaid" }),
      client.readContract({ address: gauge, abi: farmGaugeAbi, functionName: "rewardRate" }),
      client.readContract({ address: gauge, abi: farmGaugeAbi, functionName: "periodFinish" }),
      client.readContract({ address: gauge, abi: farmGaugeAbi, functionName: "depositsPaused" }),
    ]);
    return {
      id: gauge.toLowerCase(),
      totalStaked: totalStaked.toString(),
      totalFunded: totalFunded.toString(),
      totalPaid: totalPaid.toString(),
      rewardRate: rewardRate.toString(),
      periodFinish: periodFinish.toString(),
      depositsPaused,
      pool: { id: pool.toLowerCase() },
    };
  }));
  return { rows, blockNumber };
}

function sameIds(left: FarmRow[], right: FarmRow[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map((row) => row.id.toLowerCase()));
  return right.every((row) => expected.has(row.id.toLowerCase()));
}

async function loadFarmsEnvelope(): Promise<DataEnvelope<FarmRow[]>> {
  let envelope: DataEnvelope<FarmRow[]>;
  try {
    envelope = await queryGoldsky<Result, FarmRow[]>(QUERY, {}, (data) => data.gauges || [], []);
  } catch (error) {
    envelope = unconfiguredEnvelope<FarmRow[]>(
      [],
      `Goldsky unavailable: ${error instanceof Error ? error.message : "query failed"}`,
    );
  }

  try {
    const rpc = await loadRpcFarms();
    const indexerWasStale = envelope.meta.source === "goldsky" && !sameIds(rpc.rows, envelope.data);
    envelope.data = rpc.rows;
    envelope.meta.rpcTail = {
      status: "merged",
      fromBlock: envelope.meta.indexedBlock === null ? 0 : envelope.meta.indexedBlock + 1,
      toBlock: Number(rpc.blockNumber),
      merged: true,
      eventCount: rpc.rows.length,
    };
    if (indexerWasStale) {
      envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}Indexed gauges do not match the active factory; live RPC state was used.`;
    }
  } catch (error) {
    envelope.meta.rpcTail.status = "unavailable";
    envelope.warning = `${envelope.warning ? `${envelope.warning} ` : ""}Gauge RPC state unavailable: ${error instanceof Error ? error.message : "request failed"}`;
  }

  return envelope;
}

let cachedFarms: { envelope: DataEnvelope<FarmRow[]>; expiresAt: number } | undefined;
let farmsLoadInFlight: Promise<DataEnvelope<FarmRow[]>> | undefined;

function farmsResponse(
  envelope: DataEnvelope<FarmRow[]>,
  cacheStatus: "HIT" | "MISS" | "COALESCED" | "STALE",
) {
  return NextResponse.json(envelope, {
    headers: {
      "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60",
      "X-0xFi-Cache": cacheStatus,
    },
  });
}

export async function GET() {
  const now = Date.now();
  if (cachedFarms && cachedFarms.expiresAt > now) return farmsResponse(cachedFarms.envelope, "HIT");

  const joinedExistingRequest = Boolean(farmsLoadInFlight);
  if (!farmsLoadInFlight) {
    farmsLoadInFlight = loadFarmsEnvelope().then((envelope) => {
      cachedFarms = { envelope, expiresAt: Date.now() + CACHE_TTL_MS };
      return envelope;
    });
  }
  const request = farmsLoadInFlight;
  try {
    const envelope = await request;
    return farmsResponse(envelope, joinedExistingRequest ? "COALESCED" : "MISS");
  } catch (error) {
    if (cachedFarms) {
      return farmsResponse({
        ...cachedFarms.envelope,
        warning: `${cachedFarms.envelope.warning ? `${cachedFarms.envelope.warning} ` : ""}Farm refresh failed; cached data was used: ${error instanceof Error ? error.message : "request failed"}`,
      }, "STALE");
    }
    throw error;
  } finally {
    if (farmsLoadInFlight === request) farmsLoadInFlight = undefined;
  }
}
