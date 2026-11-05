# Security model

## Non-negotiable controls

- Reentrancy guards on token/native transfers and position mutations
- Checks-effects-interactions ordering
- Exact balance-delta checks for assets that must not charge transfer fees
- Deadline and minimum-output arguments on swaps, liquidity, redemption, and
  graduation
- Oracle positivity, freshness, timestamp, decimal, and configured-key checks
- Independent pause controls for swaps, farm deposits, synth mint/withdraw,
  lending supply/borrow, and debt-backed collateral withdrawal; repayment,
  liquidation, LP removal, farm withdrawal/claims, supplier exits, and
  debt-free lending collateral exits remain available as applicable
- Supply, borrow, collateral, synth debt, and farm reward caps
- Separate synth user/reserve ledgers, with vault NUSD reconciled against both
- 100,000 NUSD sponsorship entry, 90,000 NUSD exit hysteresis, and a 24-hour
  activation delay; total synth position backing remains at least 150%
- Two-step administration followed by multisig and delayed governance before
  any production use; the direct deployer model is testnet-only
- No oracle or DEX price fallback during solvency checks
- Permissionless Pump graduation with no caller-controlled adapter, liquidity,
  recipient, price, or slippage parameters
- Exact LP output pinning and atomic protected-pair preparation; any topology,
  reserve, router, or implementation drift fails closed
- Exact router fee ledgers: one router fee per route, 10 bps if either end of
  the path is NUSD or WzkLTC and 30 bps otherwise, with no surcharge, plus 0.5%
  LP fee per pool (at most three pools)
- Atomic 0.1% synth mint fee collection with a caller maximum; in v3 the fee is
  sent to the vault's `mintFeeDistributor`, the core fee splitter, not a gauge

## Known economic risks

- The active v3 lending pool is `0x6Cc96c044321b3205Ac108107Fc6d2d47e0B3E44`
  (`PooledNUSDLendingPoolV2`). It uses fixed rates, a bad-debt-inclusive borrow
  cap, pooled cross-asset collateral and DIA-only pricing for WzkLTC, nBTC, and
  nETH. `0x7CB638F8e10f1bd200A3c5C3fD014C3FD97BA914` is the retired v1 pool.
  (In v1, a receipt-verified migration moved `19.999999999999998 NUSD` into
  that pool from the earlier pool `0x099Fe8b7611A294eD33e6D96a0b958E189143622`,
  which is paused and retains only its mandatory `1,000 wei` locked-share
  reserve.) Supply, borrow, and healthy collateral withdrawal on the v3 pool
  still fail closed
  when governance pauses the relevant action, liquidity is insufficient, or a
  required DIA price is stale.
- The existing OracleNUSD reserve model is not guaranteed overcollateralized.
  0xFi cannot repair a NUSD reserve shortfall inside its own contracts. Reserve
  coverage is monitored and surfaced to users. Lending and the synth 150% fallback
  do not treat it as a global admission gate, so suppliers, borrowers, minters,
  and LPs still bear direct NUSD solvency risk. The lower user-funded synth mode
  does fail closed unless NUSD reserve value covers its full supply.
- Safety Reserve funding is irreversible protocol capital. It issues no shares,
  has no depositor withdrawal claim, cannot be swept by governance, and binds
  exactly the two synth vaults once. Only this dedicated reserve TVL counts toward
  sponsorship; unrelated LP or lending TVL cannot unlock 100% user funding.
- Liquidation consumes user collateral before reserve collateral. This prevents
  a minter from self-liquidating with freshly minted synth to extract the reserve.
  A sufficiently large oracle-price gap can still deplete both tranches and leave
  synth bad debt, so conservative per-asset debt ceilings remain mandatory.
- nBTC and nETH are synthetic claims. They are not redeemable for native BTC or
  ETH and depend on NUSD solvency, DIA liveness, liquidator participation, and
  configured collateral ratios.
- nBTC and nETH are accepted as lending collateral only under the small
  deployment caps recorded in the manifest. This bounds, but does not eliminate,
  recursive NUSD leverage. DIA freshness, LTVs, liquidation thresholds, caps,
  available liquidity, and pauses remain the technical controls.
- The current DIA non-stable feeds have a documented one-hour heartbeat. That is
  suitable for a capped testnet, but it is too slow to be the only production
  liquidation oracle during a fast market. Mainnet needs a faster custom feed or
  a second independently governed safety oracle.
- AMM LPs face impermanent loss and low-liquidity manipulation. Lending never
  treats a raw AMM spot price as an oracle.
- Retired v1 pairs (`contracts/deployments/latest.json`) are permissionless
  immutable 0.3% bytecode, and a caller interacting with one directly bypasses
  router fee accounting. This does not apply to v3: v3 pairs charge a 0.5% LP
  fee and accept `swap` only from `factory.router()`. Production must use the
  router-bound pair implementation.
- A funded farming schedule can end. The UI must not label unfunded emissions as
  guaranteed APY.
- A pause-only guardian reacts immediately; only the owner may unpause or change
  risk configuration. The testnet owner and guardian are the deployer EOA.
  Production requires a multisig, delayed governance, and independent monitoring
  before value is accepted.
- The graduation keeper is not trusted and holds no admin role. Multiple
  keepers can race, so operators should run one primary instance; at most one
  onchain graduation succeeds and all state changes remain atomic.
- The controller intentionally pins the current adapter topology and LP formula.
  A pair or adapter upgrade requires a separately reviewed controller and a
  separately reviewed, delayed admin migration rather than silently accepting
  changed behavior.

## Launch gates

1. Unit, fuzz, invariant, and LitVM fork tests pass.
2. Static analysis reports no unresolved high or critical finding.
3. Frontend simulation matches contract quotes for every route.
4. Goldsky totals reconcile with RPC logs and reserve balances.
5. DIA LTC/USD, BTC/USD, and ETH/USD keys are fresh before any debt-increasing
   action is considered operational.
6. NUSD reserve coverage and Safety Reserve free/allocated balances are measured,
   displayed, and included in operator alerts. Sponsored mint must fail closed
   whenever either backing check is unhealthy.
7. A third-party audit is complete before mainnet value is accepted.
