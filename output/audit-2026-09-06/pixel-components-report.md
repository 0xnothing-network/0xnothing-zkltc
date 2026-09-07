# Pixel component audit — bounded wallet-agent follow-up

Completed 2026-09-07. Ownership was limited to `AIPromptGenerator.tsx`, `Canvas.tsx`, `PixelHeader.tsx`, `Skeleton.tsx`, and `Toolbar.tsx` under `0xNothing-zkLTC-Testnet/apps/web/features/pixel/components/`, plus a separate new regression test. Parent-owned Pixel components and tests were not edited by this subtask.

## Source coverage

All five assigned source files were read in full. The final hash ledger is `pixel-components-reviewed.json`: **5/5 files, 1,883 lines, 71,187 bytes**. Counts include complete text, comments and JSX. The separate new `tests/client/pixelCanvasInteractions.test.ts` contains 109 lines / 6,293 bytes and is described below; it is not added to the five-file source coverage denominator.

| Source file | Lines | Result |
| --- | ---: | --- |
| `AIPromptGenerator.tsx` | 108 | Full read; no confirmed defect repaired |
| `Canvas.tsx` | 1,019 | Full read; two reproduced interaction defects repaired |
| `PixelHeader.tsx` | 497 | Full read; no confirmed defect repaired |
| `Skeleton.tsx` | 32 | Full read; no confirmed defect repaired |
| `Toolbar.tsx` | 227 | Full read; no confirmed defect repaired |

Graft context, exact caller queries and Codebase Memory coverage were checked before editing. Codebase coverage had no recorded parser issue for these five paths, but reported changed metadata; complete direct reads and the final file hashes establish the coverage. The graph did not expose every observed JSX caller, so absence of graph edges was not treated as proof that a component was unused. Support reads included the existing test evaluation helper and Toast API; those are outside this bounded component count.

## Repairs

1. **Symmetry preview now matches the pixels a stroke will paint.** `Canvas.tsx:259` previously mirrored the brush center, then painted the original brush footprint around that center. For even brush sizes (2 and 4), the footprint is asymmetric around its anchor, so its reflected preview was shifted relative to the actual painted result. Preview now reflects each brush pixel, using the same coordinates as the existing paint path. Grid clipping remains in the existing preview pixel helper; the actual stroke/data update path is unchanged.

2. **Clipboard export waits for success and handles failure.** `Canvas.tsx:885` previously ignored the clipboard promise and closed the export menu immediately. Permission rejection produced an unhandled rejection and users could not tell that nothing had been copied. The callback now awaits the write, closes on success, and uses the existing Toast API on failure. A missing clipboard API is also caught, leaving the menu available for another export option.

Only `Canvas.tsx` was changed among the five assigned components. A TypeScript AST comparison against the pre-edit source found **all 50 JSX `className` and `style` attributes identical**. No CSS file was edited, and existing preview fill/stroke expressions remain intact.

## Verification

The new regression file executes the actual TSX module through the repository's evaluation helper and invokes its rendered handlers with controlled React/Canvas/browser dependencies. The preview test compares recorded preview cells with the actual pixel updater for 32 combinations: brush sizes 1–4, all four symmetry modes, an interior point and the upper-left edge. The clipboard test covers a denied write, a missing API and a successful write; a deferred promise verifies that the menu stays open while a write is pending.

| Check | Captured result | Evidence |
| --- | --- | --- |
| Regression run against original Canvas behavior | **exit 1**, both tests failed | Chunk `5b4df0`; 2px horizontal preview mismatch and clipboard premature close/unhandled rejection |
| Final `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test tests/client/pixelCanvasInteractions.test.ts` | **exit 0**, 2 passed / 0 failed | Chunk `68ad15`, 8,930 ms; includes deferred clipboard assertion |
| Final `node node_modules/eslint/bin/eslint.js features/pixel/components/Canvas.tsx tests/client/pixelCanvasInteractions.test.ts` | **exit 0**, no warnings | Session 6367, final chunk `18a4fa`; run after the deferred clipboard assertion was added |
| JSX style/className AST comparison | **exit 0**, 50 attributes identical | Chunk `23943e` |
| `git diff --check` for Canvas and new regression path | **exit 0** | Chunk `053fc7` |

The focused regression run emitted no warning or unhandled rejection after the repair. Parent is responsible for full web test/typecheck/lint and root verification, so those are not claimed as results of this subtask. No live browser/device interaction or pixel screenshot comparison was performed; the style evidence is source/AST comparison and the behavior evidence is the focused handler regression.

Graft's observed token-saving estimates for this bounded follow-up total approximately **38,464 tokens**. This is the tool's estimate, not measured model token usage. The separately completed wallet report retains its own 183,393-token estimate and checks; no wallet check was rerun here.
