# NUSD staking: v3 Earn (RewardStaking) and the legacy xPoints module

> **Superseded.** This file used to describe the v1 `NusdPointsStaking`
> module ("xPoints"). That module is legacy: it is the `nusdPointsStaking`
> entry `0xDf009d9c2Bc0C2f8ee55A047074edB166C1D3282` in
> `0xFi/contracts/deployments/latest.json`, and the web app no longer uses it.
> Since tokenomics v3 (2026-10-15) NUSD staking is **Earn**, the
> `RewardStaking` contract at `0x59589d9a5840D2CEF7A6e4A8cB55C258cc73E483`
> (`rewardStaking` in `contracts/deployments/v3-core.json`; wired in
> `apps/web/features/fi/config/deployment.ts`). Its unit is **0xPoints**.
> The integration guide is `docs/developers/nusd.md`.

## v3 Earn (RewardStaking)

Source: `contracts/src/rewards/RewardStaking.sol`.

### Units and locks

0xPoints accrue continuously: raw points = weight x seconds, where
`weight = amount * multiplierBps / 10000`. The web app shows `points / 86400`
at 18 decimals, so one 0xPoint is 1 NUSD of lock-weighted stake held for one
day. 100 NUSD on a 30-day lock earns 100 0xPoints per day; longer locks earn
x1.2 / x1.5 / x3 that rate.

| Lock | `lockDuration` (seconds) | `multiplierBps` | 0xPoints per day for 100 NUSD |
| --- | ---: | ---: | ---: |
| 30 days | 2592000 | 10000 (x1) | 100 |
| 90 days | 7776000 | 12000 (x1.2) | 120 |
| 180 days | 15552000 | 15000 (x1.5) | 150 |
| 365 days | 31536000 | 30000 (x3) | 300 |

`lockDuration` must be exactly one of these values, or `stake` reverts
`InvalidLockDuration()`.

0xPoints keep growing every second while the position's weight is counted.
The total is lifetime and readable through `accountState(user).points`.

`RewardStaking` has no admin and no pause. `withdraw(positionId)` works any
time after `unlockTime` and never runs the fee harvest.

### Rewards

v3 has no point redemption and no voucher signer. Rewards are NUSD: every NUSD
the contract receives above principal and owed rewards (the FeeSplitter staker
share, 80% of each NUSD surplus release, donations) is streamed over 7 days
pro rata to weight. Holders take it with `claim(address recipient)` or lock it
into a new position with `claimAndStake(uint32 lockDuration)`.

Direct NUSD escrow reduces circulating NUSD but does not by itself create AMM
liquidity. Staked principal stays in the contract and is never deployed into a
pool.

## Legacy v1 module: NusdPointsStaking (xPoints)

Everything below applies only to the retired v1 contract
`0xDf009d9c2Bc0C2f8ee55A047074edB166C1D3282`. It is kept for history. None of
it (xPoints, `redeemPoints`, `nusdPerXPointWad`, `redemptionEnabled`,
`isSolvent()`, EIP-712 vouchers, the points signer) exists in v3.

### Redemption boundary (v1 only)

Earned, redeemed, and available xPoints, per-user nonces, positions, the
conversion rate, and reserve balances are all queryable on-chain. The ABI keeps
the internal `*PointCredits` field names for compatibility; public interfaces
convert them to xPoints before display.

Public direct redemption starts disabled (and is disabled on the deployed
contract). The web app's former redemption interface rendered only while all of
the following on-chain conditions were true:

1. The separately accounted NUSD redemption reserve is greater than zero.
2. `nusdPerXPointWad` is greater than zero.
3. `redemptionEnabled` is true.
4. `redemptionsPaused` is false.
5. `isSolvent()` is true.

