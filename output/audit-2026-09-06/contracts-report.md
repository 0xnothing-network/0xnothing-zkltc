# Contracts and subgraphs audit — 2026-09-07

First-party review in the six assigned contract/subgraph roots is complete. This is a local source review with targeted fixes and tests; the 898 vendored files have hash inventory only and are not counted as semantically audited.

## Coverage

Scope: Testnet/contracts, Mainnet/contracts, Testnet/0xFi/contracts, Testnet/subgraphs, Mainnet/subgraphs, Testnet/0xFi/subgraph (all prefixed 0xNothing-zkLTC- as applicable).

contracts-reviewed.json preserves baseline hashes and records current hashes. Its 213 baseline first-party files comprise 169 fully read files, 41 byte-identical copies reviewed via fully read canonical source, and 3 package-lock JSON files parsed in full and checked as structured dependency metadata. Three new regression files are separately marked authored_and_reviewed. No first-party files remain pending. Source, interfaces, test helpers, tests, deploy scripts, config, ABI/schema/manifests, deployment records and scoped docs are included. Generated/build/cache/node_modules/broadcast files are excluded.

contracts-lockfiles-review.json records full-lock parsing evidence. Root dependencies match package.json; all resolved dependencies use HTTPS registry.npmjs.org URLs and have integrity. Marketplace contains 504 package records including root; each Pump lock contains 500. Testnet/Mainnet Pump locks have identical non-root entries but differ in root name/version, so are not marked byte-identical. This is not a dependency security audit or claim of freshness.

contracts-vendor-hashes.json inventories 898 files, 12,672,662 bytes and 897 unique SHA-256 groups. The only duplicate is a LICENSE in nested erc4626-tests and halmos-cheatcodes. There are 433 Solidity files, 253 JavaScript files, plus docs/configs/specifications/images/PDFs. This full OpenZeppelin checkout includes mocks, tests, release tooling and nested libraries; deduplication does not materially reduce remaining semantic review. No vendor-read or vendor-security completion is claimed.

Graph coverage was checked across all 213 baseline first-party files. Most graph records reported metadata_changed, so full source reads and canonical hashes are the evidence. Incomplete Solidity library call edges were supplemented by exact source/reference reads.

## Confirmed fixes

1. MathX.sqrt(2) returned 2 instead of floor(sqrt(2)) = 1 in both network copies. The initial Newton candidate now uses `(value / 2) + (value % 2)`, preserving safety at uint256.max. Before-fix regressions failed; three tests pass per project afterward, including 512 fuzz runs and maximum integer bounds. ABI/storage unchanged. Existing Pump sqrtUp results at this input were already correct.

2. PooledNUSDLendingPool liquidation rounded both conversions upward, allowing a 1-wei NUSD repayment to seize two whole units of permitted zero-decimal collateral. Repaying 100 NUSD at a 70-NUSD collateral price seized three units despite a 5% bonus. Partial payouts now round down and reject zero payout. Exhausting collateral requires full value payment including debt-share rounding, within caller budget and close factor; existing bad-debt accounting still clears exhausted positions without dust. Two regressions failed before the fix; the final lending suite passes all 20 tests, including 512 fuzz runs across collateral decimals 0–18. ABI/storage, rate model and configured risk parameters are unchanged.

3. Marketplace ListingInvalidated events were absent from both subscription and mapping, leaving approval-revoked listings ACTIVE. The new subscription/handler shares existing cancellation bookkeeping, using the existing CANCELLED schema state. Four tests cover approval revocation, transfer followed by invalidation without double decrement, normal cancellation and manifest subscription. Before: three failed/one passed. After: four passed plus Graph codegen/build exit 0. Tests execute the real mapping source in a Node VM with mocked Graph entities; this is not Matchstick. Graph build separately checks AssemblyScript compilation.

4. Pump README candle lists now include the supported one-minute interval. Testnet README reflects committed controller-active graduation policy and deployment preflight rather than claiming migration is disabled. This describes repository policy, not live-state verification.

The old-listing cancellation/relisting issue was disproved by the contract precondition requiring old listings to be inactive before relisting. No speculative activeListing-ID guard change was made for that scenario.

## Validation

| Command / scope | Result | Evidence |
| --- | --- | --- |
| forge test — Testnet/contracts | exit 0; 70 tests, 12 suites | testnet-contracts-tests.log; exit captured in tool result |
| forge test — Mainnet/contracts | exit 0; 72 tests, 12 suites | mainnet-contracts-tests.log; exit captured in tool result |
| forge test — Testnet/0xFi/contracts | exit 0; 142 tests, 15 suites | fi-contracts-tests.log; exit captured in tool result |
| npm run check — marketplace | exit 0; four tests plus Graph codegen/build | marketplace-after.log; explicit EXIT_CODE=0 marker |
| forge fmt --check — changed/new MathX files, both roots | exit 0 | tool results on 2026-09-07 |
| forge fmt --check — changed lending source/test | exit 0 after two test-line wraps normalized | tool result on 2026-09-07 |

Foundry fork tests return early without LITVM_FORK_RPC_URL, despite reporting zero skipped. These counts do not establish live fork execution. Contract edits preceded full test runs; subsequent Solidity changes were formatting only. Parent owns root npm run verify; it is not claimed here.

## Observations and limits

Immutable reference 0xPixel.deployed.sol accepts unchecked RGB byte content, incompletely escapes JSON control characters and contains narrow uint8 shifts in base64 generation. These reference files are excluded from compilation and remain unchanged; observations do not establish current deployed bytecode behavior. Parent owns related Pixel frontend handling.

CommunityLiquidityLocker.lockUntil takes uint64 unlockAt and checks only that it exceeds block.timestamp (lines 79–83), then stores it directly (119–146, assignment 137). uint64.max exceeds JavaScript Date range. Exact evidence was sent to parent for a frontend guard; no contract cap introduced.

No live deployment/broadcast/state verification, Slither run, independent third-party audit, complete vendor audit, or proof of absence of defects is claimed. Deployment JSON records were read as historical records rather than asserted current chain state.
