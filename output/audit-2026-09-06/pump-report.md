# Pump frontend audit — completed 2026-09-07

The assigned Pump scope is fully read. The final `pump-reviewed.json` contains **38 files / 6,349 lines**: **37 feature files / 5,958 lines**, plus the **391-line regression file**. Every entry has a SHA-256, full `[1, lineCount]` review range, and `full_semantic_read` status. `components/PumpHeader.tsx` was explicitly excluded because the parent owns its changes. Previously completed Pump server reads were reused only after their hashes matched the operations ledger.

## Confirmed defects and changes

### Wallet balance isolation and the correct chain

`features/pump/hooks/usePumpData.ts` kept `placeholderData` from the previous wallet when the connected address changed. While the replacement balance request was pending, the new account therefore displayed the previous account's holdings. A real TanStack Query `QueryObserver` regression reproduced this behavior before the patch.

The balance placeholder now survives only for the same address and LitVM chain. Disconnect clears the returned balance map and disables the visibility-refresh callback. The public client is pinned to chain 4441, and the balance query key includes that chain so data fetched on a previous default chain cannot be reused. Same-wallet token-list refreshes preserve known balances while new balances load; that continuity has its own regression.

### Wallet changes during transaction preparation

The Pump action handlers could continue after an approval receipt, simulation, chain switch, content hashing, or IPFS upload even when the account, connector, connection status, or chain had changed. The old transaction arguments could then be sent using the new active wallet.

`features/pump/walletSession.ts` now captures the initial connector and rechecks the connected account, connector, and LitVM chain immediately before sensitive continuations. The guard is used by:

- `TradePanel.tsx`: approval followed by buy/sell.
- `CreateTokenForm.tsx`: preparation, approval, reservation, upload, and final creation.
- `NusdOraclePanel.tsx`: both mint and redeem simulations followed by writes.
- `TokenDetail.tsx`: graduation simulation followed by its write.
- `PumpStatsDashboard.tsx`: fee-claim simulation followed by its write.

All corresponding writes explicitly bind the original account and chain 4441. Trade and graduation contract reads are also pinned to the intended chain. Contract targets, function names, amounts, slippage calculations, approvals, reservation/recovery behavior, and transaction order remain the same for a wallet that has not changed. Regression cases verify both rejected continuations and successful paths, including buy, sell, mint, redeem, creation, graduation, and fee claiming.

### Untrusted token metadata

`TokenDetail.tsx` previously asserted that external JSON was `TokenMetadata` without runtime validation. A numeric `external_url` reached `.trim()`, and an object-valued `description` could reach React rendering. The new `parseTokenMetadata` accepts only string fields from a non-array object and validates nested properties. Valid descriptions and links are preserved; malformed field types no longer crash the token page.

## Verification and evidence

| Check | Captured result | Evidence |
| --- | --- | --- |
| Initial portfolio/trade regression before changes | **7 failures, exit 1** | `pump-regression-before-clean.log` |
| Initial portfolio/trade regression after changes | **7/7 passed, exit 0** | `pump-regression-after.log` |
| Expanded transaction/metadata regression | Failing pre-change cases reproduced; final cases pass in the complete client suite | `pump-extended-before.log`, `pump-client-tests.log` |
| Full client test directory, including all 22 Pump cases | **43/43 passed, exit 0** | `pump-client-tests.log` |
| Web TypeScript, `node node_modules/typescript/bin/tsc --noEmit --incremental false` | **exit 0** | `pump-typecheck.log` (empty success output) |
| ESLint on all 8 new/changed feature and test files | **exit 0** | `pump-eslint.log` (empty success output) |
| AST comparison of every JSX root in the 5 edited components against HEAD | **all unchanged, exit 0** | `pump-jsx-preservation.json`, `check-pump-jsx.mjs` |

The complete JSX subtree comparison covers markup, class names, inline styles, and visible JSX text. No stylesheet or design asset was edited. The transaction and metadata edits are confined to data preparation and action logic. The parent-owned Header and pre-existing dirty files remain outside this patch scope.

The earlier expanded harness needed missing `refetch` mocks for successful graduation/fee-claim callbacks; those harness omissions were corrected before the final suite. The real TanStack observer harness also overrides garbage-collection time to avoid keeping its test process open. Those harness issues are not product findings.

## Coverage and limits

Graft was queried before discovery, with caller checks before changes and literal lookups where JSX references were absent from caller edges. The Pump phase made **19 successful Graft calls**, whose reported estimates sum to **103,014 tokens saved**. This is the sum of tool estimates over the calls, including repeated references to the same files.

`pump-coverage.json` records the final Codebase Memory scope/path check at index generation `2026-09-07T03:11:50Z`. It reports no recorded coverage issues for the Pump scope and changed paths but flags each changed path `metadata_changed`. Full source reads and the ledger provide the review evidence; graph coverage is best-effort and does not prove completeness. The parent is responsible for the final repository graph refresh.

No live wallet submission, network broadcast, deployment, or browser smoke test was performed by this scope. Root `npm run verify` remains the parent's final integration check. The code changes and focused checks are complete, with no blocker requiring user input.
