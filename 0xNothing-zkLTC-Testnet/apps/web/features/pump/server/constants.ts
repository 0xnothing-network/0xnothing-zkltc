import "server-only";

/**
 * Tuning knobs shared by the pump server modules. They live in one file so a
 * limit can be found and adjusted without reading through the query and
 * RPC-fallback code that consumes it.
 */

export const MAX_MARKETS = 500;
export const RPC_TRADE_LOOKBACK = 100_000n;
export const RPC_LOG_BLOCK_CHUNK = 16_384n;
export const MAX_RPC_HOLDER_CANDIDATES = 10_000;
export const RPC_HOLDER_LOG_CONCURRENCY = 4;
export const RPC_TRADE_LOG_CONCURRENCY = 4;
export const RPC_MARKET_HYDRATE_CONCURRENCY = 12;
export const RPC_BLOCK_TIMESTAMP_CONCURRENCY = 16;
export const GRAPH_TIMEOUT_MS = 8_000;
export const HOLDER_GRAPH_TIMEOUT_MS = 2_500;
export const LIVE_TAIL_CACHE_TTL_MS = 4_000;
export const MAX_LIVE_TAIL_CACHE_ENTRIES = 512;
export const MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES = 4_096;
