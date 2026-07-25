# 0xNothing zkLTC Testnet Contracts

This Foundry project contains OracleNUSD, the 0xPump bonding curve, and the
disabled-by-default graduation router. The deployed 0xPixel sources under
`src/0xpixel/reference/` are immutable references and are excluded from builds.

## Test

```powershell
forge test
```

Set `LITVM_RPC_URL` to include the optional DIA fork test. The testnet LTC/USD DIA
AggregatorV3 adapter defaults to `0x45dDa5d881BD2C917976CCfde74fFd6f6412da29`.

Token creation is prepaid: `reserveMarket(contentHash)` charges `1 NUSD` before
the IPFS upload, and `createMarket(..., contentHash)` consumes that sender's
reservation without charging again. Reservations are scoped by owner, have no
refund or expiry, and remain retryable until creation succeeds. Index creation
fees from `CreationFeePaid`, including abandoned reservations. After creation,
`createdTokenByContentHash(owner, contentHash)` recovers the token address if a
client loses its transaction receipt and prevents that owner from reserving the
same content hash again.

OracleNUSD combines the ERC-20 and recognized native-zkLTC reserve. Mint and
redeem are priced from the DIA adapter with zero protocol fee, and independent
`mintPaused` and `redeemPaused` controls are granted to `PROTOCOL_ADMIN`.
`vault()` returns the OracleNUSD contract itself for Pump compatibility. The
supply ceiling limits issuance but is not an overcollateralization guarantee;
the risk model is documented in `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

## Deployment dry run

```powershell
forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url $env:LITVM_RPC_URL
```

Required: `PRIVATE_KEY`. Optional settings are `PROTOCOL_ADMIN`,
`DIA_LTC_USD_FEED`, `DIA_MAX_PRICE_AGE`, `GRADUATION_TIMELOCK`,
`PUMP_TOKEN_TOTAL_SUPPLY`, and `NUSD_DEBT_CEILING`. The release curve fixes the
initial virtual market cap at `1,500 NUSD` and the READY market-cap target at
`6,000 NUSD`; they are not deployment-time environment overrides.
`NUSD_DEBT_CEILING` is retained as the deployment environment name for
compatibility, but its value is passed to `OracleNUSD.supplyCeilingNusd`.

The script rejects any chain other than LitVM testnet chain ID `4441`. Its
`deployments/latest.json` is prediction-only and always records
`broadcasted: false` plus `scriptExecutionBlock`; it is not receipt proof and
must not supply a subgraph start block. The graduation router is deployed
disabled with no adapter. The script deploys DIAOracleAdapter first and then
OracleNUSD; it does not deploy NativeCollateralVault. OracleNUSD is passed to
ZeroXPump as both its NUSD and vault address. When
`PROTOCOL_ADMIN` differs from the deployer, the admin must call `acceptAdmin()`
on the router before scheduling any future DEX adapter. Do not use `--broadcast`
until the deployment phase has been explicitly approved.

Testnet liquidity migration is unavailable: the router is disabled with no
adapter. Reaching a `6,000 NUSD` market cap moves a market to READY and pauses
buys, but does not call a DEX. While a market remains READY, holders may sell;
that atomically reopens the curve to TRADING and prevents funds being locked
while no migration path is available.

After an approved broadcast, preview authoritative receipt data with:

```powershell
.\scripts\Finalize-TestnetDeployment.ps1
```

Review the JSON, then rerun with `-Apply`. The helper reads Foundry's
`run-latest.json`, records every deployed address, transaction hash, and actual
receipt block, verifies broadcast/RPC chain ID `4441`, deployed bytecode, and all
live OracleNUSD/oracle/Pump/router/locker bindings, the constructor-derived
supply ceiling, initial pause state, and protocol-admin roles. It updates the
release manifest,
configures the Pump subgraph from the actual `ZeroXPump` receipt block, and
writes the web `.env.local`. Before replacing the current NUSD and vault aliases,
it preserves their old values under the manifest-only `legacyNusd` and
`legacyNativeCollateralVault` audit fields. Legacy addresses are not written to
the public web environment. Set `LITVM_RPC_URL` or pass `-RpcUrl`; pass
`-SubgraphUrl` once Goldsky returns its endpoint. Never use the script simulation
block as the subgraph start block.
