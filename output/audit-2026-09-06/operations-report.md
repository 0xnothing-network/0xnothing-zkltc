# API, server, and operations audit — 2026-09-06

The assigned API/server/operations scope is fully read: **107 files, 18,039 lines**, including the new route regression file and its existing evaluation helper. `operations-reviewed.json` records every path, current SHA-256, full line range, and `full_semantic_read` status. No entry remains inventory-only. A final SHA-256 comparison found no drift between the ledger and files on disk.

## Scope and preservation

Reviewed all assigned web API routes, 0xFi API routes, server helpers, Pump/Fi server modules, marketplace/on-chain metadata helpers, bounded cache, server/media tests, root operational scripts, 0xFi operational scripts, and assigned web/container/deployment configuration. The ledger is the exact file inventory; this report does not claim to cover frontend, wallet, contracts, vendored dependencies, or other agents' scopes.

The existing dirty files `scripts/lib/generated-cleanup.mjs` and `scripts/test/tooling.test.mjs` were read and tested but not edited. Their review hashes still match disk. No CSS, TSX, design assets, on-chain contracts, deployment manifests, environment files, or external state were changed by this scope.

## Confirmed defects fixed

1. **Candle period validation accepted inherited Object properties.** In `0xNothing-zkLTC-Testnet/apps/web/app/0xFi/api/data/candles/route.ts:277`, the `in` operator admitted names such as `constructor`, `__proto__`, `toString`, and `valueOf` despite their absence from the supported period table. The route now uses `Object.hasOwn`, returns HTTP 400 with `no-store` before querying data sources for unsupported periods, and preserves `5m`, `1h`, `4h`, and `1d`.

2. **Incomplete indexed Pixel metadata shadowed successful RPC fallback.** In `0xNothing-zkLTC-Testnet/apps/web/app/api/marketplace/listings/route.ts:294`, an indexed object with an empty image caused an on-chain fetch, but nullish coalescing then selected the incomplete indexed object anyway. The route now keeps indexed metadata when its image exists, otherwise selects successfully fetched on-chain metadata, and retains the indexed object if the fallback is unavailable. This restores the image/name already verified through the on-chain path without changing listing validation or marketplace behavior.

Regression tests in `0xNothing-zkLTC-Testnet/apps/web/tests/server/routeBoundaries.test.ts` execute the actual transpiled route modules with deterministic upstream mocks. Before the patches, the three tests produced **1 pass and 2 failures, exit 1**: inherited `constructor` was accepted, and the returned marketplace image remained empty. After the patches, the focused regression produced **3/3 passes, exit 0**. The wider server/media suite below also includes all three tests.

## Validation with captured completion status

| Working directory | Command | Result | Log |
| --- | --- | --- | --- |
| `0xNothing-zkLTC-Testnet/apps/web` | `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --experimental-strip-types tests/server/*.test.ts tests/media/*.test.ts` | **47/47 passed, exit 0** | `operations-server-tests.log` |
| `0xNothing-zkLTC-Testnet/0xFi` | `node --test scripts/test/operations.test.mjs` | **28/28 passed, exit 0** | `operations-fi-tests.log` |
| Workspace root | `node --test scripts/test/tooling.test.mjs` | **11/11 passed, exit 0** | `operations-tooling-tests.log` |
| `0xNothing-zkLTC-Testnet/0xFi` | `node scripts/check-scripts.mjs` | **31 scripts syntax checked, exit 0** | `operations-fi-check-scripts.log` |

All logs are beside this report. Root `npm run verify`, broader integration checks, and final graph rebuild belong to the parent audit and are not claimed here. No live RPC audit, broadcast, deployment, or browser smoke test was performed by this scope.

## Review observations and practical limits

- Deployment/migration finalizers verify successful receipts, sender/target/CREATE bindings, current creation artifacts, topology, ownership, paused staging, and accounting before publishing local configuration. These were reviewed statically; live chain state was not revalidated.
- Metadata hostname checks reject local names and IP literals, but hostname policy alone does not bind DNS resolution to an approved public destination. Complete protection against DNS rebinding requires an appropriate egress policy or a runtime-compatible fetch transport that verifies the actual destination. No speculative DNS preflight patch was added.
- In-memory upload replay reservations and rate limits protect a running process. Cross-instance guarantees require a shared atomic store if deployment topology needs them; the local upload race and retry tests pass.
- The root HTTP JSON helper retains explicit body limits and parsing checks. Stream cancellation on early Content-Length rejection and malformed UTF-8 remains a possible resource-cleanup follow-up; no additional behavior change was made without a dedicated regression proving the required semantics.

## Graph and source coverage evidence

Graft was consulted before source discovery and before the route changes. Relevant structural queries included the candle GET route, `fetchPixelTokensForListings` callers, `readLimitedJsonResponse` callers, and the module-evaluation helper skeleton. **Six successful Graft calls reported 15,166 tokens saved**; one unsuccessful symbol lookup did not contribute savings.

Codebase Memory coverage was checked for the assigned bounded scopes and exact changed/dependent paths. The final result is saved as `operations-coverage.json` (index generation `2026-09-06T09:00:08Z`): the changed routes, regression test, and evaluation helper have no recorded coverage issue but are flagged `metadata_changed`, and the 0xFi scripts scope has no recorded issues. Earlier coverage reported a partial parse in `marketplaceSubgraph.ts`; the complete source was read directly. These graph signals are best-effort and are not used as proof of completeness. The full source reads, exact ledger, and captured test exits provide the review evidence.
