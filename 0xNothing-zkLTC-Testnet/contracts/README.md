# 0xNothing zkLTC Testnet Contracts

This Foundry project contains NUSD (`OracleNUSDv2`, plus the earlier
`OracleNUSD`), the 0xPump bonding curve (`ZeroXPumpV2`, plus the earlier
`ZeroXPump`), the disabled-by-default graduation router, the v3 tokenomics
contracts (`OracleRouter`, `FeeSplitter`, `RewardStaking`, `OwnerTreasury`),
the NUSD NFT marketplace (`NusdNftMarketplaceV2`) and the active
[0xPixel V2](PIXEL_V2.md) collection with fully on-chain metadata and grids up
to 256. The legacy deployed 0xPixel sources under `src/0xpixel/reference/`
remain immutable references and are excluded from builds.

The live set is v3, active on LiteForge since 2026-10-15. It was deployed by
`script/DeployV3Core.s.sol` (output `deployments/v3-core.json`) as the core
stage of `0xFi/scripts/deploy-v3.mjs`; see `docs/DEPLOYMENT.md` and
`docs/TOKENOMICS.md`. Never rerun the v3 broadcast. The `DeployTestnet.s.sol`
sections below describe the earlier `OracleNUSD`/`ZeroXPump` deployment and are
kept for reference.

## Test

```powershell
forge test
```

Set `LITVM_RPC_URL` to include the optional DIA fork test. The testnet LTC/USD DIA
AggregatorV3 adapter defaults to `0x45dDa5d881BD2C917976CCfde74fFd6f6412da29`.

Token creation is prepaid: `reserveMarket(contentHash)` charges the current
`createFee()` (`1 NUSD` on the live `ZeroXPumpV2`) before the IPFS upload, and `createMarket(..., contentHash)` consumes that sender's
reservation without charging again. Reservations are scoped by owner, have no
refund or expiry, and remain retryable until creation succeeds. Index creation
fees from `CreationFeePaid`, including abandoned reservations. After creation,
`createdTokenByContentHash(owner, contentHash)` recovers the token address if a
client loses its transaction receipt and prevents that owner from reserving the
same content hash again.

`OracleNUSDv2` combines the ERC-20 and recognized native-zkLTC reserve. Mint
and redeem are priced through the LTC `OracleRouter` (a DIA adapter behind it)
with zero fee on the live deployment (capped at `MAX_FEE_BPS = 50`). Only
minting can be paused (`mintPaused`, `PAUSER_ROLE`); redemption has no pause,
and `emergencyRedeem` pays the pro-rata reserve 7 days after
`reportOracleFailure`. The earlier `OracleNUSD` had separate `mintPaused` and
`redeemPaused` controls. `vault()` returns the NUSD contract itself for Pump
compatibility. The
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

The initial deployment deliberately leaves liquidity migration unavailable. On
the live testnet the router has since completed its delayed enable and its 0xFi
adapter activation, and the pinned controller now holds both Pump and router
administration, so the controller path is active. The authoritative state is
`pump.graduation` in `deployments/liteforge-testnet/deployments.json`: treat the
path as live only while `enabled`, `adapterAllowed`, `controllerOwnsPumpAdmin`,
`controllerOwnsRouterAdmin`, and `operational` are all true.
Reaching a `6,000 NUSD` market cap moves a market to READY and pauses
buys; while a market remains READY, holders may sell, atomically reopening the
curve to TRADING.

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
