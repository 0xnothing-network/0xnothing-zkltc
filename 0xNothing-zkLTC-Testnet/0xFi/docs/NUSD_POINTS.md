# NUSD staking and xPoints

This optional module replaces the public zkLTC/NUSD LP-farm entry. The legacy
route and all zkLTC/NUSD gauge controls are removed from the product UI. It does
not modify the AMM, router, NUSD, pair, gauge factory, or historical on-chain
gauge state. nBTC/NUSD and nETH/NUSD LP farms remain on `/0xFi/earn`.

## Units and locks

Every public interface uses only the `xPoints` unit and rounds displayed values
to the nearest `0.01xPoints`. At the base multiplier:

- `1 NUSD` staked awards `0.01xPoints`.
- `100 NUSD` staked awards `1.00xPoints`.
- Longer locks multiply that xPoints amount according to the table below.

| Lock | Multiplier | xPoints for 100 NUSD |
| --- | ---: | ---: |
| 30 days | x1 | 1.00 |
| 90 days | x1.2 | 1.20 |
| 180 days | x1.5 | 1.50 |
| 365 days | x3 | 3.00 |

xPoints are fixed when `stake` confirms. Principal cannot be withdrawn before
the selected timestamp, and a matured position remains withdrawable even if new
stakes or redemptions are paused.

Direct NUSD escrow reduces circulating NUSD but does not by itself create AMM
liquidity: an actual LP strategy also needs a counter-asset and introduces
market, slippage, and custody risk. This module deliberately keeps user
principal isolated instead of silently deploying it into the zkLTC/NUSD pool.

## Redemption boundary

Earned, redeemed, and available xPoints, per-user nonces, positions, the
conversion rate, and reserve balances are all queryable on-chain. The ABI keeps
the internal `*PointCredits` field names for compatibility; public interfaces
convert them to xPoints before display.

Public direct redemption starts disabled. The public redemption interface is
rendered only while all of the following on-chain conditions are true:

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

## Key separation

The following signer controls apply to the optional voucher path. Treat any key
that has appeared in terminal, CI, browser, or agent logs as compromised and
rotate it before deployment. The voucher signer must be a new, unfunded EOA
with no transaction history and must not equal the deployer, owner, or guardian.

Use these local files; both are gitignored:

- `0xFi/.env.local`: `DEPLOYER_PRIVATE_KEY`,
  `POINTS_SIGNER_PRIVATE_KEY`, `NUSD_POINTS_OWNER`, and
  `NUSD_POINTS_GUARDIAN` for deployment. The workspace-level `.env.local`
  supplied for local operations is also accepted as a missing-value fallback;
  feature-specific values in `0xFi/.env.local` take precedence.
- `apps/web/.env.local`: `POINTS_SIGNER_PRIVATE_KEY`,
  `POINTS_STAKING_ADDRESS`, and `POINTS_SIGNING_DOMAIN` for the server route.

The signer key is never prefixed with `NEXT_PUBLIC_` and is never returned by an
API. The deployment script copies only the points signer and public contract
address into the web server's local environment after a successful deployment;
it never copies the deployer key.

For production, store the signer as a host secret rather than in a deployed
file. Prefer a dedicated signing service or HSM/KMS boundary before mainnet.

## Testnet runbook

Do not broadcast if any general key has appeared in logs. Rotate that key first,
then generate the new auxiliary signer outside logs.

```text
cd 0xNothing-zkLTC-Testnet/0xFi
npm run check:contracts
npm run points:deploy:check
npm run points:deploy:testnet
npm run dev
```

`points:deploy:check` simulates construction, verifies chain and bindings,
requires a fresh unfunded signer, and checks deployer gas with a 20% buffer. It
does not broadcast. `points:deploy:testnet` persists the address and transaction
evidence to the deployment manifests and web configuration. It does not enable
redemption.

After independently verifying bytecode and constructor arguments, use `/dev`
in this fail-closed order:

1. Fund the isolated NUSD redemption reserve.
2. Set a non-zero `NUSD per xPoints` rate while redemption remains disabled.
3. Re-read the reserve, rate, and `isSolvent()` state from chain.
4. Enable redemption and confirm it is not paused.

Before the full state is valid, the public redemption interface stays hidden
and direct contract calls revert. If the reserve is depleted, redemption is
paused or disabled, the rate becomes zero, or solvency is lost, the interface
must hide again and the contract remains the final fail-closed authority.

No mainnet deployment is authorized by this runbook. Mainnet additionally
requires an independent Solidity/economic audit, multisig owner, reviewed
guardian process, production secret storage, distributed rate limiting, incident
rotation drill, and a capped launch policy.
