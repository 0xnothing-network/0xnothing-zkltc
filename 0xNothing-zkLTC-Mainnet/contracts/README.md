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
and the explicit release gate
`MAINNET_RELEASE_APPROVED=true`. Optional settings are
`PROTOCOL_ADMIN`, `DIA_MAX_PRICE_AGE`, `GRADUATION_TIMELOCK`,
and `PUMP_TOKEN_TOTAL_SUPPLY`. The release curve fixes the initial virtual
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
from the deployer, the admin must call `acceptAdmin()` on the router. Do not use
`--broadcast` until the deployment phase has been explicitly approved.

Mainnet oracle release blocker: validate the final DIA feed, the maximum supply
ceiling decision, price monitoring, and a deviation/value-bound policy before
setting `MAINNET_RELEASE_APPROVED=true`. OracleNUSD has independent mint and
redeem pause controls, and anyone can add native backing through `coverReserve`.
This model is not overcollateralized: if zkLTC falls after NUSD is minted, the
reserve's current USD value can fall below the NUSD supply and full redemption
can require more zkLTC than the contract holds. A reserve deficit blocks the
affected redemption until backing is added; it is not automatically socialized
or liquidated. This behavior and the single-feed policy require an explicit
production decision and audit.

Graduation is admin/multisig-triggered, not permissionless. The Pump pause stops
market creation and curve trades; the router enable/adapter controls are the
separate graduation emergency domain. An admin can pause trading and then
graduate a READY market. While a market remains READY, holders may sell; that
atomically reopens the curve to TRADING and prevents funds being locked while no
DEX path is available.

The current router requires synchronous same-transaction settlement and checks
an ERC-20 LP-token balance before transferring it to the permanent locker. An
asynchronous bridge or DEX that returns an NFT liquidity position requires a
reviewed router/adapter/locker redesign. The current adapter parameters also lack
a minimum official-stablecoin output, so no production adapter may be enabled
until that bound and the final route identity checks are implemented and audited.
