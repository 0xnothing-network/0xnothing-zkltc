
# Deployment Manifests

- `v3-core.json`: the live v3 core set (oracle routers, NUSD, treasury, fee
  splitter, reward staking, liquidity locker, graduation router, 0xPump, NUSD
  marketplace, 0xPixel collections), written by `DeployV3Core.s.sol`. Active
  since 2026-10-15. The combined live record, with the 0xFi addresses and
  creation blocks, is `deployments/liteforge-testnet/v3.json`.
- `v2-core.json`: the previous core set, kept for reference.

`DeployTestnet.s.sol` writes the earlier deployment's prediction-only
`latest.json`, and setting `V3_MANIFEST_SUFFIX` makes `DeployV3Core.s.sol`
write a variant such as `v3-core.rehearsal.json`. Both are git-ignored
(`contracts/.gitignore`); generated manifests stay out of source control until a
reviewed deployment is explicitly approved.
