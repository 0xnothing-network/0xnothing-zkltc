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

The 0xFi web app uses the `/0xFi` base path and runs as a separate Next.js
service. The main web app proxies `/0xFi` page, API, and asset requests to
`OXFI_INTERNAL_ORIGIN` (default `http://127.0.0.1:3301`). For local development,
run the main app on port `3300` and the 0xFi workspace web app on port `3301`.

For Vercel, deploy two projects from the same repository:

1. Set the 0xFi project's Root Directory to `0xNothing-zkLTC-Testnet/0xFi`.
   Its `vercel.json` builds the `web` workspace and serves it under `/0xFi`.
2. Set the gateway project's Root Directory to `0xNothing-zkLTC-Testnet/apps/web`.
3. In the gateway project, set `OXFI_PUBLIC_ORIGIN` to the public HTTPS origin
   of the first project, for example `https://zeroxfi-testnet.vercel.app`, then
   redeploy the gateway. Do not use `localhost`, `127.0.0.1`, a private DNS
   record, or the gateway's own domain; those destinations are blocked or loop.

The gateway build fails explicitly when a Vercel deployment has no public 0xFi
origin, preventing a deployment that later returns `DNS_HOSTNAME_RESOLVED_PRIVATE`.

## Existing 0xPixel deployment

- NFT: `0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988`, start block `24867130`
- Marketplace: `0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4`, start block `24867505`

These addresses and their marketplace subgraph remain in place. Deployment scripts must never redeploy them.
