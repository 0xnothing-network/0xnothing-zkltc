# Deployment Manifests

`DeployTestnet.s.sol` writes simulated or predicted addresses to `latest.json`
with `broadcasted: false` and `scriptExecutionBlock`. It is never receipt proof.
Only the receipt-driven finalizer may populate the release manifest and the
0xPump subgraph start block after live chain and binding verification.
The finalized Pump record uses `oracleNusd` as the canonical current stablecoin,
with `nusd` and `nusdVault` pointing to the same address for consumer
compatibility. `nativeCollateralVault` is null. Before replacing those current
fields, the finalizer preserves the previous NUSD and vault addresses as
`legacyNusd` and `legacyNativeCollateralVault`.
The finalized manifest must preserve the fixed `6,000 NUSD` READY market-cap
target and its derived `1,500 NUSD` reserve target. The receipt finalizer records
the router's initial disabled/no-adapter state. Any later 0xFi activation update
must come from explicit live RPC verification and record adapter, controller,
admin-readiness, and verification-block fields rather than simulation output.
