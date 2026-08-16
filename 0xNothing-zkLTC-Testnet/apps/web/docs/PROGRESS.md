# 0xNothing Frontend Optimization Progress

**Started:** 2026-08-16
**Scope:** `apps/web` (Next.js 15 App Router, wagmi 3.7.5, TanStack Query 5, React 19)
**Constraints:** Keep all product areas (0xFi / 0xPump / 0xPixel); keep current URLs; no feature removal.
**Reference report:** See parent conversation transcript for full audit findings.

---

## Phase 1 — Quick Wins (IN PROGRESS)

### Dead code removed
- [x] `app/globals.css.bak`
- [x] `features/fi/components/ProtocolOverview.tsx` (zero imports verified)
- [x] `app/api/contract-stats/route.ts` + directory (zero client calls verified)
- [x] `features/fi/lib/format.ts::formatUsd` (zero imports verified)

### Load-speed fixes
- [x] Added `<link rel="preload" href="/fonts/DepartureMono-Regular.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />` to `app/layout.tsx` so Departure Mono fetches before CSS parse.

### Realtime polling added (`refetchInterval: 15_000`)
- [x] `features/pump/components/PumpStatsDashboard.tsx` — `adminQuery`, `governanceQuery`, `claimableQuery`
- [x] `features/fi/components/PoolDetail.tsx` — `lpBalanceRead`, `stakedLpRead`, `reserveRead`
- [x] `features/fi/lib/hooks/useAssetBalance.ts` — native balance + ERC-20 balanceOf

### Stale build cleanup
- [ ] Delete `0xNothing-zkLTC-Testnet/0xFi/web/{.next,.next-live,.next-v2,.next-v3,.next.audit-stale}` (user-approved; these are build artifacts from a sibling web copy, not source)

### Verification
- [ ] `npx tsc --noEmit` clean
- [ ] `npx eslint` on touched files clean

---

## Phase 2 — Batching & StaleTime (PENDING)

- [ ] `features/pump/components/TokenDetail.tsx`: replace `staleTime: Infinity` with `staleTime: 5 * 60 * 1000` at lines 53, 67, 72, 77 (4 graduation reads).
- [ ] `features/pump/components/NusdOraclePanel.tsx`: batch 9 NUSD reads + 3 oracle adapter reads into 2 `useReadContracts` calls (currently 12 separate `useReadContract`).
- [ ] `features/pump/components/TokenDetail.tsx`: batch 9 graduation reads into 2 `useReadContracts` calls.
- [ ] `lib/liveData.ts`: add `readPriceWad`, `isFresh`, `quoteMint`, `quoteRedeem` to `MUTABLE_CONTRACT_READS` so LiveSync block invalidation covers oracle reads.
- [ ] Verify: tsc + eslint.

---

## Phase 3 — Deduplication (PENDING)

Internal only — no URL changes.

- [ ] Merge `features/fi/lib/errors.ts` + `lib/errors.ts` into a shared errors module.
- [ ] Merge `features/fi/lib/format.ts` + `features/pump/format.ts` into a shared format module.
- [ ] Consolidate three `shortAddress` / `shortenAddress` implementations into one.
- [ ] Merge two Toast systems (fi's `@fi/components/Toast` and pump's `@/components/Toast`) into one shared primitive.
- [ ] Update all imports across codebase.
- [ ] Verify: tsc + eslint + manual smoke test of both products.

---

## Phase 4 — Internal Reorganization (PENDING)

**URLs stay stable.** No route renames; no API path moves unless every fetch site is updated consistently.

- [ ] Consider colocating feature code under features/ while keeping `app/0xFi/`, `app/0xPump/`, `app/0xpixel/` page routes intact.
- [ ] Extract pixel-specific code out of `lib/` into `features/pixel/` (abi.ts, marketplaceAbi.ts, gridParser.ts, onchainMarketplace.ts, marketplaceSubgraph.ts, pixelImage.ts, erc721Metadata.server.ts).
- [ ] Merge `config/wagmi.ts` wrapper into `lib/wagmi.ts` (or vice versa) — currently a 1-file indirection.
- [ ] Verify: tsc + eslint + runtime routing check.

---

## Phase 5 — Performance & Polish (PENDING)

- [ ] Wrap `features/pump/components/PumpDiscover.tsx::TokenCard` in `React.memo` with custom comparator.
- [ ] Virtualize PumpDiscover market list (react-window or @tanstack/react-virtual) — currently renders up to 200 cards via `.map()`.
- [ ] Remove woff fallback from `app/globals.css` `@font-face` (woff2-only; evergreen browsers). Optionally delete `public/fonts/DepartureMono-Regular.woff`.
- [ ] Split `app/globals.css` (~9,710 lines) into reset/variables + per-feature CSS modules.
- [ ] Extract `MarketplacePage` component from 1,011-line `app/0xpixel/marketplace/page.tsx`.
- [ ] Split `features/pump/server/data.ts` (1,391 lines) into domain modules.
- [ ] Update this doc with outcomes.

---

## Notes

- Cross-swap (via-NUSD bridge routing) was removed in the session immediately preceding this work. Files touched: `features/fi/lib/hooks/useSwapRoute.ts`, `features/fi/components/SwapWorkspace.tsx`, `features/fi/lib/hooks/useDexFeeSchedule.ts`. Typecheck/lint clean. Not yet committed.
- Nothing in this plan is committed until the user asks. Each phase ends with verification only.
- The audit workflow surfaced 33 adversarially-verified findings; 6 verify agents hit rate limits and should be re-checked manually if relied upon (see transcript for IDs).
