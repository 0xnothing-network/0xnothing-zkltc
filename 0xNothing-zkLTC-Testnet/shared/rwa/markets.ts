import manifest from "./markets.json" with { type: "json" };
import { validateMarkets } from "./core.ts";

// No invented deployments. Publish only after onchain/source identity verification.
export const rwaMarkets = validateMarkets(manifest.markets);
