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
const QUERY = `query Farms {
  _meta { block { number } }
  gauges(first: 1000) {
    id totalStaked totalFunded totalPaid rewardRate periodFinish depositsPaused pool { id }
  }
}`;
const client = createPublicClient({ transport: http(deployment.chain.rpcUrl) });

async function loadRpcFarms(): Promise<{ rows: FarmRow[]; blockNumber: bigint }> {
  const factory = deployment.contracts.farmFactory;
  if (!factory) throw new Error("Gauge factory is not configured");
  const [length, blockNumber] = await Promise.all([
    client.readContract({ address: factory, abi: farmFactoryAbi, functionName: "allGaugesLength" }),
    client.getBlockNumber(),
  ]);
  if (length > BigInt(MAX_GAUGES)) throw new Error("Gauge count exceeds the discovery limit");
  const gauges = await Promise.all(Array.from({ length: Number(length) }, (_, index) => (
    client.readContract({
      address: factory,
      abi: farmFactoryAbi,
      functionName: "allGauges",
      args: [BigInt(index)],
    })
  )));
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

export async function GET() {
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

  return NextResponse.json(envelope);
}
