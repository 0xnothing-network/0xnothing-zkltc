# Mainnet and graduation plan

## Current blockers

- Official LitVM documentation still marks the mainnet RPC as TBD.
- The documented DIA adapters are testnet addresses; no mainnet LTC/USD adapter is configured here.
- Goldsky currently documents LitVM testnet indexing under `liteforge`; mainnet onboarding is not confirmed.
- The official zkLTC stablecoin address, decimals, canonical NUSD conversion or bridge route, settlement guarantees, and production liquidity are not published here.
- The major DEX address, ABI, pool factory, fee tier, liquidity-position type, and listing policy are not final.
- The current graduation interface assumes synchronous settlement and an ERC-20 LP token. It cannot safely represent an asynchronous bridge or a concentrated-liquidity NFT position without a reviewed contract revision.

These are release blockers, not values to guess around.

## Phase 1: protocol hardening

- Audit OracleNUSD's direct oracle-priced mint/redeem math, floor rounding, native-reserve accounting, reserve-deficit behavior, and shutdown controls.
- Review the deliberate `type(uint256).max` supply ceiling. There is no practical protocol-wide cap, but every mint requires a native zkLTC deposit whose current oracle value equals the NUSD issued.
- Audit the Pump curve, reserve accounting, rounding, fee isolation, and the exact transition from a `1,500 NUSD` initial virtual market cap to the fixed `6,000 NUSD` READY market-cap target.
- Audit the paid content-reservation flow end to end so one `1 NUSD` reservation authorizes only its owner and exact canonical metadata/logo hash.
- Add reviewed oracle-deviation and value circuit breakers in addition to the independent mint and redeem pause domains.
- Move ownership, pause, fee-recipient, and adapter-governance roles to a Safe multisig with a documented delay.
- Add redundant RPC, paid IPFS pinning, durable upload rate limits, monitoring, and incident procedures.

The mainnet candidate is an oracle-priced native reserve, not an
overcollateralized debt system. It has no user debt positions, minimum collateral
ratio, or liquidation path. A zkLTC price decline can make the reserve worth less
than outstanding NUSD and can block redemptions that require more native zkLTC
than remains in the contract. Reserve coverage and incident response must be
tested before release.

## Phase 2: official stablecoin settlement and DEX adapter

READY remains a Pump lifecycle state denominated in NUSD. It occurs when
`spotPriceNusdWad * fixedTotalSupply / 1e18` reaches `6,000 NUSD`; it is not a
`6,000 NUSD` reserve balance and it does not itself call a bridge or DEX.

Implement the production adapter only after the official zkLTC stablecoin,
canonical NUSD conversion or bridge route, and major DEX interfaces are final.
The adapter must:

1. Be allowlisted through the router delay.
2. Accept the exact READY-market token and NUSD reserves.
3. Convert or bridge NUSD into the official zkLTC stablecoin through the approved route, enforcing a caller-supplied minimum stablecoin output, deadline, decimal normalization, and verified balance delta.
4. Create or seed the intended token/official-stablecoin pool on the approved major DEX in the same atomic execution.
5. Enforce NUSD-to-official-stablecoin value bounds and terminal-curve-to-pool price continuity within reviewed tolerances.
6. Consume the expected token and NUSD inputs, leave no unaccounted balance in the router or adapter, and return the verified DEX, pair/pool, liquidity asset, and amount.
7. Permanently lock or burn the resulting liquidity position according to an immutable policy.
8. Revert the entire transaction without losing funds if conversion, bridge settlement, pool creation, minimum output, price continuity, or locking fails.

### Interface constraints before implementation

The current router calls `graduate(...)` synchronously and verifies all input and
LP-token balance changes before the transaction returns. Therefore the approved
conversion or bridge must settle on the same chain and in the same transaction.
If the canonical route is asynchronous, graduation needs a new escrowed state
machine with authenticated messages, replay protection, timeouts, cancellation,
failed-message recovery, accounting reconciliation, and a separate audit; the
current adapter must not be used.

The current adapter also predicts one `lpTokenFor(token, nusd)` address and the
locker verifies an ERC-20 balance increase. If the selected major DEX returns a
concentrated-liquidity NFT or another non-fungible position, the router, adapter,
locker, events, subgraph, and recovery procedures must be redesigned and audited
before release.

`GraduationParams` does not yet carry a minimum official-stablecoin output. Add
that bound, plus the final stablecoin/route identity checks, only after the
official interfaces are known. No placeholder or guessed address may satisfy a
release gate.

Graduation is submitted by the protocol Safe after the adapter is active. The Safe can pause curve trading before migration, while the router and adapter disable controls independently stop graduation. A failed attempt leaves the market in `READY`; until a graduation succeeds, a holder sell reopens the curve to `TRADING` instead of trapping reserves.

## Phase 3: indexing and web release

- Deploy a distinct mainnet subgraph only after Goldsky supports the official chain or a custom-chain deployment is approved.
- Start from the exact Pump deployment block and verify every aggregate against RPC event scans.
- Promote a tested frontend release tag with mainnet addresses; do not maintain an independently drifting copy.
- Keep the current 0xPixel deployment on testnet. The mainnet Pump release must not redeploy or impersonate it.

## Release gates

- Independent smart-contract audit and remediation complete
- High-volume fuzz, invariant, and mainnet-fork suites pass
- Oracle outage, price crash, reserve deficit, mint/redeem pause, reserve coverage, and shutdown drills pass
- DEX graduation fork proves price continuity and LP lock
- Official stablecoin contract, decimals, conversion/bridge route, and minimum-output behavior are independently verified
- Graduation succeeds atomically on a fork, or the router is redesigned and audited for the official asynchronous route
- Selected DEX liquidity-position type matches the locker; NFT positions require the reviewed replacement path
- Goldsky catches up without indexing errors and RPC fallback matches it
- Paid, redundant IPFS retention and gateway monitoring enabled
- Multisig, timelock, monitoring, alerts, rollback, and public incident contacts live
- Deployment bytecode and constructor arguments independently reproduced
