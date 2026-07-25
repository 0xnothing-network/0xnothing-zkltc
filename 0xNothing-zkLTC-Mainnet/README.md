# 0xNothing zkLTC Mainnet overlay

This directory is a release overlay for the future zkLTC mainnet. It is not a second independently developed copy of the frontend.

```text
apps/web-release/       tested release-tag and environment promotion contract
contracts/              production NUSD, vault, Pump, router, adapters, tests
subgraphs/0xpump/       mainnet indexing package and deployment blocker notes
deployments/            immutable address manifest after launch
config/networks/        chain and provider configuration when published
scripts/                deployment and verification tooling
tests/                  end-to-end release evidence
docs/                   mainnet and graduation gates
```

No mainnet address is guessed. No legacy DEX is treated as the graduation target.
The fixed Pump READY target is a `6,000 NUSD` market cap. Production graduation
will first convert or bridge the curve's NUSD into the official zkLTC stablecoin,
then seed and list the token against that stablecoin on an approved major DEX.
The stablecoin, route, DEX, and adapter addresses remain `null` until their
official interfaces are published and the release gates are complete.
