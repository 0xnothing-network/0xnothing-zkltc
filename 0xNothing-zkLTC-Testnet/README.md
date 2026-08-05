# 0xNothing zkLTC Testnet

The LitVM testnet workspace contains 0xPixel, 0xPump, and the 0xFi DeFi suite.

Every 0xPump market has a fixed `6,000 NUSD` READY market-cap target. Reaching
that target stops buys. A holder may still sell from `READY`, which reopens the
curve as `TRADING`. Graduation is permissionless only after the pinned 0xFi
controller owns both Pump and its graduation router, the router is enabled, and
the 0xFi adapter is allowed. The web client checks those live conditions before
offering the action.

```text
apps/web/                         0xNothing Next.js gateway and 0xPixel/0xPump UI
0xFi/                             AMM, farming, lending, synths, indexer, and web UI
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

0xFi is compiled into the main Next.js app under `/0xFi`, exactly like 0xPump
and 0xPixel. Its pages, API handlers, and supporting code live in
`apps/web/app/0xFi` and `apps/web/features/fi`; no proxy or second web service is
required.

For Vercel, deploy one project with Root Directory
`0xNothing-zkLTC-Testnet/apps/web`. The checked public LitVM testnet values are
built in, while matching `NEXT_PUBLIC_*` variables can override them when a
contract deployment changes. `OXFI_PUBLIC_ORIGIN` and `OXFI_INTERNAL_ORIGIN`
are no longer used.

## Existing 0xPixel deployment

- NFT: `0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988`, start block `24867130`
- Marketplace: `0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4`, start block `24867505`

These addresses and their marketplace subgraph remain in place. Deployment scripts must never redeploy them.
