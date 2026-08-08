# 0xFi

0xFi is the LitVM DeFi suite for 0xNothing. It reuses the live NUSD stablecoin
and connects the existing 0xPump graduation flow to a canonical NUSD-paired AMM.

## Product surface

- Swap and shared constant-product liquidity pools
- One canonical LP token per unordered pair
- One farming gauge per LP token, with time-weighted rewards per share
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

```powershell
npm.cmd install
npm.cmd run check:scripts
npm.cmd run check:contracts
npm.cmd run check:subgraph
npm.cmd run check:web
npm.cmd run deploy:dry
npm.cmd run activate:check
npm.cmd run audit:live
npm.cmd run liquidity:bootstrap:check
npm.cmd run pump:controller:check
npm.cmd run pump:keeper:check
```

The 0xFi frontend is part of the unified app at `../apps/web` and is served at
`/0xFi`. `check:web` validates that app directly; there is no standalone 0xFi
Next.js service.

Only run `npm.cmd run deploy:testnet` after every local gate passes and the
printed chain, deployer, existing NUSD, DIA oracle, and Pump addresses are exact.
If a broadcast is interrupted, use `deploy:resume`; if transactions landed but
local finalization failed, use `deploy:finalize`. Testnet core contracts keep the
recorded deployer as direct owner and guardian. The Pump router still enforces
its own 48-hour adapter/enable delay. Once `activate:check` reports ready, run
`activate:testnet` to activate the route and hand Pump/router administration to
the pinned graduation controller. The controller governance remains the direct
testnet deployer. Production must replace this EOA model with reviewed multisig
and delayed governance.

The keeper requires `KEEPER_PRIVATE_KEY`; it never falls back to the deployer
key. Anyone can call the same controller function if that gas-only process is
offline.

The active testnet lending pool is
`0x7CB638F8e10f1bd200A3c5C3fD014C3FD97BA914`. It uses the fixed
4.5% borrower / 4% lender / 0.5% protocol spread and isolated 80/85/90 risk
parameters for WzkLTC, nBTC, and nETH. The replacement synth vaults, fee gauges,
and lending risk actions were activated in the fail-closed order documented in
`docs/DEPLOYMENT.md`; `npm.cmd run audit:live` verifies that topology directly
from chain state. The migration and activation commands remain idempotent
recovery tools, not routine deploy steps. A stale DIA feed still blocks every
debt-increasing action.

The three canonical pools contain deliberately small testnet bootstrap
liquidity. Run `npm.cmd run liquidity:bootstrap:check` to verify it without
sending transactions. `npm.cmd run liquidity:bootstrap` is receipt-aware and
idempotent, but it spends deployer assets and must only be used for an explicit
testnet liquidity operation.

See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/DEPLOYMENT.md` before
changing risk parameters or enabling 0xPump graduation.
