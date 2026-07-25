# 0xNothing zkLTC Mainnet Contracts

This Foundry project mirrors the tested NUSD, 0xPump, and graduation architecture
without assuming a mainnet DIA feed or DEX deployment.

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

NUSD has no grantable minter or burner roles: its constructor binder calls
`bindVault` once, after which that vault is the sole mint/burn authority and the
binding cannot be changed. `burnFrom` still requires the token owner's allowance.

## Deployment dry run

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url $env:MAINNET_RPC_URL
```

Required: `PRIVATE_KEY`, `DIA_LTC_USD_FEED`, `NUSD_DEBT_CEILING`,
`EXPECTED_MAINNET_CHAIN_ID`, and the explicit release gate
`MAINNET_RELEASE_APPROVED=true`. Optional settings are
`PROTOCOL_ADMIN`, `DIA_MAX_PRICE_AGE`, `GRADUATION_TIMELOCK`,
and `PUMP_TOKEN_TOTAL_SUPPLY`. The release curve fixes the initial virtual
market cap at `1,500 NUSD` and READY at a literal `6,000 NUSD` market cap.

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

Mainnet oracle release blocker: validate the final DIA feed, debt ceiling, price
monitoring, and a deviation/value-bound policy before setting
`MAINNET_RELEASE_APPROVED=true`. The vault has separate mint/withdraw and
liquidation pauses for incident response: `setRiskOperationsPaused` stops new
debt and collateral withdrawals, while `setLiquidationsPaused` stops
liquidations only. Deposits, debt repayment, and bad-debt coverage remain
available. A single-feed deviation policy still requires an explicit production
decision and audit.

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
