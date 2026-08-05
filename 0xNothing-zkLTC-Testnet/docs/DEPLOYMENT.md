# Testnet deployment runbook

Contract and subgraph deployment is intentionally the final phase.

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
- Confirm the market moves to `READY` at a `6,000 NUSD` market cap. Before 0xFi
  activation, confirm migration is unavailable; after activation, confirm the
  exact pinned adapter/controller/admin bindings before testing graduation.
- Sell once from `READY` and confirm the contract, subgraph, and UI all reopen
  the curve as `TRADING`.
- Confirm 0xPixel mint, gallery, marketplace, history, and fallback behavior remain unchanged.
- Confirm removed legacy routes return `404`.
