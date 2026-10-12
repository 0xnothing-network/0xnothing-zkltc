# Testnet deployment runbook

Contract and subgraph deployment is intentionally the final phase. Do not pass
`--broadcast` until an explicit go-ahead. This document's forge command is the
canonical Pump/OracleNUSD deploy path for LiteForge (chain ID 4441).

## 0. Forge script path (no broadcast)

From `0xNothing-zkLTC-Testnet/contracts`, using Foundry 1.8.x on PATH:

```bash
export PRIVATE_KEY="$(cast wallet new | awk '/Private key/{print $3}')" # throwaway, simulation only
export LITVM_RPC_URL=https://liteforge.rpc.caldera.xyz/infra-partner-http
./scripts/preflight-testnet-oracle.sh
forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url "$LITVM_RPC_URL"
```

PowerShell:

```powershell
$env:PRIVATE_KEY = (cast wallet new | Select-String "Private key").ToString().Split(" ")[-1]
$env:LITVM_RPC_URL = "https://liteforge.rpc.caldera.xyz/infra-partner-http"
cast chain-id --rpc-url $env:LITVM_RPC_URL
cast call 0x45dDa5d881BD2C917976CCfde74fFd6f6412da29 "latestRoundData()((uint80,int256,uint256,uint256,uint80))" --rpc-url $env:LITVM_RPC_URL
forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url $env:LITVM_RPC_URL
```

