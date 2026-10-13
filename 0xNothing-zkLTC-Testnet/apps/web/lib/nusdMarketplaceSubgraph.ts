import { isAddress, type Address, type Hex } from "viem";
import { parseNusdActivityCursor, type NusdActivityEvent, type NusdActivityFilter, type NusdActivityPage } from "./nusdMarketplaceActivity";

const LOG_INDEX_SPAN = 1n << 32n;
// Above any reachable (block, logIndex) key; used when no cursor is given.
const NEWEST_KEY = (1n << 200n).toString();
// Beyond this lag the first page could miss recent trades; callers fall back to RPC.
export const NUSD_SUBGRAPH_MAX_LAG_BLOCKS = 1_200n;
const MAX_RESPONSE_BYTES = 512 * 1024;

const TYPES: Record<NusdActivityFilter, NusdActivityEvent["type"][]> = {
  ALL: ["MINTED", "LISTED", "UPDATED", "BOUGHT", "CANCELLED", "OFFER_CREATED", "OFFER_REFUNDED"],
  BOUGHT: ["BOUGHT"],
  MINTED: ["MINTED"],
  LISTED: ["LISTED", "UPDATED"],
  CANCELLED: ["CANCELLED"],
  OFFERS: ["OFFER_CREATED", "OFFER_REFUNDED"],
};

const QUERY = `query NusdActivity($first: Int!, $before: BigInt!, $types: [NusdActivityType!]!) {
  activities: nusdActivities(first: $first, orderBy: sortKey, orderDirection: desc, where: { sortKey_lt: $before, type_in: $types }) {
    id type collection tokenId actor other price blockNumber logIndex timestamp transactionHash
  }
  _meta { block { number } hasIndexingErrors }
}`;

type Row = Record<string, unknown>;
type Response = { data?: { activities?: Row[]; _meta?: { block?: { number?: number }; hasIndexingErrors?: boolean } }; errors?: { message?: string }[] };

function uintString(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value) || BigInt(value) >= 1n << 256n) throw new Error("Invalid subgraph integer");
  return BigInt(value).toString();
}

function addressValue(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error("Invalid subgraph address");
  return value as Address;
}

function event(row: Row): NusdActivityEvent {
  const type = row.type as NusdActivityEvent["type"];
  if (!TYPES.ALL.includes(type)) throw new Error("Invalid subgraph activity type");
  const transactionHash = row.transactionHash;
  if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error("Invalid subgraph transaction hash");
  const logIndex = Number(uintString(row.logIndex));
  if (!Number.isSafeInteger(logIndex) || logIndex > 2_147_483_647) throw new Error("Invalid subgraph log index");
  return {
    id: `${transactionHash}:${logIndex}`,
    type,
    collection: addressValue(row.collection),
    tokenId: uintString(row.tokenId),
    actor: addressValue(row.actor),
    other: row.other === null || row.other === undefined ? undefined : addressValue(row.other),
    price: row.price === null || row.price === undefined ? null : uintString(row.price),
    blockNumber: uintString(row.blockNumber),
    logIndex,
    timestamp: uintString(row.timestamp),
    transactionHash: transactionHash as Hex,
  };
}

/**
 * Reads NUSD marketplace history from the dedicated NUSD subgraph. Cursors use
 * the same "block:logIndex" format as the RPC reader, so the client can page
 * across either source. Throws (for an RPC fallback) on indexing errors, lag on
 * the first page, malformed rows or oversized responses.
 */
export async function readNusdActivityFromSubgraph(
  url: string,
  options: { filter: NusdActivityFilter; cursor?: string | null; limit: number; latestBlock?: bigint },
  fetcher: typeof fetch = fetch,
): Promise<NusdActivityPage> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("Invalid activity request");
  const cursor = parseNusdActivityCursor(options.cursor ?? null);
  const before = cursor ? (cursor.block * LOG_INDEX_SPAN + BigInt(cursor.index)).toString() : NEWEST_KEY;
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { first: options.limit + 1, before, types: TYPES[options.filter] } }),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`NUSD subgraph request failed: ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) throw new Error("NUSD subgraph response is too large");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("NUSD subgraph response is too large");
  const json = JSON.parse(text) as Response;
  if (json.errors?.length) throw new Error("NUSD subgraph query error");
  const meta = json.data?._meta;
  const rows = json.data?.activities;
  if (!meta?.block || typeof meta.block.number !== "number" || meta.hasIndexingErrors || !Array.isArray(rows)) throw new Error("NUSD subgraph is unavailable");
  const head = BigInt(meta.block.number);
  if (!cursor && options.latestBlock !== undefined && options.latestBlock > head + NUSD_SUBGRAPH_MAX_LAG_BLOCKS) throw new Error("NUSD subgraph is behind the chain");
  if (rows.length > options.limit + 1) throw new Error("NUSD subgraph returned too many rows");
  const events = rows.slice(0, options.limit).map(event);
  const last = events[events.length - 1];
  return {
    events,
    nextCursor: rows.length > options.limit && last ? `${last.blockNumber}:${last.logIndex}` : null,
    fromBlock: last?.blockNumber ?? "0",
    throughBlock: (cursor?.block ?? head).toString(),
  };
}
