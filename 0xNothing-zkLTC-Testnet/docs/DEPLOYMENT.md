# Testnet deployment runbook

Contract and subgraph deployment is intentionally the final phase.

The v3 set has been live on LiteForge (chain id `4441`) since 2026-10-15:
`deployments/liteforge-testnet/v3.json` records `"stage": "active"`, and `main`
(the only branch) carries the published configuration. **Do not run
`deploy:v3` (`--broadcast`) again**: it refuses a `seeded` or `active` manifest
("v3 is already deployed"), and a new set would not inherit balances, stakes,
markets or listings. This runbook describes how the live set was produced and
what to re-check; use `deploy:v3:rehearse` (a local anvil fork) to exercise it.

All v3 stages run from one orchestrator, `0xFi/scripts/deploy-v3.mjs`, through
the scripts in `0xFi/package.json`:

| Script | Stage |
| --- | --- |
| `npm --prefix 0xNothing-zkLTC-Testnet/0xFi run deploy:v3:rehearse` | Full run on a local anvil fork: deploy, seed, smoke-test, warp, activate |
| `deploy:v3` | Live deploy (core, then 0xFi) and seed liquidity; resumable stage by stage |
| `deploy:v3:activate` | After the 1-hour graduation delay: open graduation, hand admin to the controller |
| `deploy:v3:publish` | Switch network config, subgraph configs and web config to the v3 set |
| `deploy:v3:status` | Read-only summary |

## 1. Preflight

- Run `npm run verify` from the repository root: tooling tests, web tests, all
  Forge suites (including fuzz and invariant suites), both subgraph checks, the
  0xFi build (scripts, contracts, subgraph, web typecheck/lint/build) and the
  wallet.
- Verify 0xPixel routes and marketplace RPC fallbacks against the live contracts.
- Configure a funded LitVM deployer without committing its private key. The
  orchestrator reads the key from the testnet `.env.local` into memory and only
  hands it to Forge through the child environment.
- Create a scoped Pinata JWT and test group; keep it server-only.

## 2. Deploy the core (oracles, NUSD, fees, 0xPump)

`contracts/script/DeployV3Core.s.sol` deploys the LTC, BTC and ETH
`OracleRouter`s over the existing DIA adapters (each must report a
`maxPriceAge` of 90 minutes), `OracleNUSDv2`, `OwnerTreasury`,
`RewardStaking`, `FeeSplitter`, the permanent liquidity locker, the graduation
router, `ZeroXPumpV2` and the `NusdNftMarketplaceV2`, and writes
`contracts/deployments/v3-core.json`. Before writing it, the script checks the
live configuration and reverts on any difference, including:

- NUSD: oracle is the LTC router, supply ceiling `1,000,000 NUSD`,
  `surplusTriggerBps` `33_000`, mint and redeem fees `0`.
- `RewardStaking.harvester()` is the `FeeSplitter`.
- 0xPump: `feeRecipient` is the `FeeSplitter`, NUSD is the v3 NUSD, not paused,
  `createFee` `1 NUSD`, `tradeFeeBps` `10`, initial virtual reserve
  `1,500 NUSD`, `graduationThresholdNusd` `6,000 NUSD` (the READY market-cap
  target) and `graduationReserveThresholdNusd` `1,500 NUSD` (the derived real
  reserve target).

The graduation router starts disabled with no adapter; activating 0xFi
graduation is a separate delayed operation (step 4).

Do not deploy a new `NativeCollateralVault`, and do not transfer or migrate
earlier NUSD balances or vault positions into this system; earlier addresses
stay only in historical manifest fields.

## 3. Deploy 0xFi and seed

`0xFi/contracts/script/Deploy0xFiV3.s.sol` deploys `ZeroXFiFactoryV2`,
`ZeroXFiRouterV2`, the graduation adapter and controller, the gauge factory,
the synth vaults and safety reserve, `PooledNUSDLendingPoolV2`, the LP locker
and the metadata registry, creates the WzkLTC, nBTC and nETH pairs against NUSD
with their gauges, registers the fee sources on the `FeeSplitter`, and writes `0xFi/contracts/deployments/v3-fi.json`.
The orchestrator then seeds the NUSD pairs and records every address and
creation block in `deployments/liteforge-testnet/v3.json` (stage `seeded`).

## 4. Activate graduation

After the router's 1-hour delay (`graduationDelaySeconds: 3600` in
`v3-core.json`), `deploy:v3:activate` enables the router, allows the pinned
0xFi adapter and hands Pump and router admin to the
`PumpGraduationController`, then marks the manifest `active`. The resulting
state is recorded under `pump.graduation` in
`deployments/liteforge-testnet/deployments.json` (`enabled`,
`controllerOwnsPumpAdmin`, `controllerOwnsRouterAdmin`, `operational`).

## 5. Publish and deploy the subgraphs

`deploy:v3:publish` patches the network config, the three subgraph configs and
the web config (`apps/web/features/fi/config/testnet.generated.json`) with the
v3 addresses and creation blocks. Then rebuild and deploy each subgraph, for
example:

```powershell
npm --prefix 0xNothing-zkLTC-Testnet/subgraphs/0xpump run deploy
```

The live Goldsky versions are `zeroxpump-testnet/1.0.0`,
`zeroxfi-testnet/1.0.0` and `pixel-nusd-market/1.1.0`; their endpoints are in
`testnet.generated.json`. Do not redeploy the 0xPixel subgraph.

## 6. Smoke test

- `deploy:v3:status`, and the fork test
  `forge test --root 0xNothing-zkLTC-Testnet/contracts --match-contract TokenomicsSmokeForkTest`
  with `LITVM_RPC_URL` set (no transactions are sent).
- Mint and redeem NUSD at the live oracle price, and confirm reserve accounting.
- Reserve a content hash for exactly the current `createFee()` plus gas.
- Upload that exact logo and metadata, then create the token without a second fee.
- Confirm changed content cannot use the first reservation and a same-content retry can.
- Buy and sell with the market's trade fee and confirm contract/subgraph agreement.
- Confirm the market moves to `READY` at a `6,000 NUSD` market cap and that
  graduation succeeds only through the pinned controller, adapter and router.
- Sell once from `READY` on a market that has not graduated and confirm the
  contract, subgraph, and UI all reopen the curve as `TRADING`.
- Stake NUSD, run `harvest()` (or "Distribute fees" on `/nusd/earn`) and confirm
  the fee split and the 7-day reward stream.
- Confirm 0xPixel mint, gallery, marketplace, history, and fallback behavior remain unchanged.
- Confirm removed legacy routes return `404`.
