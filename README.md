# 0xNothing zkLTC

This repository now contains two explicit environment roots:

- `0xNothing-zkLTC-Testnet`: the active LitVM testnet application. It preserves the existing 0xPixel deployment and adds 0xPump, DIA-priced direct NUSD mint/redeem backed by the contract's native zkLTC reserve, a Pump subgraph, and IPFS metadata upload. Pump markets become `READY` at a `6,000 NUSD` market cap; liquidity migration remains disabled on testnet.
- `0xNothing-zkLTC-Mainnet`: the future release overlay. It contains mainnet contracts, indexing configuration, deployment gates, and the graduation plan without pretending that a mainnet RPC, official zkLTC stablecoin, conversion/bridge route, Goldsky network, or major-DEX adapter already exists.

The previous DEX, Factory, Social, and Prediction products have been removed. 0xPixel is not redeployed.

## Common commands

```powershell
npm run dev
npm run test:contracts
npm run build:pixel-subgraph
npm run check:pump-subgraphs
npm run typecheck:web
npm run lint:web
npm run build:web
npm run verify
```

Read the testnet [architecture](0xNothing-zkLTC-Testnet/docs/ARCHITECTURE.md), [security notes](0xNothing-zkLTC-Testnet/docs/SECURITY.md), and [deployment runbook](0xNothing-zkLTC-Testnet/docs/DEPLOYMENT.md) before changing addresses or deploying.
