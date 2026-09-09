# UI upgrade research and implementation

Date: 2026-09-08

## MCP research
- shadcn MCP: registry discovery and component installation. https://ui.shadcn.com/docs/mcp
- Figma MCP: source design context and linked components. https://developers.figma.com/docs/figma-mcp-server/
- 21st MCP (formerly Magic): React/Tailwind component discovery and generation. https://github.com/21st-dev/magic-mcp

These MCP servers were researched through official documentation, not installed or called in this task. Implementation uses the existing Next.js 15, Tailwind 4, and Phosphor stack.

## Design
Existing Nothing branding, route labels, content, legal text and transaction behavior retained. Charcoal surfaces, consistent neutral borders, readable text and mono figures, restrained semantic mint/amber/red colors. Root legacy global overrides consolidated. Product styles remain scoped.

Coverage: home; Fi swap/pools/create/detail/earn/lend/borrow/synth (farm keeps existing redirect); Pump discovery/create/NUSD/portfolio/stats/token; Pixel studio/gallery/marketplace; docs/privacy/dev.

Homepage asset: public/images/nothing-hero-v2.png, 1536x1024, generated with built-in ImageGen. Prompt: monochrome brushed-silver hollow ring resolving into pixel cubes, obsidian studio background, right-aligned subject with negative space, no text/logos/neon. Artwork is atmosphere, not a product or deployment claim.

## Validation
- Web typecheck: exit 0.
- Web lint: exit 0.
- Web tests: 115 passed, 0 failed.
- Web production build: exit 0.
- git diff --check: clean.
- Browser inspected home desktop/mobile, Fi swap desktop/mobile and settings expansion, Pump mobile loaded real markets and navigation, Pixel studio mobile, docs mobile.
- Full workspace verify log: output/ui-upgrade-verify.log (final status reported separately).

Limitations: no signed wallet transactions were performed. RPC timeouts observed on Fi testnet data. Dynamic detail routes and all connected-wallet states are not exhaustively browser-tested. No deployment performed.

Final validation: full `npm run verify` finished with exit code 0. Separate `npm run verify:wallet` also finished with exit code 0. Wallet dark design tokens were synchronized with Fi to satisfy the repository's existing token-parity test; wallet transaction logic was not changed.
Additional browser checks: Pixel desktop and disconnected gallery; privacy and dev desktop; Fi Pools/Earn/Lend/Borrow/Synth/create-pool; Pump create/NUSD/portfolio/stats. Observed checked desktop pages had no horizontal overflow. Dynamic token/pair detail layouts are styled through shared product CSS but not exhaustively browser-tested.
Pixel legacy stylesheet rules are now scoped under .pixel-product so route-loaded styles cannot affect another product's matching shared classes.

## Pixel style correction
User clarified that pixel style must remain. Restored Departure Mono throughout, square edges, hard offset shadows and stepped control feedback across Pump, Fi, Pixel, docs/privacy/dev. Removed metallic hero from homepage rendering. Kept responsive layouts and readable data sizes. Pixel correction production build passed (exit 0), including lint/type validation; git diff --check clean. Browser inspected homepage and supplied Pump token detail route. Prior full verify pass predates this CSS-only correction.

## Shared pixel consistency pass
Added app/pixel-system.css for shared palette, typography, square controls, borders, hard shadows, focus and responsive inputs. Aligned home/docs/privacy/dev CSS; restored Docs mobile hero single column. Removed obsolete Pump global header/main/section overrides that leaked into other routes. Increased Pump small labels to 11px. Unified Pixel control height and primary mint palette, hard canvas shadow, and remaining rounded studio utility classes.
Final npm run build:web passed exit 0, including lint and TypeScript. git diff --check passed. Refreshed graft build successfully. Browser checked Pump/Docs desktop, Fi swap desktop, Docs/Pump/Pixel at 390px with no document horizontal overflow; verified Docs header blur none and Pixel rounded utility controls count zero. Temporary viewport reset. No signed transactions or deployment performed. Full verify from the earlier implementation passed but predates this CSS-only consistency pass.

## Swap token search, 2026-09-09
Pay and receive pickers now expose a searchable input for token name/symbol or pasted CA. Contract previews use the existing useImportedSwapAsset hook, including address validation, Explorer-backed verification, cancellation, timeout and session scan budget. Preview does not change the selection; choosing a ready result invokes the corresponding existing pay/receive import flow. Name selection preserves existing duplicate-side resolution. Added keyboard arrows/Enter/Escape, an explicit close button, loading/error/empty status, full address preview, and a mobile popup with 16px search text.
TypeScript and ESLint passed. Existing importedSwapAsset tests: 3 passed, 0 failed. Browser tested name filtering on pay and receive, Enter selection with duplicate-side resolution, mobile name results, no-match query, invalid address and Escape. Live full-CA lookup returned verification temporarily unavailable; confirmed it leaves the previous selected token intact. Successful live CA selection was not confirmed during this run. No signed transactions performed.
