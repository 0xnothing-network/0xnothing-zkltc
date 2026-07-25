# 0xPump Subgraph - Liteforge Testnet

Goldsky/Graph Node package for the 0xPump bonding-curve launchpad. It indexes
market discovery, trades, OHLC candles, fees, readiness, and the graduation
event schema. Testnet liquidity migration is disabled, so deployed testnet
markets can reach `READY` but are not expected to emit `TokenGraduated`.
The mapping treats the contract's post-trade event fields as authoritative and
does not perform `eth_call` or IPFS reads while indexing.

## Contract event contract

The ABI and manifest intentionally require these exact event signatures:

```solidity
event CreationFeePaid(
  address indexed owner,
  bytes32 indexed contentHash,
  uint256 creationFeeNusd
);

event TokenCreated(
  address indexed token,
  address indexed creator,
  bytes32 indexed contentHash,
  string name,
  string symbol,
  string metadataURI,
  string imageURI,
  uint256 totalSupply,
  uint256 curveTokenSupply,
  uint256 virtualNusdReserve,
  uint256 virtualTokenReserve,
  uint256 graduationThresholdNusd,
  uint256 graduationReserveThresholdNusd,
  uint256 creationFeeNusd
);

event TokenTraded(
  address indexed token,
  address indexed trader,
  bool indexed isBuy,
  uint256 tokenAmount,
  uint256 curveNusdAmount,
  uint256 userNusdAmount,
  uint256 feeNusd,
  uint256 realNusdReserveAfter,
  uint256 tokenReserveAfter,
  uint256 virtualNusdReserveAfter,
  uint256 virtualTokenReserveAfter,
  uint256 circulatingSupplyAfter,
  uint256 spotPriceNusdWad,
  uint256 curveProgressBps
);

event TokenReadyForGraduation(
  address indexed token,
  uint256 realNusdReserve,
  uint256 tokenReserve,
  uint256 thresholdNusd
);

event TokenCurveReopened(
  address indexed token,
  uint256 realNusdReserve,
  uint256 tokenReserve
);

event TokenGraduated(
  address indexed token,
  address indexed dex,
  bytes32 indexed pairId,
  address pool,
  uint256 nusdLiquidity,
  uint256 tokenLiquidity,
  uint256 lpAmount,
  address lpRecipient
);

event ProtocolFeesWithdrawn(address indexed recipient, uint256 amountNusd);
```

For trade accounting, `curveNusdAmount` is the volume. A buy has
`userNusdAmount = curveNusdAmount + feeNusd`; a sell has
`userNusdAmount = curveNusdAmount - feeNusd`. Prices use 18-decimal NUSD WAD.
`graduationThresholdNusd` is the `6,000 NUSD` market-cap target, not a real-NUSD
reserve target. Market cap is `spotPriceNusdWad * fixedTotalSupply / 1e18`.
`graduationReserveThresholdNusd` is the separately derived real-reserve target
(`1,500 NUSD` with the release parameters), and `curveProgressBps` measures
funding against that derived target.
Creation fees are counted from `CreationFeePaid`, not `TokenCreated`, so an
abandoned but paid upload reservation remains visible without being counted
again when a market is created.
`TokenCreated.contentHash` links the consumed reservation to its market and
supports receipt-loss recovery without paying or creating twice.
Each created token also starts a dynamic `PumpToken` data source. Because the
initial mint is emitted before `TokenCreated`, the mapping seeds the factory
balance from `curveTokenSupply`; later `Transfer` events track buys, sells,
wallet-to-wallet transfers, and burns. `holderCount` includes only positive
non-factory balances, while the factory `TokenBalance` remains queryable as the
bonding-curve inventory.

## Configure

The committed config is bound to the verified testnet deployment. Use `.env`
only when intentionally rendering a different deployment:

```dotenv
PUMP_CONTRACT_ADDRESS=0x...
PUMP_START_BLOCK=12345678
GOLDSKY_NETWORK=liteforge
```

`npm run configure` renders `subgraph.yaml` from `subgraph.template.yaml`.
`npm run deploy:check` validates the configured address, start block, and
approved Goldsky network before deployment.

## Develop and verify

```powershell
npm ci
npm run check
npm test
```

`npm run check` includes a direct AssemblyScript compile of the Matchstick test
source. Matchstick execution itself may require WSL, Docker, or Linux when its
native runner is unavailable on Windows.

## Frontend query contract

The stable frontend entities are `markets`, `tokenBalances`, `trades`, and
`candles`. Relations are Graph entities, so holder/trade/candle queries use
`market { id }`.

```graphql
query Markets($first: Int!, $skip: Int!) {
  markets(first: $first, skip: $skip, orderBy: createdAt, orderDirection: desc) {
    id
    token
    creator
    name
    symbol
    metadataURI
    imageURI
    status
    reserveNusd
    reserveToken
    virtualNusd
    virtualToken
    priceNusd
    marketCapNusd
    graduationThresholdNusd
    graduationReserveThresholdNusd
    progressBps
    createdAt
    tradeCount
    volumeNusd
    lastTradeAt
  }
}
```

Candles are maintained for periods `15`, `60`, `240`, and `1440` minutes. IPFS
URIs are stored as emitted; the frontend or API chooses a gateway at read time.

## Deploy last

Do not deploy until the contract address, creation block, ABI, mapping tests,
and frontend queries are all verified:

```powershell
npm run deploy:check
npm run deploy
```

The deployment script targets `zeroxpump-testnet/0.1.3` with the stable
`staging` tag. Each redeploy must use a new immutable version.
