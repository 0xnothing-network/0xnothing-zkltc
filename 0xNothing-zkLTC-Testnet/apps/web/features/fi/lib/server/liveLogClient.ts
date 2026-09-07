import "server-only";

import { createPublicClient, http } from "viem";
import { deployment } from "@fi/config/deployment";

// Live history supplements the indexer. A slow log backend must not hold up
// ordinary price/reserve batches or spend several 15-second retry windows
// before the API can return its indexed data with an unavailable-tail warning.
// Polling is the retry mechanism for these optional reads.
export const liveLogClient = createPublicClient({
  transport: http(deployment.chain.rpcUrl, {
    batch: false,
    retryCount: 0,
    timeout: 4_000,
  }),
});
