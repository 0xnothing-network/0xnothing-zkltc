# 0xFi architecture

## Source of truth

Value-changing actions and balances are read from LitVM RPC. Goldsky indexes
immutable event history for discovery, charts, volume, and account activity. API
responses merge an RPC log tail after the indexed block and deduplicate by
transaction hash plus log index. The live tail is deliberately capped at 5,000
blocks; older history stays with Goldsky so RPC requests remain bounded.

## DEX

The DEX has one unordered pool for each token pair. Every liquidity provider
mints the same pool LP token and owns `user LP / total LP` of the reserves. Ten
providers do not create ten pools. They join one pool and fees accrue to their
percentage ownership.

The initial liquidity mint permanently locks a minimum share. Swaps enforce the
constant-product invariant after a fee, while router calls require a deadline
and minimum output. Native zkLTC enters pools through WzkLTC and unwraps on exit.

Each pool keeps a 0.5% LP fee in its reserves, applied independently to every
pool in the path. The v3 router (`ZeroXFiRouterV2`) charges one router fee per
route, with no surcharge: 10 bps if `path[0]` or the last path entry is a base
asset (NUSD or WzkLTC), otherwise 30 bps. The fee is taken in `path[0]` when the
input is a base asset, otherwise in `path[1]`, which must then be a base asset.
Fees accrue in `accruedRouterFees[token]`, fully backed by the router's token
balance. `distributeFees(token)` is permissionless and pays NUSD fees to the fee
splitter and WzkLTC fees to the treasury; in v3 both recipients are the core fee
splitter. A route has at most three pools.

v3 is a fresh `ZeroXFiFactoryV2` deployment. Its pairs charge a 0.5% LP fee and
accept `swap` calls only from `factory.router()`. Every pair must contain NUSD
or WzkLTC. The factory rotates its router only through a 48-hour delay. The
legacy 0.3% pair bytecode and the conservative-quote migration router belonged
to the retired v1 suite (`contracts/deployments/latest.json`) only.

## Farming

Each LP token maps to one gauge. A funded NUSD reward schedule updates a global
reward-per-staked-token accumulator. A user's claim equals their time-weighted
LP balance multiplied by accumulator growth. Gauges cannot mint NUSD and cannot
promise rewards beyond tokens already funded.

Gauge rewards come only from funded schedules (`GaugeFactory.fundGauge`). If all
LP exits, the remaining schedule duration pauses and resumes with the next
stake. In v3 the 0.1% NUSD synth mint fee does not go to a gauge: each vault's
`mintFeeDistributor` is the core fee splitter, and the fee is transferred to it
atomically during the mint.

## Synthetic assets

nBTC and nETH represent oracle-priced debt, not bridged BTC or ETH. Users lock
NUSD, mint synth units using DIA BTC/USD or ETH/USD, and remain above the minimum
collateral ratio. Anyone may liquidate a position below the liquidation ratio.
Per-asset debt ceilings, minimum collateral ratios, DIA freshness checks, and
independent pause switches limit blast radius.

Mint output is calculated from the DIA USD price. The user-provided NUSD remains
collateral at the quoted 1:1 USD value; the separate 0.1% NUSD fee is pulled in
addition, bounded by a caller-supplied maximum, and never enters either the user
or Safety Reserve collateral ledger.

Each position records user-owned NUSD separately from protocol-reserve NUSD. In
the default mode, the user supplies the full 150% minimum. The shared
`SynthSafetyReserve` may sponsor the last 50% only after its protocol-owned TVL
has remained at or above 100,000 NUSD for 24 hours and `reserveValueNusd()` is at
least the NUSD total supply. The user then supplies 100%, while combined backing
still starts at 150%. This threshold is dedicated, liquid reserve capital; AMM,
lending, gauge, and user TVL do not count toward it.

Sponsorship stops for new allocations below 90,000 NUSD or whenever NUSD backing
is unhealthy. Existing allocations remain attached to their positions and keep
counting toward the 150% invariant, avoiding a retroactive user margin call.
Repayment is always available: full repayment releases reserve collateral without
an oracle read, then the user can withdraw only their own NUSD. Liquidation
consumes user collateral first; reserve collateral covers only a remaining
shortfall, preventing self-liquidation from extracting protocol capital.

## Lending

NUSD suppliers share one interest-bearing vault. Borrowers lock approved
collateral and borrow from that common NUSD liquidity. Debt and supply shares use
global indexes so interest accrues without per-account loops. DIA prices are
used only for solvency checks, never DEX spot prices.
New borrowing requires a fresh DIA collateral price and remains bounded by the
asset LTV, liquidation threshold, collateral cap, pool liquidity, and global
borrow cap. Existing borrowers can still repay, be liquidated, and withdraw
collateral after their debt is cleared.

WzkLTC, nBTC, and nETH are accepted as lending collateral on testnet. The synth
assets use much smaller per-asset collateral caps (0.01 nBTC, 0.25 nETH, equal
to their synth debt ceilings) to bound recursive NUSD leverage; risk itself is
still pooled across the account's collateral. Raw DEX
spot prices are never used for solvency. Governance may change collateral only
after separate risk review.

## 0xPump graduation

The live 0xPump router checks that the LP contract exists before it transfers
assets to an adapter. 0xFi therefore prepares a canonical token/NUSD pool first,
but locks its first LP mint to the graduation adapter. Graduation then consumes
the exact Pump token and NUSD amounts, verifies an empty bootstrap state, seeds
the terminal curve ratio, returns ordinary ERC-20 LP tokens, and lets the live
router send them to the existing permanent locker.

Adapter allowlisting and router enablement use the live router's intrinsic
scheduling delay (`GraduationRouter.minimumDelay`). For the v3 core router it is
1 hour (`contracts/script/DeployV3Core.s.sol:58`, `graduationDelaySeconds: 3600`
in `contracts/deployments/v3-core.json`); the 48-hour delay belonged to the
retired v1 setup. Direct testnet governance cannot bypass that delay, and
preparing or deploying a pool does not shorten it.

After activation, `PumpGraduationController` owns the Pump and its graduation
router. Any account may call `graduateReady(token)`, but cannot choose the
adapter, destination, pool, terminal price, liquidity amount, or minimum LP.
The controller prepares the protected pair and graduates it atomically, with
minimum LP fixed to the exact output implied by the live Pump reserves. A
failed check reverts pool creation and all transfers together.

The keeper only discovers READY markets and pays gas. It has no protocol role,
so downtime delays execution without blocking another caller, and a compromised
keeper key cannot alter configuration. Goldsky accelerates pool discovery and
charts; RPC validates new pairs and supplies the bounded not-yet-indexed tail.
Graduated pool pages support swap and shared add/remove liquidity immediately.

Every governed module also has a replaceable guardian. The guardian can only
pause risk paths immediately; it cannot unpause, change parameters, take
ownership, or move protocol assets. On this testnet the deployer is direct owner
and guardian. A production deployment must move recovery and unpause authority
to reviewed multisig and delayed governance.
