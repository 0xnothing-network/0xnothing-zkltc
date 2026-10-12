<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

## Cloud Agent

- Next.js workspace: `npm run dev` at http://127.0.0.1:3300. `GET /api/health` returns `{"status":"ok"}`.
- DOGEOSxPIXEL: `PORT=3301 HOST=127.0.0.1 npm --prefix 0xPixel-Dogeos run dev`. The workspace proxies http://127.0.0.1:3300/DOGEOSxPIXEL to that process.
- Use Node.js 22.23. DogeOS tests import a TypeScript helper, which Node 22.14 rejects (`ERR_UNKNOWN_FILE_EXTENSION`).
- Contract tests need Foundry 1.8.5 (`forge`, `cast`, `anvil`). Testnet and DogeOS compile with Solidity 0.8.34; 0xFi uses 0.8.24.
- Full local verification is `npm run verify` (see TESTING.md).
- Public chain configuration is committed. Server-only values in `0xNothing-zkLTC-Testnet/apps/web/.env.example` are for uploads, points vouchers, and deploys.
- These subgraph lockfiles fail `npm ci` on npm 10.9 because locked `@types/node@12` does not satisfy a `>=18` peer: `0xNothing-zkLTC-Testnet/subgraphs/0xpump`, `0xNothing-zkLTC-Testnet/subgraphs/0xpixel-marketplace`, and `0xNothing-zkLTC-Mainnet/subgraphs/0xpump`. Install them with `npm install --include=dev --no-audit --no-fund --package-lock=false` so the committed lockfile stays unchanged.
