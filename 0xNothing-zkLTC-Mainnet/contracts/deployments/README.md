# Deployment Manifests

`DeployMainnet.s.sol` writes simulated or predicted addresses to `latest.json`
with `broadcasted: false` and `scriptExecutionBlock`. It is never receipt proof.
A receipt-driven finalizer must replace it after an approved mainnet broadcast
and live post-deployment verification.
The release manifest must keep the official zkLTC stablecoin, approved NUSD
conversion/bridge route, major DEX, adapter, and LP-lock details unset until each
address and interface is independently verified. It must also record the fixed
`6,000 NUSD` READY market-cap target and the derived reserve target.
