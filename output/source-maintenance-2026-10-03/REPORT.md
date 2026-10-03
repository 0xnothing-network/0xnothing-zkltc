# Source maintenance — 2026-10-03

## Scope

Inventory covers the maintained workspace packages: shared Testnet/Mainnet web,
wallet, Testnet/Mainnet contracts and Pump subgraphs, Pixel marketplace subgraph,
0xFi contracts/scripts/subgraph, standalone 0xPixel-Dogeos, and root tooling.
Existing uncommitted web changes are preserved. No deployment, real transaction,
dependency upgrade, commit, or deletion of historical audit evidence is performed.
Tracked inventory: 2,028 files, 10 workspace package manifests and 700 owned
source/config/test files, excluding vendored contracts, generated bundles and
historical output. Existing and newly added untracked web/wallet tests are also
included by the package test globs.

## Verified fixes

- A DogeOS catalogue paused on Graph discovery could resume after a canonical
  reorg and combine old counts/IDs with artwork from the new fork. Catalogue and
  collection responses now reject changed snapshot generations.
- DogeOS Graph response bodies had no byte limit. Discovery now uses a 1 MiB
  streaming limit, bootstrap pages use 16 MiB, and invalid responses retain the
  canonical RPC fallback. Oversized streams are cancelled.
- Shared HTTP JSON and wallet market readers did not consistently cancel
  rejected bodies or release their readers. Header rejection, invalid UTF-8,
  overflow, success, and failed reads are covered by regression tests.
- Root `verify` omitted the standalone DogeOS package. `verify:dogeos` now adds
  its API/artwork/wallet/indexer/hosting tests, contracts, frontend and subgraph.
- DogeOS hosting smoke tests selected the first external NIC, making them
  sensitive to unusable VPN/virtual adapters and parallel startup load. They now
  check the assigned port over loopback and separately verify wildcard binding.
- Generated cleanup now includes six previously omitted DogeOS build directories,
  while preserving ABI/deployment inputs, index checkpoints and Git-tracked files.

## Validation

The new reorg, oversized-body, shared-reader and wallet-reader regressions were
observed failing before their respective fixes, then passing afterward.
All 98 maintained JavaScript files passed `node --check`; web, wallet and DogeOS
also passed TypeScript with `--noUnusedLocals --noUnusedParameters`.
Final `npm run verify` completed with exit code 0 on the fixed source:

| Gate | Result |
| --- | --- |
| Root tooling | 13/13 |
| Web tests | 180/180 |
| Testnet / Mainnet contracts | 96/96 + 72/72 |
| Pixel marketplace subgraph | 8/8 and codegen/build |
| Pump Testnet/Mainnet subgraphs | 9-file parity, both codegen/build and AssemblyScript test compilation |
| 0xFi scripts | 33 syntax checks, 28/28 tests |
| 0xFi contracts | 160/160 and deployed-size checks |
| 0xFi subgraph | 22/22 and codegen/build |
| Web production | TypeScript, ESLint and 34/34 generated pages |
| Wallet | 154/154, TypeScript and extension/app/injection builds |
| DogeOS | 67/67, 53/53 contract tests, TypeScript/Vite and subgraph build |

Total: **853 passing test cases**, excluding individual fuzz/invariant iterations
and Pump test-compilation-only targets. Complete output is in `verify.log`.

## Cleanup

After verification and confirming that no local preview server was running,
the fixed allowlist removed **21 generated build/cache directories**. Two
untracked TypeScript cache files were also removed after checking absolute
workspace containment, link-free ancestry and Git tracking. `cleanup.log`
records all targets. No tracked file was deleted, and `git diff --check` passed.
The context graph was rebuilt after cleanup.

Build outputs are intentionally absent after cleanup. Before a production
preview, run `npm run build:web`, `npm run build:wallet`, or the owning DogeOS
build command as appropriate. Development/build commands regenerate the caches.

## Limits

Automated gates and targeted source review are not a proof that every line is
optimal or every bug is eliminated. Upstream vendored libraries, generated
bindings, historical reports and media are not arbitrarily deleted or refactored.
Conditional fork tests do not prove that live-network scenarios executed; no
live signer, production deployment, full browser flow or Android APK build is used.
Mainnet configuration and readiness are unchanged.