When these conditions are satisfied, a user may call `redeemPoints` directly.
A successful transaction atomically increases the user's
`spentPointCredits`, decreases both `availablePointCredits` and the redemption
reserve, and transfers the quoted NUSD. The redemption reserve is separate from
`totalLocked`, so redemption cannot spend staked user principal. If any
contract check fails, the whole transaction reverts; hiding the interface is a
user-experience guard and is not the security boundary.

The EIP-712 voucher path remains available only as an optional airdrop or
relayed-redemption mechanism. It is not required for normal direct redemption.
For that optional path, the contract verifies chain, contract, account,
recipient, the internal `pointCredits` amount, nonce, deadline, rate version,
reserve, and signer. Changing the rate increments `rateVersion` and invalidates
outstanding vouchers. Successful voucher redemption increments the account
nonce, so it cannot be replayed; a relayer cannot change its recipient or
amount.

Neither path is cryptographically secret. Contract code, events, the configured
rate, signer address, reserve, and completed redemptions are public on-chain.
Security must never depend on hiding `/dev`, the API route, or the conversion
formula.

### Key separation (v1 only)

The following signer controls apply to the optional voucher path. Treat any key
that has appeared in terminal, CI, browser, or agent logs as compromised and
rotate it before deployment. The voucher signer must be a new, unfunded EOA
with no transaction history and must not equal the deployer, owner, or guardian.

Historical setup. The v1 deploy script (`0xFi/scripts/deploy-nusd-points.mjs`)
and the web app's voucher-signing route were removed (commit `bd1ea53`,
2026-11-02), so nothing in the current code reads these variables; only
`0xFi/.env.example` still lists the names. The deployment used these local
files, both gitignored:

- `0xFi/.env.local`: `DEPLOYER_PRIVATE_KEY`,
  `POINTS_SIGNER_PRIVATE_KEY`, `NUSD_POINTS_OWNER`, and
  `NUSD_POINTS_GUARDIAN` for deployment. The workspace-level `.env.local`
  supplied for local operations is also accepted as a missing-value fallback;
  feature-specific values in `0xFi/.env.local` take precedence.
- `apps/web/.env.local`: `POINTS_SIGNER_PRIVATE_KEY`,
  `POINTS_STAKING_ADDRESS`, and `POINTS_SIGNING_DOMAIN` for the server route.

The signer key was never prefixed with `NEXT_PUBLIC_` and was never returned by
an API. The removed deployment script copied only the points signer and public
contract address into the web server's local environment; it never copied the
deployer key.

For production, store the signer as a host secret rather than in a deployed
file. Prefer a dedicated signing service or HSM/KMS boundary before mainnet.

### Testnet runbook (v1 only)

The staking contract was deployed against the v1 suite: its address and
transaction evidence are in `0xFi/contracts/deployments/latest.json`
(`nusdPointsStaking`, `nusdPointsStakingDeploymentBlock`,
`nusdPointsStakingDeploymentHash`), with status
`deployed-redemption-disabled`. Its deploy script was removed
with the other v1 scripts on 2026-11-02; git history keeps it. Do not broadcast
if any general key has appeared in logs. Rotate that key first, then generate
the new auxiliary signer outside logs.

The web app's `/dev` page no longer has xPoints controls, so enabling
redemption would mean calling the v1 contract directly from its owner wallet.
After independently verifying bytecode and constructor arguments, the
fail-closed order is:

1. Fund the isolated NUSD redemption reserve.
2. Set a non-zero `NUSD per xPoints` rate while redemption remains disabled.
3. Re-read the reserve, rate, and `isSolvent()` state from chain.
4. Enable redemption and confirm it is not paused.

Before the full state is valid, direct contract calls revert. If the reserve is
depleted, redemption is paused or disabled, the rate becomes zero, or solvency
is lost, the contract remains the final fail-closed authority.

No mainnet deployment is authorized by this runbook. Mainnet additionally
requires an independent Solidity/economic audit, multisig owner, reviewed
guardian process, production secret storage, distributed rate limiting, incident
rotation drill, and a capped launch policy.
