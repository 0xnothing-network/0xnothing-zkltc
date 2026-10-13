# Testnet liquidity seeding

Seed the current LiteForge 0xFi pairs: wzkLTC/NUSD, nBTC/NUSD, and nETH/NUSD.

The script reads `0xFi/config/liteforge-testnet.json` (`existingContracts.nusd` plus `deployment.contracts`). It does **not** use `contracts/deployments/latest.json`, which still points at the previous NUSD and pair set.

## Dry run (default)

From `0xNothing-zkLTC-Testnet/0xFi`, or from the workspace root via the same npm scripts:

```bash
npm run liquidity:seed:check
```

The plan reports which pairs are already liquid, which synth vaults are inactive on-chain, and whether a broadcast would do any work. Live vault `activated()` / `mintPaused()` win over leftover config labels.

## Broadcast

Do not pass `--broadcast` until the operator is ready to spend NUSD and native zkLTC.

```bash
npm run liquidity:seed
```

Amounts (wei):

| Variable | Default | Pair |
| --- | --- | --- |
| `SEED_CORE_NUSD` | `2e18` | wzkLTC/NUSD via `addLiquidityNative` |
| `SEED_SYNTH_COLLATERAL_NUSD` | `1.5e18` | nBTC and nETH mint-then-seed |

Oracle prices must be fresh. The script is receipt-aware: every write is simulated, sent, and checked for `status == success`. Inactive or paused synth vaults are skipped instead of assumed mintable.