The script reverts unless `block.chainid == 4441`. It always writes
`contracts/deployments/latest.json` with `broadcasted: false`; that file is
prediction-only and must not be used as a subgraph start block. Copy
`contracts/.env.example` to `contracts/.env` for local values. Foundry loads
`.env` automatically; `.env` is gitignored.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PRIVATE_KEY` | yes | none | Deployer key. Needed even without `--broadcast` because the script calls `vm.envUint` / `vm.addr`. |
| `LITVM_RPC_URL` | yes (forge CLI) | none | RPC for `--rpc-url`. Not read by the Solidity script. Alias: `forge script ... --rpc-url liteforge` after setting this. |
| `PROTOCOL_ADMIN` | no | deployer | Intended Pump, router, and DIA adapter admin, and OracleNUSD default-admin/pauser. Pump is constructed with the deployer as admin so the script can set launch protection; if `PROTOCOL_ADMIN` differs, that address must later `acceptAdmin()` on `ZeroXPump`, `GraduationRouter`, and `DIAOracleAdapter`. |
| `DIA_LTC_USD_FEED` | no | `0x45dDa5d881BD2C917976CCfde74fFd6f6412da29` | LiteForge DIA LTC/USD AggregatorV3. |
| `DIA_MAX_PRICE_AGE` | no | `3600` (60 min) | Oracle staleness window in seconds. On-chain cap is 300–7200. The live feed publishes about every 50 minutes; values below 3600 halt mint/redeem between updates. |
| `DIA_MIN_PRICE_WAD` | no | `1e18` (1 USD) | Inclusive minimum accepted LTC/USD. |
| `DIA_MAX_PRICE_WAD` | no | `10000e18` | Inclusive maximum accepted LTC/USD. |
| `DIA_MAX_DEVIATION_BPS` | no | `2000` | Max move per `maxPriceAge` vs the last synced anchor, capped at three intervals. `0` disables. The script rejects ages outside 300–7200s, min below `0.01e18`, max above `1_000_000e18`, inverted bounds, and deviation above 10_000 bps. |
| `GRADUATION_TIMELOCK` | no | `172800` (2 days) | `GraduationRouter.minimumDelay`. |
| `PUMP_TOKEN_TOTAL_SUPPLY` | no | `1_000_000_000e18` | Fixed supply of every Pump token. |
| `NUSD_DEBT_CEILING` | no | `1_000_000e18` | Passed to `OracleNUSD.supplyCeilingNusd`. |
| `LAUNCH_PROTECTION_WINDOW` | no | `900` (15 min) | Per-market anti-snipe window. `0` disables. On-chain cap is 1 hour. |
| `LAUNCH_MAX_BUY_NUSD` | no | `50e18` | Cumulative gross NUSD each buyer may spend during that window. Required non-zero when the window is non-zero. |

Not env-overridable: chain ID `4441`, initial virtual reserve `1,500 NUSD`, READY
market-cap target `6,000 NUSD`, create fee `1 NUSD`, trade fee `10` bps.
Graduation delays default to `permissionlessGraduationDelay = 1 hour` and
`readyExitDelay = 24 hours` (admin-settable up to 3 days). `graduate` uses the
admin-set `graduationAdapter` (unset at deploy) and an on-chain UniV2 minLP; the
caller's adapter/minimumLp arguments are ignored. After the 0xFi adapter is
activated, the Pump admin must call `setGraduationAdapter`.

The script does **not** call `syncPrice()`. The live DIA aggregator uses shanghai
PUSH0, which reverts with `NotActivated` inside this project's paris Foundry EVM
and would block both simulation and `--broadcast`. Preflight the live feed with
`scripts/preflight-testnet-oracle.sh` (or the `cast call latestRoundData` above).
After an approved broadcast, `syncPrice()` **must** be called on-chain to arm the
deviation breaker. Until then, deviation is skipped while the anchor is zero;
min/max bounds still apply, so mint/redeem are not unpriced. Anyone may call
`syncPrice()`:

```bash
cast send "$DIA_ORACLE_ADAPTER" "syncPrice()" --rpc-url "$LITVM_RPC_URL" --private-key "$PRIVATE_KEY"
```

OracleNUSD mints and redeems at the DIA price with no protocol fee and a 3600s
default `maxPriceAge`. That is an owner decision: a stale or manipulated feed
can mint NUSD against native collateral at an off-market rate, and there is no
spread to absorb oracle error. Keep `DIA_MAX_PRICE_AGE` at 3600 unless the feed
heartbeat changes; do not treat the zero-fee reserve as overcollateralized.

`DeployTestnet.s.sol` does not deploy 0xFi. `ZeroXFiFactory.pump` is immutable, so
a live Pump replacement also needs a new 0xFi factory, `ZeroXFiGraduationAdapter`
bound to that pump, router adapter allowlisting, and `PumpGraduationController`
as Pump/router admin before the keeper (`npm run pump:keeper:check` in `0xFi`)
can call `graduateReady`. Do not fold those delayed 0xFi transactions into this
script.

## 1. Preflight

- Run all Forge tests, including fuzz and invariant suites.
- Build both subgraphs.
- Run TypeScript, lint, and production web builds.
- Verify 0xPixel routes and marketplace RPC fallbacks against the live contracts.
- Configure a funded LitVM deployer without committing its private key.
- Create a scoped Pinata JWT and test group; keep it server-only.

## 2. Deploy OracleNUSD

Deploy the DIA oracle adapter first, then deploy `OracleNUSD` with that adapter,
the protocol admin, and the `NUSD_DEBT_CEILING` value as its NUSD supply ceiling.
Do not deploy a new `NativeCollateralVault`. Verify that `oracle()` points to the
new adapter, `vault()` returns the OracleNUSD address itself,
`supplyCeilingNusd()` matches the constructor argument, both pause flags are
false, and the protocol admin holds both the default-admin and pauser roles.

Exercise mint, redeem, and `coverReserve` with small testnet amounts. Do not
transfer or migrate legacy NUSD balances or vault positions into this system;
keep the previous addresses only in the explicit historical manifest fields.

## 3. Deploy 0xPump

Deploy the launchpad with the OracleNUSD address as both its NUSD and vault
constructor arguments, plus the fee recipient, fixed supply,
`1,500 NUSD` initial virtual market cap, and fixed `6,000 NUSD` READY market-cap
target. Verify onchain that `graduationThresholdNusd` is the market-cap target,
that `graduationReserveThresholdNusd` is the derived real-reserve target
(`1,500 NUSD` for these parameters), and that the creation and trade fees are
exactly `1 NUSD` and `10` basis points. The graduation router must start disabled
with no adapter. A later 0xFi activation is a separate delayed operation and
must not be folded into this deployment transaction.

Write addresses and the receipt block to `deployments/liteforge-testnet/deployments.json` and the web public environment.

## 4. Deploy the Pump subgraph

Patch the launchpad address and deployment block into the manifest, then run codegen and build again.

```powershell
goldsky subgraph deploy zeroxpump-testnet/0.1.3 --path . --tag staging
```

Record the endpoint in the deployment manifest and web configuration. Do not redeploy the 0xPixel subgraph.

## 5. Smoke test

- Mint and redeem OracleNUSD at the live DIA price, and confirm reserve accounting.
- Reserve a content hash for exactly `1 NUSD` plus gas.
- Upload that exact logo and metadata, then create the token without a second fee.
- Confirm changed content cannot use the first reservation and a same-content retry can.
- Buy and sell with the `0.1%` fee and confirm contract/subgraph agreement.
- Confirm the market moves to `READY` at a `6,000 NUSD` market cap. Buys stop.
  Before 0xFi activation (no `graduationAdapter` / router not enabled), READY
  sells stay open so holders are not frozen. After activation and
  `setGraduationAdapter`, READY sells freeze until `readyExitDelay`.
- After 0xFi activation, confirm the pinned adapter/controller/admin bindings
  and that Pump `graduationAdapter` matches the 0xFi adapter, then graduate
  through `graduateReady` (the same call the keeper uses).
- Confirm a READY sell while graduation is possible reverts until
  `readyExitDelay`; after that delay a sell reopens the curve as `TRADING` in
  the contract, subgraph, and UI.
- Confirm 0xPixel mint, gallery, marketplace, history, and fallback behavior remain unchanged.
- Confirm removed legacy routes return `404`.
