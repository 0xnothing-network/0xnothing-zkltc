# Full interface upgrade — 2026-09-10

## Implemented scope
- Shared smooth interaction layer in app/interface-polish.css: explicit transition properties, 160ms easing, form focus boundaries, table headers/hover, empty states, token picker and reduced-motion handling. Pixel font, square geometry, circular token logos and semantic warning/danger colors remain.
- Pump: Create token desktop form with live preview for name, ticker, description, links, logo and creation fee; single-column mobile layout; file picker focus indication. Discovery/statistics/portfolio/trading/NUSD surfaces have consistent spacing and hierarchy. Mobile Trending retains three compact columns.
- Fi: workspace, metric strip, panel heading, table, market row, details, transaction status and Earn position treatments across Swap, Pools, Create Pool, pool details, Earn, Lend, Borrow and Synth. No protocol or wallet changes.
- Pixel: studio introduction, workspace, tools, mint panel, generator, collection headers, NFT cards and marketplace activity. Artwork and canvas geometry remain independent of UI changes.
- Docs/Privacy/Dev: reading rhythm, code surfaces, anchor spacing, section hierarchy and form feedback. Homepage transitions made smooth while retaining pixel geometry.

## Validation
- npm run build: exit 0, includes TypeScript/lint and 32 generated pages. Log: ui-all-pages-build.log.
- npm run test: exit 0; 115 tests, 115 pass, 0 fail. Log: ui-all-pages-tests.log.
- git diff --check: exit 0.
- graft build: exit 0, graph refreshed.
- Production standalone server started at http://127.0.0.1:3301.
- 19 desktop route checks (1280px) found no document horizontal overflow or application error: Fi Swap/Pools/Create Pool/Earn/Lend/Borrow/Synth/nbtc-nusd detail; Pump Discover/Create/NUSD/Portfolio/Stats; Pixel Studio/Gallery/Marketplace; Docs/Privacy/Dev. This is route smoke coverage, not all authenticated states.
- 390px mobile checks covered those product groups and loaded SUPERPROMO Pump token detail. No document horizontal overflow observed. Screenshots inspected for Create, Portfolio, Pools, Lend, pool detail, token detail, Studio, Dev and Swap picker. Tablet 768px checked Create/Lend/Studio with no document overflow.
- Verified live token preview updates for name, ticker and description. No upload or creation transaction performed.
- Verified Swap receive selector opens on mobile and nBTC can be selected by pointer. Existing signing/quote guards retained.
- Verified mobile Pump menu expands with all five routes and Trending remains three columns after live data resolves.

## Limits
No performance benchmark/FPS claim. Smoother feedback comes from easing and scoped property transitions. RPC/indexer latency is unchanged. No wallet signing, account-owned NFT/portfolio interaction or transaction submission performed. No remote deployment. Initial dev-route compile delays were resolved for QA by using the built standalone server.
