# Relayer (`quantum-wallet/relayer/`)

**Dev-sponsored gas.** Users of a 0xQuantum wallet sign their intent (a batch of
calls + WOTS signature) and POST it here; the relayer pays the gas and returns
the tx hash. It never sees secrets — only signed intents that are useless
without the user's future leaves.

## Run

```bash
cp .env.example .env           # set QW_FACTORY + QW_SPONSOR_KEY
QW_FACTORY=0x... QW_SPONSOR_KEY=0x... npm start
curl localhost:8787/health
```

## Protocol

POST `/relay` with a `RelayRequest` (`sdk/src/relay.ts`):

| kind          | payload                                   | policy                                   |
|---------------|-------------------------------------------|------------------------------------------|
| `deploy`      | `root0`                                   | CREATE2 prediction must equal `wallet`; wallet must be undeployed |
| `execute`     | `op` (WireOp) + `sig`                     | nonce must match on-chain state; simulate before broadcast |
| `rotate`      | `newRoot`, `nextEpoch` + `sig`            | `nextEpoch` must equal on-chain epoch+1; simulate |
| `signMessage` | `messageHash` + `sig`                     | simulate                                   |

Rules every request must pass (see [src/policy.ts](src/policy.ts)): known kind,
checksummed wallet, matching `chainId`, signature shape exactly 67 WOTS
elements + 10 auth-path nodes, call batch ≤ 16 / ≤ 100 KB, `validUntil` either
the OP_NO_EXPIRY sentinel (what every SDK op stamps) or within the configured
skew window of now.

On-chain guards the relayer enforces before spending a single wei:
1. **deploy-first** — execute/rotate/signMessage on an undeployed wallet is
   rejected. (Calling a function on an empty address *succeeds silently* as a
   no-op tx — relaying it would fake a transfer that never happened.)
2. **simulate (eth_call/estimateGas) before broadcast** — a reverting intent
   returns `{ok:false, error:"simulation failed: <decoded revert>"}` free.
3. **serialized broadcasts** — one sponsor account, one in-flight tx at a time
   (explicit pending nonce inside the queue).
4. **receipt confirm** — responses are only `ok` after `status === "success"`.

## Fallback

The SDK's `manualBroadcast` sends the identical calldata from the user's own
EOA if the relayer is down — same payload, user pays gas once.

## Tests

- `npm test` — pure policy matrix, runs anywhere.
- `node --import ../nodehooks.mjs --experimental-strip-types test/e2e.ts` — full
  loop against anvil with forge-deployed contracts + sponsor funding (see
  `e2e.ts` header for env). The `--import ../nodehooks.mjs` resolves viem from
  `apps/web/node_modules`; it is harmless once a junction exists.
