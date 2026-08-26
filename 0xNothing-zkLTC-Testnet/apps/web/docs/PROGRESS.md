# 0xNothing Frontend Optimization Progress

**Started:** 2026-08-16
**Last verified:** 2026-08-26
**Scope:** `apps/web` (Next.js 15 App Router, wagmi 3.7.5, TanStack Query 5, React 19), plus the
ops-script and network-config areas recorded below: `0xFi/scripts`, `contracts/script`,
`contracts/scripts`, `config/networks`.
**Constraints:** keep all product areas (0xFi / 0xPump / 0xPixel), keep current URLs, no
feature removal, no UI copy or layout change.
**Verification gate:** every batch ends with `npx tsc --noEmit`, `npm run lint`, and
`npm run build`; batches touching `0xFi/scripts` also end with `node scripts/check-scripts.mjs`
and `node --test scripts/test/*.test.mjs`. Nothing is committed until asked.

## Build baseline

`npm run build` on 2026-08-26: exit 0, 30/30 static pages generated.

| Metric | Value |
| --- | --- |
| Heaviest routes (First Load JS) | `/0xFi/pools/[pair]` 252 kB, `/0xFi/swap` 249 kB, `/0xFi` 249 kB |
| Shared chunk | 103 kB |
| Middleware | 34 kB |

Compare against these numbers after any dependency or route change. The per-route **Size**
column moves ±1-3 kB between builds as chunk boundaries are re-split; First Load JS, the
shared chunk, and the middleware are the stable figures to watch.

## Realtime — how it works now

Per-component `refetchInterval` timers were replaced by one block-driven invalidation
pass, so a value refreshes because the chain moved, not because a timer fired.

- `LiveSync` in [app/providers.tsx](../app/providers.tsx) polls `useBlockNumber` every
  `BLOCK_SYNC_MS` (10 s) plus up to 2 s of random offset. On a new block it invalidates
  only queries that are observed, not already fetching, and pass
  `isBlockSyncedQueryKey`.
- [lib/liveData.ts](../lib/liveData.ts) owns that predicate: every `["balance", …]` key,
  plus `readContract` / `readContracts` keys whose `functionName` is in the
  `MUTABLE_CONTRACT_READS` allowlist. Immutable reads are absent from the allowlist on
  purpose and are never re-fetched. **Adding a new mutable on-chain read means adding its
  function name here**, otherwise it renders once and goes stale.
- `invalidateAfterPumpTrade` in the same file gives a trade its immediate refresh
  without waiting for the next block.
- Poll jitter lives in [lib/pollJitter.ts](../lib/pollJitter.ts).
  [usePumpPolling.ts](../features/pump/hooks/usePumpPolling.ts) and
  [useFiPolling.ts](../features/fi/lib/hooks/useFiPolling.ts) are thin wrappers over it
  that only supply the section's base interval. One crypto-seeded `browserSeed` per
  browser spreads every section's refetch schedule, so a 0xPump tick cannot land on the
  same millisecond as a 0xFi tick.
