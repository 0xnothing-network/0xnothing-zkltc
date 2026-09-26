# Web loading and realtime maintenance — 2026-09-26

## Scope

Changes target the shared data layer used by 0xFi, 0xPump and 0xPixel. The checkout was clean at the start. No CSS, visible copy, contracts, transaction signing or deployment configuration was changed. This is targeted performance maintenance with repository verification, not a claim that every vendor/source file was audited or that production latency was benchmarked before and after.

## Changes

- Shared JSON reads now have a 20-second deadline covering response headers **and body**. Caller cancellation is forwarded, timers/listeners are cleaned up, and timeout errors release the current fetch so a later poll can recover. This covers Pump feeds/detail/portfolio, Fi pools/activity/charts, gallery reads, and now marketplace listings/activity.
- Marketplace listings and activity share the same JSON reader instead of repeating fetch/parse logic. Both refresh on network reconnection while visible. Cancelled/superseded listing requests cannot publish a late error.
- Portfolio balance cache identity uses sorted, exact token membership. A price update or reordered market feed no longer triggers a new balance scan. Membership changes still refresh balances, with existing account/network isolation preserved.
- Visibility refresh uses `cancelRefetch: false`: simultaneous consumers of the same cached query share its request instead of cancelling and restarting each other before React commits the new fetch state.
- Fi confirmed transactions invalidate pools/activity as well as mutable contract reads. Partial transactions with a confirmed step retain the existing refresh behavior.
- Earn/Points mutable reads (positions, reserves, locked balances, credits and pause flags) participate in block/transaction invalidation.
- The block ticker explicitly reads LitVM even when the connected wallet is currently on another chain.

## Regression evidence

- Real local HTTP server tests cover stalled headers, stalled JSON bodies, timeout recovery, caller cancellation, Request signal inheritance, API errors and malformed JSON.
- Real TanStack Query observers verify balance-cache reuse after price/order changes and request coalescing when two visible consumers refresh together.
- Transaction tests verify pool/activity/position/reserve invalidation and exclusion of immutable token symbols/unrelated Pump feeds.
- Web suite after functional changes: **122 passed, zero failures** (`realtime-web-tests-2026-09-26.log`).
- Final narrow rerun after test cleanup: **5 passed, zero failures** (marketplace refresh and protocol transaction).
- Web typecheck, lint and full production build passed.
- Root `npm run verify` exited **1** at wallet tests: **112/114 passed**. The failures are `tests/core/coreServices.test.ts:24` (source-regex assertion expects the previous unconditional partial-RPC failure behavior) and `tests/ui/i18n.test.ts:174` (undeclared untranslated keys, including `common.refresh` and Quantum keys). Wallet sources/tests are unchanged from the starting checkout (`git diff --quiet -- apps/wallet` equivalent returned 0).
- Earlier stages of root verification passed: tooling 11 tests, web 121 tests before the last visibility regression was added, testnet contracts 70, mainnet contracts 72, Fi contracts 142, Fi script tests 28, pixel mapping tests 4, subgraph builds, and web typecheck/lint/build. The final web suite was separately rerun with 122 passing tests.
- Wallet typecheck and production build were run independently after its failing test stage; both exited 0. No wallet signing or source changes were made to bypass the two failures.
- `git diff --check` passed.

## Production build smoke on localhost

One local run, not a before/after benchmark and not production end-user performance. HTML response times exclude hydration, images and RPC reads. API cold/warm measurements mean first/second requests in this smoke session.

| Endpoint | First response | Second response | Result |
| --- | ---: | ---: | --- |
| `/` | 204 ms | — | HTTP 200 |
| `/0xFi/swap` | 21 ms | — | HTTP 200 |
| `/0xPump` | 21 ms | — | HTTP 200 |
| `/0xpixel/marketplace` | 19 ms | — | HTTP 200 |
| `/0xFi/api/data/pools` | 8,798 ms | 11 ms | HTTP 200, 6 pools |
| `/api/pump/stats` | 428 ms | 7 ms | HTTP 200 |
| `/api/marketplace/listings` | 4,955 ms | 12 ms | HTTP 200, 399 listings |

Pools explicitly report `24h volume is unavailable while the RPC tail is capped.` This upstream limitation remains visible and was not masked as current volume data.

Browser smoke rendered Swap, the six-market pool directory, the 399-listing marketplace, and Pump's 200-item feed with protocol statistics showing 486 markets; no console errors were captured for those inspected views. No wallet was connected and no transaction was submitted. Regression tests cover cancellation/coalescing and post-confirmation invalidation; this browser check is not a live-trade end-to-end test. The temporary browser tab and local server were stopped afterward.

Evidence: `realtime-verify-2026-09-26.log`, `realtime-web-tests-2026-09-26.log`, `realtime-wallet-typecheck-2026-09-26.log`, `realtime-wallet-build-2026-09-26.log`, `realtime-smoke-2026-09-26.json`, and its reproducible `.mjs` script in this directory.

## Operational limits

The existing polling intervals, source precedence and caches remain. New on-chain/indexed data still depends on RPC/indexer availability and indexing delay. A 20-second stalled request now fails and can retry rather than remaining in the fetching state indefinitely; this is not a promise of instantaneous data or faster upstream infrastructure. Changes are local and have not been deployed.

The graph had stale filesystem metadata for inspected paths, so relevant implementation spans were read directly. `graft build` completed successfully after the functional changes.
