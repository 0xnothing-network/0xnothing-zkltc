# 0xNothing audit checkpoint — 2026-09-07

The implemented fixes have passed local integration checks. The original request to read every file is still broader than the completed semantic review: 880 files in the vendored OpenZeppelin checkout remain inventoried but not fully reviewed. No claim of a complete third-party security audit is made.

## Implemented behavior changes

- Wallet verifies that a derived/imported signing key matches the requested public account metadata, validates untrusted typed-data display fields, and persists Android backup exclusions through Capacitor regeneration. Store showcase source metadata and Android scaffold test package were aligned with configured values.
- Wallet 24h fallback snapshots are now isolated by account and complete network profile. A regression demonstrated an incorrect +800% instead of -10% after switching networks. Unscoped legacy samples are ignored; they are not deleted. See wallet-snapshot-followup.md.
- 0xFi transactions recheck account, connector and actual wallet network before writes, retain a submitted transaction hash on partial failure, and refresh balances after any confirmed step. Amount parsing rejects excess significant fractional precision and uint256 overflow; large unlock timestamps render safely. Pool creation fails closed when token/pair reads fail. Asset selection supports consistent keyboard cycling, Escape and Tab behavior.
- 0xPump balances cannot carry over from a previous wallet. Trade, creation, NUSD mint/redeem, graduation and fee claim recheck wallet identity across asynchronous steps and bind writes to account/chain. Token metadata has runtime type validation. Mobile navigation closes on Escape, outside click and route change.
- 0xPixel approval completion no longer repeatedly resubmits listing after rejection. Originality checks distinguish loading/error/available/taken and can be retried. Marketplace requests enforce ownership so aborted work cannot replace newer results; changing activity filters clears the previous Load more state. Canvas symmetry previews match painted pixels for even brush sizes; clipboard failure is caught without prematurely closing export controls.
- API candle intervals reject inherited object property names. Marketplace metadata falls back to successful RPC metadata when indexed image data is empty.
- Both MathX copies correctly return floor(sqrt(2))=1. Lending liquidation no longer rounds low-decimal collateral payouts up excessively; debt-share rounding and exhausted-collateral accounting are covered by regression/fuzz tests. Marketplace subgraph handles ListingInvalidated using existing cancellation bookkeeping; root verify now includes its regression suite.

## Captured verification

| Check | Result |
| --- | --- |
| Root npm run verify | Exit 0, session 52436, completion be0bf3; final-verify.log |
| Root tooling | 11 tests passed |
| Web tests | 108 tests passed |
| Testnet / Mainnet / 0xFi Solidity | 70 / 72 / 142 suite tests passed |
| Marketplace mapping | 4 regression tests passed, codegen/build passed |
| 0xFi operations | 28 tests passed |
| Web | TypeScript, ESLint, production build passed in root verify |
| Wallet after final network-snapshot fix | 105 tests, TypeScript and production build passed; wallet-followup-verify.log; exit 0, session 96445, completion a634c4 |
| Android checks from wallet scope | Build/sync, manifest/resources and instrumented Java compilation passed; no device execution |
| Production HTTP smoke | 200 on /, /0xFi, /0xPump, /0xpixel, /privacy and /api/health |
| Browser interactions | 0xFi keyboard selector and 0xPump mobile navigation passed targeted checks; browser-checks.md |
| Style preservation | All 9 baseline CSS SHA-256 values unchanged; Pump component JSX preservation and Canvas style/class attributes separately checked |
| Whitespace | git diff --check passed |

The full root verification preceded the last isolated wallet snapshot fix. The final wallet verification supersedes its wallet result and includes the complete wallet test/type/build chain. Fork tests may return early when the RPC environment variable is unset, so Solidity counts do not prove live-fork execution.

## Coverage and remaining scope

All 674 baseline first-party inventory entries now have a ledger record. Code/config/docs/CSS were read directly; 41 identical contract copies reused fully read canonical content with SHA verification. Lockfiles use structured metadata review. Two SVG entries classified as first-party by the initial inventory were reviewed as XML assets, not executable source: no script/foreignObject/event attributes.

The 18 OpenZeppelin files transitively imported from the 24 0xFi source roots were read in full (137,037 bytes). production-vendor-reviewed.json records hashes and full ranges. Review covered ownership handoff, token balance/allowance accounting, safe-call handling, reentrancy storage, signatures, arithmetic and checked casts. No additional demonstrated defect was patched in this subset. The other 880 vendor files remain outside completed semantic review, including mocks, tests, ancillary contracts, generation/release tooling, documentation and binary assets.

The three delegated scope reports are supplemented by root integration and the wallet snapshot follow-up. Their older counts/limits describe their own snapshots; verification-result.json and this checkpoint describe the combined result.

Graft was refreshed. Codebase Memory reported metadata changes for edited files and excluded vendor paths; direct source reads provide the evidence for those files. Neither graph metadata nor test success establishes absence of defects.

Original dirty edits in scripts/lib/generated-cleanup.mjs and scripts/test/tooling.test.mjs were preserved. No commit, deployment, contract broadcast, wallet signing, store publication or live chain reconfiguration was performed. Existing raster store exports were not regenerated. Broader live-wallet/mobile-device/visual coverage and the remaining vendor inventory are still outstanding.
