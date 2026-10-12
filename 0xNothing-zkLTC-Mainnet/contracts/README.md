# 0xNothing zkLTC Mainnet Contracts

This Foundry project contains the mainnet-candidate OracleNUSD, 0xPump, and
graduation architecture without assuming a mainnet DIA feed or DEX deployment.

## Test

```powershell
forge test
```

The optional fork test runs only when both `MAINNET_RPC_URL` and
`DIA_LTC_USD_FEED` are configured.

Token creation is prepaid: `reserveMarket(contentHash)` charges `1 NUSD` before
the IPFS upload, and `createMarket(..., contentHash)` consumes that sender's
reservation without charging again. Reservations are scoped by owner, have no
refund or expiry, and remain retryable until creation succeeds. Index creation
fees from `CreationFeePaid`, including abandoned reservations. After creation,
`createdTokenByContentHash(owner, contentHash)` recovers the token address if a
client loses its transaction receipt and prevents that owner from reserving the
same content hash again.

`OracleNUSD` is both the NUSD ERC-20 and its native zkLTC reserve. A user deposits
native zkLTC directly through `mintAtOracle`; the contract mints
`floor(msg.value * priceWad / 1e18)` NUSD, so `$1` of zkLTC at the DIA oracle
price mints `1 NUSD`. `redeemAtOracle` burns the caller's NUSD and returns
`floor(amountNusd * 1e18 / priceWad)` native zkLTC at the current oracle price.
There is no borrowing position, minimum collateral ratio, interest, or
liquidation. `vault()` returns the OracleNUSD contract itself for Pump
compatibility. The legacy `NUSD.sol` and `NativeCollateralVault.sol` remain only
as reference code and are not instantiated by `DeployMainnet.s.sol`.

## Deployment dry run

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url $env:MAINNET_RPC_URL
```

Required: `PRIVATE_KEY`, `DIA_LTC_USD_FEED`, `EXPECTED_MAINNET_CHAIN_ID`,
the oracle policy `DIA_MAX_PRICE_AGE` (5 minutes to 2 hours),
`DIA_MIN_PRICE_WAD`, `DIA_MAX_PRICE_WAD`, and `DIA_MAX_DEVIATION_BPS`, and the
explicit release gate `MAINNET_RELEASE_APPROVED=true`. The oracle values have no
defaults because they depend on the final feed's heartbeat. The script rejects
ages outside 300–7200s, min below `0.01e18`, max above `1_000_000e18`, inverted
bounds, and deviation above 10_000 bps. Optional settings are `PROTOCOL_ADMIN`,
`GRADUATION_TIMELOCK`, `PUMP_TOKEN_TOTAL_SUPPLY`, `LAUNCH_PROTECTION_WINDOW`
(default 15 minutes), and `LAUNCH_MAX_BUY_NUSD` (default 50 NUSD, cumulative per
buyer). The release curve fixes the initial virtual
market cap at `1,500 NUSD` and READY at a literal `6,000 NUSD` market cap.
The deployment fixes `supplyCeilingNusd` to `type(uint256).max`, so there is no
practical protocol-wide issuance cap. Every mint still requires a native zkLTC
deposit valued 1:1 in USD by the DIA oracle.

The script rejects chain ID `4441`, local chain ID `31337`, zero, and any RPC
whose chain ID differs from `EXPECTED_MAINNET_CHAIN_ID`. Its
`deployments/latest.json` is prediction-only and always records
`broadcasted: false` plus `scriptExecutionBlock`; a receipt-driven mainnet
finalizer must replace it after an approved broadcast. The graduation router
starts disabled and has no adapter. A future adapter must atomically convert or
bridge NUSD into the official zkLTC stablecoin before seeding the approved
token/stablecoin pool on a major DEX. It must be implemented, audited,
timelock-scheduled, and activated only after the official stablecoin, settlement
route, DEX interface, and pool semantics are final. When `PROTOCOL_ADMIN` differs
from the deployer, the admin must call `acceptAdmin()` on Pump, the router, and
DIAOracleAdapter. After an approved broadcast, `syncPrice()` must be sent on the
DIA adapter. Do not use `--broadcast` until the deployment phase has been
explicitly approved.

Mainnet oracle release blocker: validate the final DIA feed, the maximum supply
ceiling decision, price monitoring, and the adapter's bound/deviation values
before setting `MAINNET_RELEASE_APPROVED=true`. DIAOracleAdapter rejects prices
outside `[minPriceWad, maxPriceWad]` and moves larger than `maxDeviationBps` per
`maxPriceAge` interval from the last synced anchor; the allowance grows with
elapsed time up to three intervals so a real move self-heals without unbounded
drift, and the admin can re-anchor with
`resetPriceAnchor()` but can never supply a price. OracleNUSD has independent mint and
redeem pause controls, and anyone can add native backing through `coverReserve`.
This model is not overcollateralized: if zkLTC falls after NUSD is minted, the
reserve's current USD value can fall below the NUSD supply and full redemption
can require more zkLTC than the contract holds. A reserve deficit blocks the
affected redemption until backing is added; it is not automatically socialized
or liquidated. This behavior and the single-feed policy require an explicit
production decision and audit.

The admin may graduate a READY market without waiting; any account may graduate
it once `permissionlessGraduationDelay` has elapsed. Pause stops reservation,
creation, buys, and every graduation, including the admin path, but not sells.
The router enable/adapter controls are the separate graduation emergency domain.
`graduate` ignores caller adapter/minimumLp and uses the configured adapter plus
an on-chain UniV2 minLP. A READY market rejects buys. Sells freeze only while
graduation is possible (adapter set, router enabled, adapter allowlisted); when
that freeze applies, they reopen the curve only after `readyExitDelay` (default
24 hours, max 3 days). After broadcast, `syncPrice()` must be called on the DIA
adapter. OracleNUSD remains a zero-fee, 3600s-maxAge mint/redeem model: a stale
or manipulated feed can mint at an off-market rate, with no spread to absorb
oracle error.

The current router requires synchronous same-transaction settlement and checks
an ERC-20 LP-token balance before transferring it to the permanent locker. An
asynchronous bridge or DEX that returns an NFT liquidity position requires a
reviewed router/adapter/locker redesign. The current adapter parameters also lack
a minimum official-stablecoin output, so no production adapter may be enabled
until that bound and the final route identity checks are implemented and audited.
