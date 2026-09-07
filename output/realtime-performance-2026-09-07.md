# Web and wallet realtime performance — 2026-09-07

Implemented locally; no production deployment or extension-store publication.
UI/style and on-chain contracts were not modified.

## Changes

- Web pool API starts independent oracle and candle reads alongside pool discovery.
- A successful factory discovery is reused within a response instead of scanning twice when the indexer is unavailable and the RPC tail is capped. Failed discovery remains retryable.
- Optional 0xFi log requests use a separate unbatched HTTP client, a 4-second timeout, and no transport retries. Existing indexed-data fallback and unavailable-tail warnings remain in place.
- Pool and pair-tail display RPC reads use a 5-second timeout with no transport retries, avoiding repeated 15-second stalls.
- Wallet price loading starts DEX reserve reads as soon as pair discovery finishes, independently of oracle and Pump reads. Price precedence and stale-price checks are preserved.
- Wallet Pump and 0xFi catalog fallback chains run independently while retaining API -> indexer -> on-chain order within each source.
- Wallet public reads use a 5-second timeout with no transport retries. Signing transport retains its existing 15-second timeout and two retries.

Shorter read timeouts can surface an error sooner during endpoint slowness. They do not guarantee a total route deadline because a route can contain several dependent reads. A failed RPC read is not treated as a valid zero balance or price.

## Validation

- Final `npm run verify`: exit code 0, captured from the process.
- Web: 115 tests passed; typecheck, lint, production build passed within root verification.
- Wallet: 112 tests passed; typecheck, app build and injected-script builds passed.
- Root contract, subgraph and tooling checks passed within root verification.
- `git diff --check`: passed.
- `graft build`: passed.
- A real HTTP regression leaves a local server response hanging and confirms the log transport aborts after approximately 4 seconds, sends one request, and does not batch it.

Full verification log: `realtime-verify-final-2026-09-07.log`.

## Live RPC / local production measurements

The final production build was served with `.next/standalone/server.js` on localhost and used the configured real RPC/indexer:

| Request | Result | Time |
| --- | --- | --- |
| `/0xFi/swap` document | HTTP 200 | 393 ms |
| `/0xFi/api/data/pools`, empty process cache | HTTP 200, MISS, 6 pools | 12,621 ms |
| Same pool request immediately afterward | HTTP 200, HIT, 6 pools | 22 ms |

Both pool responses disclosed `RPC tail is temporarily unavailable.` The endpoint was experiencing log-query failures. An earlier build without the log timeout isolation took about 100 seconds to complete a shared pool load; intermediate measurements were variable, including client timeouts. These are diagnostic samples, not a controlled production speedup claim.

The latest source-level run with real RPC/indexer returned a cold response in 9,725 ms. This was separate from the production HTTP measurement above. Browser rendering, user-wallet interaction, deployed CDN behavior, and live transaction flows were not benchmarked.

Raw final HTTP results: `realtime-smoke-final-2026-09-07.json`.

## Controlled before/after benchmark

The benchmark executes the actual prior HEAD/current orchestration code with identical delayed I/O fixtures; three runs per version. These numbers isolate removed sequential waits and are not production page-load timings.

| Pipeline | Before median | After median | Reduction |
| --- | --- | --- | --- |
| Wallet prices | 329 ms | 223 ms | 32% |
| Web pool envelope | 645 ms | 381 ms | 41% |
| Wallet catalog fallback | 316 ms | 207 ms | 34% |

Reproduce from repository root: `node output/realtime-benchmark-2026-09-07.cjs`.
Raw samples: `realtime-benchmark-2026-09-07.json`.

## Deliverables

- Updated source and regression tests are in the working tree, uncommitted.
- Built wallet: `0xNothing-zkLTC-Testnet/apps/wallet/dist`.
- Built web: `0xNothing-zkLTC-Testnet/apps/web/.next`.
- Changes need deployment/reloading the built extension to affect installed/live versions.
