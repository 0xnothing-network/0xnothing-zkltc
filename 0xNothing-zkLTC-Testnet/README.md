# 0xNothing zkLTC Testnet

The active LitVM testnet workspace contains only 0xPixel and 0xPump.

Every 0xPump market has a fixed `6,000 NUSD` READY market-cap target. Reaching
that target stops buys, but does not migrate liquidity on testnet: the
graduation router is deployed disabled with no adapter. A holder may still sell
from `READY`, which reopens the curve as `TRADING`.

```text
apps/web/                         Next.js application
contracts/                        Foundry contracts and tests
  src/0xpixel/reference/          exact source references for live deployments
  src/0xpump/                     bonding-curve launchpad
  src/nusd/                       OracleNUSD, DIA adapter, and legacy references
  src/graduation/                 disabled-by-default graduation router
subgraphs/0xpixel-marketplace/    existing 0xPixel indexer, unchanged deployment
subgraphs/0xpump/                 new 0xPump indexer
deployments/liteforge-testnet/    checked deployment manifest
config/networks/                  public network configuration
docs/                             architecture, security, and deployment runbooks
```

## Existing 0xPixel deployment

- NFT: `0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988`, start block `24867130`
- Marketplace: `0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4`, start block `24867505`

These addresses and their marketplace subgraph remain in place. Deployment scripts must never redeploy them.
