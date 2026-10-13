import assert from "node:assert/strict";
import test from "node:test";
import * as viem from "viem";
import type { litvmRpcUrls as LitvmRpcUrls } from "../../lib/rpcTransport.ts";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const PRIMARY = "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const FALLBACK = "https://liteforge.rpc.caldera.xyz/http";
const { litvmRpcUrls } = evaluateModule<{ litvmRpcUrls: typeof LitvmRpcUrls }>(new URL("../../lib/rpcTransport.ts", import.meta.url), {
  viem, "./publicConfig": { LITVM_RPC_URL: PRIMARY, LITVM_RPC_FALLBACK_URL: FALLBACK },
});

test("RPC endpoints fail over in a fixed order without duplicates", () => {
  assert.deepEqual(Array.from(litvmRpcUrls()), [PRIMARY, FALLBACK]);
  assert.deepEqual(Array.from(litvmRpcUrls("https://custom.rpc")), ["https://custom.rpc", PRIMARY, FALLBACK]);
  assert.deepEqual(Array.from(litvmRpcUrls(FALLBACK)), [FALLBACK, PRIMARY]);
  assert.deepEqual(Array.from(litvmRpcUrls("")), [PRIMARY, FALLBACK]);
});
