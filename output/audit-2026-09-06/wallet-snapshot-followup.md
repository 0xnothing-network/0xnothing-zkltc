# Wallet network snapshot isolation

Root follow-up on 2026-09-07 after the integrated repository verification.

The local 24h fallback used an address-only storage key. Same-address portfolios on two networks contaminated both the sampling interval and the comparison baseline. The regression recorded 100 units on the first network and 1,000 on the second at the same time; one day later 900 units on the second network incorrectly produced +800% instead of -10%.

`recordSnapshot` and `change24h` now require the originating WalletNetwork. They compute a key from the existing complete networkIdentity plus normalized account before awaiting storage or locks. `usePortfolio` passes its captured network through both operations, including the asynchronous market-data fallback. Old address-only data remains stored but cannot be safely attributed and is ignored; a new local baseline must accumulate. Market-candle comparisons are unchanged. No JSX/CSS changed.

Three real-module regression tests failed before the change and all pass afterward: independent network samples, ignoring unscoped legacy samples, and isolating an edited RPC profile. Tests use Vite SSR and memory-backed storage with a controlled clock; no live RPC call or user storage write.

`npm run verify:wallet` completed exit 0 (session 96445, completion a634c4), including 105 tests, TypeScript and production wallet build. The earlier full repository `npm run verify` completed exit 0 (session 52436, completion be0bf3) before this localized wallet follow-up.

`quoteSend` still reads the mutable public client across awaits. Source tracing found its only current UI caller uses `useLiveRead` with address/network/RPC identity and discards superseded results. A user-visible mixed quote was not demonstrated, so no speculative transfer change was made.
