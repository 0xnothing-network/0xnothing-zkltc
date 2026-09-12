# Full pixel visual redesign — 2026-09-12

## Direction
NOTHING pixel terminal: charcoal/olive surfaces, pale green accent, Departure Mono, square dither texture, double rules, framed title bars, recessed fields and raised keys. Existing page layout, content and transaction logic remain owned by product components.

## Files changed in this pass
- apps/web/app/pixel-theme.css: shared visual theme across Fi, Pump, Pixel, homepage, Docs and Privacy.
- apps/web/app/globals.css: imports the new theme after existing shared layers.
- apps/web/app/dev/dev.module.css: applies the same terminal frame to the operator console.

Existing unrelated dirty files were preserved. This pass does not change TSX, APIs, contract interactions, wallet storage or signing.

## Validation
- Web test suite: 118 passed, 0 failed (exit 0).
- git diff --check: passed.
- Browser: Swap desktop; Pump desktop and 390px; Pump mobile navigation opens.
- Final production build: exit 0; compilation, lint/type validation and 33 static pages completed.
- Responsive smoke: 20 routes at 390px, no document horizontal overflow; desktop route checks at 1280px and visual review of Swap, Pump, Pixel Studio, Marketplace, homepage and Docs.
- Swap selector: opened, searched nBTC, clicked option and verified selection. No transaction submitted.
- Final build rechecked: Pixel header/preview colors, Marketplace purchase button palette and Docs padding.
- Theme contrast: text/panel 15.02:1, muted/panel 8.22:1.
- Some live RPC reads timed out or returned invalid block ranges during review. This is not a verification of live transaction execution.

## Logs
- output/pixel-theme-build-final.log
- output/pixel-theme-tests.log