- `/dev` is the one page outside that scheme, because its reads are diagnostics rather
  than product data. All 27 scalar reads now share a single module-scope
  `DEV_POLL_MS = jitteredPollInterval("dev-diagnostics", STEADY_LIVE_MS)`
  ([app/dev/page.tsx:54](../app/dev/page.tsx#L54)) instead of a `6000` literal each. Six
  seconds was faster than the 10 s block time, so roughly a third of those requests could
  only re-read a block the page had already seen. Aligning them on one value is
  deliberate: the transport batches with a 10 ms window, so reads that tick together
  leave as one JSON-RPC batch. The batched `useReadContracts` calls beside them keep
  their retry-only intervals (`15_000` / `60_000` / `false` via `batchNeedsRetry`).
- `usePumpMarkets` keys on `["pump-markets", limit, sort]` only. Search and status filter
  client-side behind `useDeferredValue`, with a `WeakMap` caching per-market
  normalization, so typing in the market search never issues a request. A full address
  typed into that box triggers one extra by-address lookup.

### The `isFetching` trap

Block-driven invalidation makes `isFetching` a **recurring** state, not a one-off. Any
control gated on `query.isFetching` therefore disables itself for the length of an RPC
round trip on every new block, with a valid value already on screen. Gate on `isLoading`
instead — it is false for a disabled query and true only until the current key has a
value, which is what "no quote yet" actually means.

Fixed under this rule:

- [TradePanel.tsx](../features/pump/components/TradePanel.tsx) — the 0xPump buy/sell
  button. The old expression also OR-ed both quote reads regardless of the selected side;
  it now reads one `activeQuote`, which the retry button and the post-trade refresh share.
- [PumpStatsDashboard.tsx](../features/pump/components/PumpStatsDashboard.tsx) — the
  admin fee claim button, plus a `query: {}` literal that did nothing.
- [DynamicPoolDetail.tsx:759](../features/fi/components/DynamicPoolDetail.tsx#L759) — the
  pool-detail swap button. `!swapAmountOut` beside it already covers the no-quote case.

In every case the write path re-derives its minimum output from the displayed quote and
applies the user's slippage setting, so a quote one block old cannot execute badly — it
reverts. The `helper={swapQuote.isFetching ? "Refreshing quote" : undefined}` at
[DynamicPoolDetail.tsx:732](../features/fi/components/DynamicPoolDetail.tsx#L732) is left
alone: that copy exists to report exactly this state and it gates nothing.

## Load speed — what is in place

- **Fonts.** `DepartureMono-Regular.woff2` is preloaded from
  [app/layout.tsx](../app/layout.tsx) so it fetches before CSS parse. The `woff`
  fallback and its `@font-face` source were dropped; the build targets evergreen
  browsers only.
- **RPC preconnect.** `app/layout.tsx` opens the socket to `LITVM_RPC_URL`'s origin while
  the document parses. Every contract read leaves the browser for that origin and the
  first one only starts after hydration, so this removes a cold DNS + TLS round trip from
  the first on-chain number a page shows. The Goldsky subgraphs are read server-side only
  and need no preconnect.
- **Image config.** [next.config.ts](../next.config.ts) restricts `next/image` to the one
  bundled cover (`localPatterns`) and keeps `remotePatterns` empty. Token logos and IPFS
  art are deliberately plain `<img>`: the same-origin IPFS proxy must skip the optimizer,
  which can run on a separate host in production and turn a healthy proxy response into a
  misleading `/_next/image` 404.
- **IPFS logo proxy** ([app/api/pump/image/route.ts](../app/api/pump/image/route.ts)).
  Hedged `Promise.any` over two gateways with a 650 ms hedge delay, magic-byte and
  dimension validation, immutable one-year cache with a content-addressed
  `"pump-<cid>"` ETag, and an inline SVG fallback served `no-store`. Gateway timeout is
  10 s — a logo is capped at 2 MB, so a gateway silent past that is stalled, not slow —
  and a failing CID is backed off for 20 s so one dead pin cannot re-enter the full wait
  on every grid render. `If-None-Match` is parsed per RFC 9110 (list form, weak
  comparison) so a revalidation returns 304 instead of a gateway round trip.
- **Logo components.** [PumpTokenLogo.tsx](../features/pump/components/PumpTokenLogo.tsx)
  and [TokenLogo.tsx](../features/fi/components/TokenLogo.tsx) are `memo`ised, keep their
  URL parsing in `useMemo` so it stays off the block-sync re-render path, hold lookup
  tables at module scope, and clear a stale load failure during render rather than in an
  effect — a new source paints as an image on its first commit instead of flashing the
  letter fallback for one frame.
- **Code splitting.** Charts load through
  [LazyMarketChart.tsx](../features/fi/components/LazyMarketChart.tsx) and
  [LazyPumpChart.tsx](../features/pump/components/LazyPumpChart.tsx).
- **Server modules.** `features/pump/server/data.ts` was split into `data.ts` (query entry
  points) plus `graph.ts`, `rpcMarkets.ts`, `rpcTrades.ts`, `rpcHolders.ts`,
  `aggregate.ts`, `holders.ts`, `values.ts`, `constants.ts`. Behaviour and route table
  unchanged.
- **Market grid.** `TokenCard` is `memo`ised with an explicit field comparator
  ([TokenCard.tsx:90](../features/pump/components/TokenCard.tsx#L90)), so a block tick
  that changes one market re-renders one card.
- **Server cache eviction.** [lib/boundedCache.ts](../lib/boundedCache.ts) documents
  insertion order as LRU order, but only `get` re-inserted the key it read; `entry` did
  not. `withPumpCache` in [features/pump/server/cache.ts](../features/pump/server/cache.ts)
  reads *exclusively* through `entry`, so its 512-key cache was really FIFO by write time
  — a market served on every grid render could be evicted ahead of a cold key written more
  recently. Both paths now go through one `touch` helper. The other multi-key `entry`
  callers, `app/0xFi/api/data/activity` and `app/api/marketplace/activity`, were affected
  the same way; the four single-key callers never could be.
- **Static copy out of a block-synced hook.**
  [useLendingPoolStatus.ts](../features/fi/lib/hooks/useLendingPoolStatus.ts) rebuilt an
  eleven-entry title/message/label table on every render, and its `useReadContracts` batch
  contains allowlisted names (`borrowRate`, `activated`, `supplyPaused`, …), so that meant
  every block. The table is now a module-scope `STATUS_COPY`, string-for-string identical.

### Dead CSS purge — all seven stylesheets

Every stylesheet in `apps/web` had grown the same way: theme passes stacked on top of one
another, each re-declaring the previous with `!important`. The root layout loads
`app/globals.css` on every route, so it was the largest render-blocking asset in the app;
each route sheet is the second one on its own route. Baseline below is `git show HEAD`.

| stylesheet | lines | bytes |
| --- | --- | --- |
| `app/globals.css` | 3,366 → **1,818** (−46%) | 81.5 → 41.6 kB |
| `app/home.css` | 2,581 → **926** (−64%) | 64.4 → 20.3 kB |
| `app/0xFi/globals.css` | 3,130 → **3,051** (−3%) | 66.1 → 64.7 kB |
| `app/0xFi/shared.css` | 497 → **143** (−71%) | 12.6 → 3.5 kB |
| `app/0xpixel/globals.css` | 3,104 → **1,590** (−49%) | 78.2 → 38.3 kB |
| `app/0xPump/globals.css` | 2,039 → **1,991** (−2%) | 69.4 → 67.3 kB |
| `app/docs/docs.css` | 1,320 → 1,320 (already clean) | 24.3 kB |
| **total** | **16,037 → 10,839 (−32%)** | **396.5 → 260.1 kB** |

The two −2/−3% sheets are not a failed pass: `0xFi/globals.css` and `0xPump/globals.css`
were written once each rather than restacked, so they had almost no shadowing to exploit.
That is a result, not a gap — re-auditing them for shadowed declarations will find nothing.

Nothing was deleted by eye. Four separate tests, each conservative, each machine-checked:

1. **Fully shadowed rules and declarations.** For two rules with *byte-identical selector
   text* the match set and specificity are identical, so the later declaration of a property
   always wins when its importance is `>=`. Such an earlier declaration can never be the
   cascade winner for any element, so removing it cannot change a computed value. 130 of 343
   top-level rules were dead by that test, plus 136 individual declarations inside surviving
   rules — among them 221 of 330 `:root` custom-property declarations, spread over 18
   competing `:root` blocks. A progressive-enhancement guard refuses the deletion whenever the
   *winning* declaration uses value syntax the loser does not (`color-mix`, `oklch`, `dvh`,
   `env()`, `clamp()`, `min()`, `max()`, `fit-content`); `all` is always refused. At-rule bodies
   are treated as opaque and never count as a shadow.
2. **Pseudo-elements that are never generated.** With no winning `content` declaration,
   `content` stays at its initial value and the pseudo-element is not generated at all — so its
   whole block is inert. On `app/globals.css` that was `body::before` / `body::after`:
   `display: none !important` was declared for both and no later rule re-declared `display`, so
   roughly twenty blocks describing a fixed grid overlay and a scanline layer did nothing.
   Dropping their `content` declarations too leaves `content: normal`, i.e. the same result with
   none of the work. The universe check is exhaustive: across all seven sheets there is no
   single-colon `:before`/`:after`, no `<style>` block in any `.tsx`, and no Tailwind
   `before:`/`after:` variant applied to the elements involved.
3. **Zero-consumer classes.** Because `a, b { … }` is equivalent to `a { … } b { … }`, removing
   a selector-list member that can never match changes nothing, and a rule left with no
   surviving member is removed whole. In `app/globals.css` that was `.gradient-text`,
   `.glow-indigo`, `.glow-emerald`, `.bg-gradient-radial`, `.glass`, `.card-hover`,
   `.stagger-children`, `.skeleton-pixel`, then `.toast-progress`,
   `.animate-fadeInUp-delay-1`, `.animate-fadeInUp-delay-3` and `.titlebar-btn`.
   `.gradient-text` was worse than unused: a later pass killed its gradient but left
   `-webkit-text-fill-color: transparent`, so using it would have rendered invisible text.
   **The hazard here is inversion, not absence.** A class that can never appear makes
   `:not(.dead)` *always true*, so deleting it would match **more** elements. The pass computes
   the byte ranges of every `:not()`, `:is()`, `:where()` and `:has()` argument list and refuses
   any match that falls inside one. A coarse "contains `:not(`" guard was tried first and
   blocked ten legitimately dead selectors, which is why the check is position-aware.
4. **Orphan `@keyframes`.** A keyframes rule has zero rendering effect unless some
   `animation-name` references it. Keyframes are global, so detection scans the whole app tree;
   CSS-module keyframes are hashed and scoped, so `dev.module.css`'s `shimmer` binds to its own
   copy and does not keep a global one alive. Removed: three duplicate `pixelLoaderBlock`
   definitions and one duplicate `pixelLoaderLogo` (for a repeated animation name only the last
   definition applies), then `pixelSkeletonSweep`, `homeFadeIn`, `shimmer`, `pixelHomeEnter`,
   `pixelTitlePulse`, `toast-progress` and `pixelLoaderStep` — the last two orphaned by the
   class deletions above. A grep for `animationName`, template-built animation names and
   `animation:` shorthands confirmed no animation name is constructed dynamically anywhere.
   Zero orphan keyframes remain in `apps/web`.

**The verification invariant that matters.** For every *individual surviving selector* and
every property, the ordered sequence of `value + importance` in document order must be
byte-identical before and after. Keying on full selector text instead is wrong — it silently
passes selector-list edits — and the first version of the checker did exactly that and reported
38 phantom regressions on `app/globals.css`. For the shadowing passes the map came out at 561
of 561 entries byte-identical with all 46 at-rule blocks unchanged; the pseudo-element,
unused-class and keyframes passes change the map by design, and every difference was attributed
to a named deletion.

**Kept on purpose.** `.rounded-sm`, `.rounded-3xl`, `.text-transparent`, `.bg-clip-text` and
`.min-h-screen` in `app/globals.css` have no consumer in the app, but they are overrides of
Tailwind utilities that exist to enforce the pixel aesthetic if anyone ever writes one. They are
guards, not dead code.

**Deliberately not done:** cross-selector shadowing — `[class*="bg-[#1A1A2E]"]` covering
`.bg-\[\#1A1A2E\]`, `html, body` covering `body`, and so on — would roughly double the saving
but needs per-pair match-set reasoning, where one mistake is a visible regression on every
route. That wants visual regression testing, not a proof script.

**Gate.** `npx tsc --noEmit` exit 0 · `npm run lint` clean · `npm run build` exit 0 with 30/30
static pages · a PostCSS parse of all seven sheets clean with zero empty blocks and balanced
braces · zero orphan keyframes remaining. Route payloads are byte-for-byte at the baseline:
shared 103 kB, middleware 34 kB, `/0xFi` 249 kB, `/0xFi/swap` 249 kB, `/0xFi/pools/[pair]`
252 kB, `/dev` 244 kB, `/` 111 kB, `/docs` 114 kB. Unchanged route payloads with 32% less CSS
is the expected outcome — Next.js reports JS there, and the CSS win is in bytes parsed before
first paint, not in the bundle table.

## Ops scripts and network config — `0xFi/scripts`, `contracts/script`, `config/networks`

Same rule as the app: no behaviour change, only dead code out and duplicated code into one
place. Gate for this area is `node scripts/check-scripts.mjs` (`node --check` over every
`.mjs` under `scripts/**`) plus `node --test scripts/test/*.test.mjs`: **28 scripts, 23/23
tests passing.**

- **`0xFi/scripts/lib/rpc.mjs` — new, one fail-closed source of truth for RPC endpoints.**
  Eight sites each repeated `(process.env.LITEFORGE_RPC_URL || network.rpcUrl).trim()`, which
  throws a bare `TypeError: Cannot read properties of undefined (reading 'trim')` when neither is
  set — the one error message that does not tell you what to configure. `primaryRpcUrl()` /
  `fallbackRpcUrl()` now throw `LITEFORGE_RPC_URL is not configured`, naming the variable.
  `RPC_BATCH_OPTIONS` (`batch: { batchSize: 100, wait: 10 }`) is applied at the same time; none
  of the eight had batching, and `audit-live.mjs` and `graduation-keeper.mjs` issue hundreds of
  `eth_call`s per pass. Resolution order is env → `network.fallbackRpcUrl` → per-script default,
  which reproduces every previous call site exactly; verified by diffing old expression against
  new for both endpoints. Each site keeps its own `timeout`/`retryCount`, so the only behaviour
  changes are batching and the named failure. Eleven files now import it, including
  `lib/graduation-runtime.mjs`, whose `loadRuntime()` client is what every audit and keeper uses.
- **`0xFi/scripts/lib/spawn-step.mjs` — new.** The same 14-line `spawn` wrapper was duplicated in
  `deploy.mjs`, `direct-governance.mjs`, `migrate-lending-fixed-rate.mjs` and
  `migrate-synth-safety-reserve.mjs` (the fourth differing only in ternary-vs-`if`/`else` style).
  Each file now keeps a one-line `const run = …` adapter, so **every call site is unchanged** —
  which matters because `operations.test.mjs` asserts on `direct-governance.mjs`'s call site text.
- **`audit-live.mjs`: ~38 sequential RPC round trips → ~6.** The bytecode probe walked 24
  addresses with `await` inside a `for` loop, so the batching transport could never group them —
  a batch scheduler only merges calls issued inside the same window, and a sequential `await`
  resolves each one first. That loop plus the `collateral`, `pools`, `vaults` and
  `retiredSynthMarkets` loops are now `Promise.all` over the same definition arrays, order
  preserved by index. Every read is a `view` call with no cross-iteration dependency, so all
  computed verdicts are unchanged; a live run against the testnet returns `blockingIssues: []`,
  `operational: true` in ~5.5 s.
- **`0xFi/scripts/migrate-finalize.mjs` — deleted (477 lines).** Not in `package.json`, never
  spawned, never imported, absent from every doc. Its target `MigrateRemoveGuard.s.sol` is now a
  12-line stub that reverts `DeprecatedMigration()`, so the finalizer could never usefully run
  again — but it *could* still rewrite `contracts/deployments/latest.json`,
  `config/liteforge-testnet.json`, the subgraph config and `apps/web/.env.local` from a spent
  prediction. The stub itself was kept: preventing accidental replay is its entire purpose.
- **`config/networks/liteforge-testnet.json` — corrected.** This file has zero code consumers;
  `README.md` presents it as the public network configuration, i.e. what an integrator copies, so
  it is hand-maintained and had drifted. `dia.ltcUsdAdapter` was mislabeled — `0x45dDa5…` is the
  DIA *feed* (it is `DEFAULT_DIA_LTC_USD_FEED` in `DeployTestnet.s.sol` and `dia.feeds.wzkLTC`),
  while the project's own `DIAOracleAdapter` is `0x3579b31e…`; the key is now split into
  `ltcUsdFeed` and `oracleAdapter`. `graduationMigrationEnabled: false` with
  `graduationAdapter: null` contradicted both the deployment manifest (`enabled: true`,
  `operational: true`) and the README's own prose; it now records the live adapter and
  controller. A cross-validation pass then confirmed **17/17 fields** against
  `0xFi/config/liteforge-testnet.json` and `deployments/liteforge-testnet/deployments.json`,
  including the pump economics (1500/6000/1500 NUSD, 1 NUSD create fee, `tradeFeeBps: 10` matching
  `ZeroXPump.TRADE_FEE_BPS`).
- **`contracts/broadcast/DeployRewardStackTestnet.s.sol/` — deleted (792 kB, 9 JSON journals).**
  Untracked Foundry artifacts for the reward stack that was removed on request; the script no
  longer exists and nothing references it. `contracts/broadcast/` now holds only
  `DeployTestnet.s.sol`.
- **Reviewed and left alone.** `graduation-keeper.mjs` (139 lines) has no correctness bug: the
  `--once`/`--dry-run` exit 1 on `!operational` is intended fail-closed behaviour, `ready.slice(0,
  maxPerScan)` is bounded, and the `Math.min(2 ** consecutiveFailures, 15)` backoff resets to 1 on
  success. `DeployCommunityTools.s.sol` looks orphaned — no `.mjs` wrapper spawns it — but it is
  the live deployer for `CommunityLiquidityLocker` and `TokenMetadataRegistry`, both of which the
  web app reads through `lpLocker` / `tokenMetadataRegistry` in
  `features/fi/config/testnet.generated.json`, and all five addresses it pins still match the
  deployment manifest. `contracts/scripts/Finalize-TestnetDeployment.ps1` is documented at
  `contracts/README.md` and already fails closed on a missing `LITVM_RPC_URL`.

## Bugs fixed

- **Wheel zoom also scrolled the page** on the 0xPixel canvas
  ([Canvas.tsx](../features/pixel/components/Canvas.tsx)). React attaches its root `wheel`
  listener as passive, so the `preventDefault()` inside the `onWheel` prop was silently
  discarded — the canvas zoomed and the page scrolled under it at the same time. Zoom is now
  bound natively with `{ passive: false }`; same 1.2 step, same 0.5–10 clamp.
- **Two wallet prompts for one wrong network.**
  [MintPanel.tsx](../features/pixel/components/MintPanel.tsx) and
  [PixelHeader.tsx](../features/pixel/components/PixelHeader.tsx) each ran an auto
  `switchChain` effect and `app/0xpixel/layout.tsx` mounts both, so a wrong chain fired two
  toasts and two `switchChain()` calls. The panel's copy of the effect is gone; the header
  keeps it, and `handleMint`'s own guard still covers a chain change between mount and submit.
  `MintPanel` now imports `LITVM_CHAIN_ID` from [lib/chainSwitch.ts](../lib/chainSwitch.ts)
  instead of redeclaring it.
- **Both charts fell back to a default font.** `CanvasRenderingContext2D.font` does not
  resolve CSS custom properties, and lightweight-charts assigns `${fontSize}px ${fontFamily}`
  straight to it, so the `var(--font-departure)` both charts passed was dropped on the floor.
  The literal stack now lives in [lib/chartTheme.ts](../lib/chartTheme.ts), shared by
  `PumpChart` and `MarketChart`.
- **`--font-mono` referenced itself** inside the `@theme inline` block of `app/globals.css`. A
  self-referencing custom property computes to the guaranteed-invalid value, so every
  `var(--font-mono)` without a fallback was invalid at computed-value time. The declaration is
  gone; `next/font` supplies the family from an unlayered rule, which outranks everything in
  `@layer`, so nothing on screen moved.
- **Regex state and per-keystroke scanning** in
  [AIPromptGenerator.tsx](../features/pixel/components/AIPromptGenerator.tsx). The pixel count
  is a `useMemo` now, and each parse builds a fresh `RegExp` — a shared `/g` literal carries
  `lastIndex` between calls, so a second parse would have started mid-input.
- **Non-passive `resize` and `scroll` listeners** for the header's address-menu repositioning
  ([PixelHeader.tsx](../features/pixel/components/PixelHeader.tsx)) are passive now; neither
  handler calls `preventDefault()`.

## Removed

Each was confirmed to have zero importers or callers before deletion.

- `app/globals.css.bak`
- `features/fi/components/ProtocolOverview.tsx`
- `app/api/contract-stats/route.ts` and its directory
- `features/fi/lib/format.ts::formatUsd`
- `public/fonts/DepartureMono-Regular.woff`
- `app/0xFi/api/data/farms/route.ts` and `app/0xFi/api/ipfs/upload/route.ts` — the two
  remaining `/api/ipfs/upload` call sites point at the root-level route, which stays
- the stale `.next*` build directories under the sibling `0xFi/web/` copy
- outside `apps/web`, on request: `0xFi/contracts/src/rewards` and
  `0xFi/contracts/src/adapters`, together with the last references to the removed reward
  pool. No remaining Solidity source, test, script or ABI imports either directory.
- also outside `apps/web`: `0xFi/scripts/migrate-finalize.mjs` and
  `0xFi/contracts/broadcast/DeployRewardStackTestnet.s.sol/` — see the ops-scripts section
  above for why each is provably dead.

## Considered and deliberately kept as-is

Recorded so the same ideas are not re-litigated. Each was measured, not assumed.

- **`swapRoute.isFetching` in [useSwapRoute.ts:230](../features/fi/lib/hooks/useSwapRoute.ts#L230)
  and the oracle twin at [SwapWorkspace.tsx:321](../features/fi/components/SwapWorkspace.tsx#L321).**
  These look like the `isFetching` trap above and are not. `useSwapRoute` picks between a
  direct pair and a via-NUSD bridge by comparing two quotes, so a mid-refresh comparison
  can select the wrong *path*, not merely a stale price — slippage does not protect
  against that. The guard blanks `amountInQuoted`, which surfaces as the existing
  "Waiting for a quote for the current amount." validation string. The two fixed call
  sites above quote a single fixed route and have nothing to choose between.
- **`staleTime: Infinity` on four graduation reads** in
  [TokenDetail.tsx](../features/pump/components/TokenDetail.tsx) (`graduationRouter`,
  `pump`, `router`, `adapter`). Those four function names are intentionally absent from
  `MUTABLE_CONTRACT_READS`, so `LiveSync` never touches them and each is fetched once per
  session. The five gate reads beside them (`admin`, `graduationsPaused`, router `admin`,
  `enabled`, `isAdapterAllowed`) *are* allowlisted and refresh every block. Lowering the
  wiring reads' `staleTime` would add per-block RPC for values that change only on an
  admin handover.
- **Batching `NusdOraclePanel.tsx`'s twelve `useReadContract` calls into
  `useReadContracts`.** The transport in [lib/wagmi.ts](../lib/wagmi.ts) already sets
  `batch: { batchSize: 100, wait: 10 }`, so those reads leave the browser as a single
  JSON-RPC batch. A multicall rewrite would trade one HTTP request for one HTTP request.
- **Merging `lib/errors.ts` with `features/fi/lib/errors.ts`, and `components/Toast.tsx`
  with `features/fi/components/Toast.tsx`.** Both pairs render different user-facing
  strings, so a merge would change UI copy.
- **Folding `config/wagmi.ts` into `lib/wagmi.ts`.** It is a one-file indirection that
  costs nothing at runtime and is the single place the chain is defined — the natural
  parametrization point for a mainnet config.
- **Virtualizing the 0xPump market grid.** `PumpDiscover` requests `limit: 200` and each
  card is already `memo`ised. Revisit past a few hundred live markets.
- **Hoisting `Providers` to the root layout.** `dev`, `0xFi`, `0xpixel`, and `0xPump` each
  mount their own `QueryClient`. Sharing one is an architecture change, not an
  optimization.
- **Wrapping `TokenPairLogos` in `memo`.** Its `token0` / `token1` object props make the
  shallow compare always fail.

## Still open

Ordered by remaining value, highest first.

1. **Splitting the route sheets.** The dead-CSS work is finished on all seven (table above), so
   what is left is structural: `app/0xFi/globals.css` is still 3,051 lines and
   `app/0xPump/globals.css` 1,991, both because they were written once and correctly rather than
   restacked. Breaking each into reset/variables plus per-feature sheets would cut what a route
   parses before first paint, but it moves rules between files instead of proving them dead, so it
   needs visual regression testing rather than a proof script.
2. **Chain `4441` is declared in four independent places, and pinned in six more.** The
   declarations are `config/wagmi.ts` (`defineChain({ id: 4441 })`),
   `features/fi/config/deployment.ts` (`LITVM_CHAIN_ID`), `features/pump/config.ts`
   (`PUMP_CHAIN_ID`) and `lib/chainSwitch.ts` (`LITVM_CHAIN_ID` again) — four constants holding
   one number, so a mainnet config has four places to miss. Outside the app it is pinned in
   `0xFi/scripts/bootstrap-canonical-liquidity.mjs`, `finalize-lending-fixed-rate.mjs`,
   `finalize-synth-safety-reserve.mjs` and twice in
   `contracts/scripts/Finalize-TestnetDeployment.ps1` (including a literal `4441` inside the
   broadcast path), and `0xFi/contracts/script/DeployCommunityTools.s.sol` pins five testnet
   addresses as `constant`s. The chain-ID comparisons themselves are correct — the
   `a !== X || a !== b || a !== c` form is the right De Morgan expansion, not the tautology it
   resembles. `config/wagmi.ts` staying a separate one-file indirection is deliberate for exactly
   this reason: it is the natural parametrization point.
3. **`app/0xpixel/marketplace/page.tsx` is 1,018 lines.** Extracting the page component is
   mechanical but touches a lot of JSX.
4. **`/dev` has no auth and is prerendered public**, with fund and withdraw writes beside
   its ~28 reads. The polling half of this is fixed (see `DEV_POLL_MS` above); the access
   control half is untouched because gating the route is a core change.
5. **`/api/token-metadata` and `/api/listing-image` have zero callers.**
6. **`0xFi/web/` holds no tracked source but does hold a `.env.local`.**

## Notes

- Cross-swap (via-NUSD bridge routing) was removed before this work started. Files
  touched then: `features/fi/lib/hooks/useSwapRoute.ts`,
  `features/fi/components/SwapWorkspace.tsx`,
  `features/fi/lib/hooks/useDexFeeSchedule.ts`.
- Farm reward code is unrelated to the removed draw/prize pool and stays: `FarmDashboard`,
  `features/fi/lib/abis/farm.ts`, and the reward function names in `lib/liveData.ts`
  (`rewardRate`, `periodFinish`, `earned`, `totalFunded`, `totalPaid`,
  `pausedRewardDuration`) are all live gauge reads.
