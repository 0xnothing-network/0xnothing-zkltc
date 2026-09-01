# 0xFi contract tests

- `unit/`: one production component or validation boundary.
- `integration/`: interactions between AMM, farming, and graduation components.
- `risk/`: lending, synth, reserve, and oracle safety behavior.
- `invariant/`: stateful AMM and protocol solvency properties.
- `fork/`: read-only checks against explicitly configured live fork state.
- `helpers/`: shared test harness contracts.
- `mocks/`: reusable test doubles grouped by the production boundary they model.

Foundry discovers all `*.t.sol` files recursively. Keep one-off handlers inside
their owning test and extract a mock only when it is substantial or shared.
Production contracts and deployment scripts must not import this directory.
