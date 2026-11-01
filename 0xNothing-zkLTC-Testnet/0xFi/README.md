# 0xFi

0xFi is the LitVM DeFi suite for 0xNothing. It reuses the live NUSD stablecoin
and connects the existing 0xPump graduation flow to a canonical NUSD-paired AMM.

## Product surface

- Swap and shared constant-product liquidity pools
- One canonical LP token per unordered pair
- NUSD fixed-lock staking for on-chain xPoints, plus LP gauges for the remaining pairs
- NUSD lending and borrowing with pooled supplier liquidity
- DIA-priced nBTC and nETH debt with isolated user and safety-reserve collateral
- Goldsky history and candles with direct-RPC quotes, balances, positions, and a
  5,000-block RPC event tail for data that has not reached the indexer yet
- Permissionless 0xPump graduation through a pinned onchain controller, with
  protected atomic pool bootstrap and a replaceable gas-only keeper

## Safety boundary

This checkout is testnet software. Local unit, fuzz, invariant, fork, frontend,
and subgraph checks are required before broadcast. A successful deployment is
not a security audit and must not be described as production-ready.

The phrase "1:1 with NUSD" means the user locks one NUSD for one NUSD of synth
debt at the current DIA price. It is available only after the protocol-owned
Safety Reserve has held at least 100,000 NUSD for 24 hours and NUSD itself is
fully reserve-backed. The Safety Reserve then contributes another 50%, so total
position backing remains 150%. Below the safety threshold, the user supplies the
full 150%. User-owned and reserve-owned NUSD are accounted separately; users can
never withdraw reserve collateral.

Synth minting charges an additional 0.1% of the oracle-priced NUSD notional.
The fee is not collateral and does not reduce the 1:1 mint amount. It is routed
to the matching synth/NUSD gauge for LP stakers; fees queue when nobody is
staked, so an empty gauge cannot burn the reward clock.

Official 0xFi swaps charge 0.5% per pool for that pool's LPs and 0.1% protocol
fee once per route. A route that needs an intermediary also pays one additional
0.1% route surcharge. A direct swap is therefore nominally 0.6%; a two-pool
route through NUSD is nominally 1.2%.

## Commands

Since 2026-10-15 the live suite is v3 (`contracts/deployments/v3-fi.json`, rules and
runbook in `../docs/TOKENOMICS.md`). It is already broadcast: check it with
`npm.cmd run deploy:v3:status` and never rerun `deploy:v3`. The v1 deploy,
activation, migration, liquidity, points and keeper scripts and `audit:live` were
removed on 2026-11-02 (git history keeps them); the v1 record stays in
`contracts/deployments/latest.json`.

```powershell
npm.cmd install
npm.cmd run check:scripts
npm.cmd run check:contracts
npm.cmd run check:subgraph
npm.cmd run check:web
npm.cmd run deploy:v3:status
```

The 0xFi frontend is part of the unified app at `../apps/web` and is served at
`/0xFi`. `check:web` validates that app directly; there is no standalone 0xFi
Next.js service.

The public earn route is `/0xFi/earn`, and `/0xFi/farm` permanently redirects
there. The legacy zkLTC/NUSD gauge route and controls are no longer exposed;
nBTC/NUSD and nETH/NUSD remain available as separate LP programs. See
`docs/NUSD_POINTS.md` for xPoints units, security boundaries, key separation
and tests.

The live v3 lending pool is `0x6Cc96c044321b3205Ac108107Fc6d2d47e0B3E44`. The
retired v1 pool `0x7CB638F8e10f1bd200A3c5C3fD014C3FD97BA914` uses the fixed
4.5% borrower / 4% lender / 0.5% protocol spread and isolated 80/85/90 risk
parameters for WzkLTC, nBTC, and nETH. A stale DIA feed still blocks every
debt-increasing action.

See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/DEPLOYMENT.md` before
changing risk parameters or enabling 0xPump graduation.
