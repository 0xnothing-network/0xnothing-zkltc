# 0xPump integration guide

0xPump is a bonding-curve launchpad priced in NUSD. Anyone can create a token
market; the launchpad holds the token's whole fixed supply and sells it along a
virtual constant-product curve. When the curve has raised enough real NUSD the
market becomes `READY`, buys stop, and anyone can graduate it into a 0xFi pool.

This guide covers the contracts, every user flow (buy, sell, create, graduate,
fee distribution), how to read market data, and a safety checklist. It assumes
the shared setup in [README.md](./README.md): the `liteforge` chain,
`publicClient`, and the `minOut`, `assertChain`, `confirm`, `ensureAllowance`
and `send` helpers from `chain.ts` and `tx.ts`.

Paths below are relative to `0xNothing-zkLTC-Testnet/`. `V2:N` means
`contracts/src/pump/ZeroXPumpV2.sol` line N.

Prompts for AI coding agents are in [prompts/0xpump.md](./prompts/0xpump.md).

## Contracts and addresses

| Contract | Address | Manifest key |
| --- | --- | --- |
| Launchpad `ZeroXPumpV2` | `0x0239baEc3c695A6EA893Ad90a7608112e0580526` | `pump` in `contracts/deployments/v3-core.json` and `apps/web/features/fi/config/testnet.generated.json` |
| NUSD `OracleNUSDv2` (18 decimals, the quote asset) | `0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19` | `nusd` in both files above |
| `PumpGraduationController` (the launchpad's `admin`) | `0x935ec3B5ED5ef330895C87139e0a905B009187a5` | `pumpGraduationController` in `testnet.generated.json` |
| `GraduationRouter` | `0xdf151Ab408d099cB7Edf3B44d284011767C2475A` | `pumpGraduationRouter` in both files |
| 0xFi graduation adapter | `0x6345cAFFFc5e87668508873Dd586662e5fE145a5` | `pumpGraduationAdapter` in `testnet.generated.json` |
| LP locker (receives graduation LP) | `0xe37f01C1f34512d45241c508499552B4A8276B59` | `pumpLiquidityLocker` in `v3-core.json` |
| Fee recipient `FeeSplitter` | `0xAea1Ef82Dbe800BB3683009630813457D990a9B0` | `feeSplitter` in both files |
| 0xFi DEX router (trading after graduation) | `0x1cda4793122a223A09be54ED5f664ba222eEe042` | `dexRouter` in `testnet.generated.json` |

The web app reads the same keys through `apps/web/lib/publicConfig.ts:20-26`
(`PUMP_FACTORY_ADDRESS`, `PUMP_NUSD_ADDRESS`, `PUMP_GRADUATION_ROUTER_ADDRESS`,
`PUMP_GRADUATION_ADAPTER_ADDRESS`, `PUMP_GRADUATION_CONTROLLER_ADDRESS`,
`PUMP_START_BLOCK`, `PUMP_SUBGRAPH_URL`).

**Load addresses from the manifest, do not hard-code them.** The table is a
convenience for reading; your code should take addresses from a copy of
`apps/web/features/fi/config/testnet.generated.json` (or `v3-core.json`) and
check them with `getAddress`. Contracts have no proxies, so a redeploy means new
addresses and a new manifest, not changed behaviour at the old address.

```ts
// pump/addresses.ts
import { getAddress } from "viem";
// A copy of apps/web/features/fi/config/testnet.generated.json
import manifest from "./testnet.generated.json";

export const PUMP = getAddress(manifest.pump);
export const NUSD = getAddress(manifest.nusd);
export const PUMP_CONTROLLER = getAddress(manifest.pumpGraduationController);
export const PUMP_ROUTER = getAddress(manifest.pumpGraduationRouter);
export const PUMP_ADAPTER = getAddress(manifest.pumpGraduationAdapter);
export const PUMP_SUBGRAPH_URL: string = manifest.pumpGoldskyEndpoint;
export const PUMP_START_BLOCK = BigInt(manifest.deploymentBlock); // "61141359"
```

You can confirm the wiring on-chain: `pump.nusd()` and `pump.vault()` return the
NUSD address, `pump.graduationRouter()` returns the router, `pump.admin()`
returns the controller, and `pump.feeRecipient()` returns the FeeSplitter
(`apps/web/features/pump/abis.ts:20-26`).

### Start blocks

Three start blocks exist and they differ: `scriptBlock` `61141328` in
`v3-core.json`, `deploymentBlock` `61141359` in `testnet.generated.json:4`
(the web app's log-scan start), and `startBlock` `61141414` in
`subgraphs/0xpump/subgraph.yaml:13`. Any of them is before the first market. For
a `getLogs` fallback, start at `61141359` as the web app does.

## Parameters, decimals and fees

| Value | Current | Source |
| --- | --- | --- |
| Token supply per market (fixed) | `1_000_000_000e18` | `tokenTotalSupply()`; `contracts/script/DeployV3Core.s.sol:59` |
| Initial virtual NUSD reserve | `1_500e18` | `initialVirtualNusdReserve()`; DeployV3Core.s.sol:60 |
| Graduation market-cap target | `6_000e18` NUSD | `graduationThresholdNusd()`; DeployV3Core.s.sol:61 |
| Real-reserve target (the on-chain gate) | `1_500e18` NUSD | `graduationReserveThresholdNusd()` |
| Creation fee | `1e18` (1 NUSD) | `createFee()`; DeployV3Core.s.sol:62 |
| Trade fee | `10` bps (0.1%) | `tradeFeeBps()`; DeployV3Core.s.sol:63 |
| Basis-point denominator | `10_000` | V2:40 |
| Max trade fee for new markets | `100` bps (1%) | `MAX_TRADE_FEE_BPS`, V2:43 |
| Max creation fee for new markets | `100e18` (100 NUSD) | `MAX_CREATE_FEE_NUSD`, V2:44 |

- Every PumpToken has 18 decimals (`contracts/src/pump/PumpToken.sol:12`). NUSD
  has 18 decimals.
- Prices are WAD: `spotPriceNusdWad(token) = virtualNusdReserve * 1e18 /
  virtualTokenReserve` (V2:639-641), the NUSD price of one whole token scaled
  by `1e18`.
- **Terms are per market.** `tradeFeeBps()`, `createFee()`,
  `graduationThresholdNusd()` and `graduationReserveThresholdNusd()` are the
  terms for the *next* market (V2:483-496). Each market keeps the terms it was
  created with, readable from
  `marketParams(token) returns (uint16 tradeFeeBps, uint120 graduationThresholdNusd, uint120 graduationReserveThresholdNusd)`
  (public mapping, V2:98). `paramAdmin` can change the terms only for markets
  created later, within the caps above (V2:419-429). `marketParams` is not in
  the web ABI; add it to yours.
- The web ABI declares `createFee()` and `tradeFeeBps()` as `pure`
  (`abis.ts:18-19`). They are `view` on the contract (`createFee` is admin-set
  storage, V2:93; `tradeFeeBps()` reads `_nextParams`, V2:484-486). Declare them
  `view` in your ABI. `createFee` is a `uint128` public variable (V2:93), so its
  getter returns `uint128`; the web ABI's `uint256` decodes to the same bigint.

### Fee math

Buy (V2:571-591), with `feeBps = marketParams(token).tradeFeeBps`:

```
remaining      = reserveThreshold - realNusdReserve
maximumGross   = ((remaining * 10_000) - 1) / (10_000 - feeBps)
userNusdAmount = min(maxNusdIn, maximumGross)        // what the contract pulls
feeNusd        = userNusdAmount * feeBps / 10_000
curveNusdAmount = userNusdAmount - feeNusd
tokenOut       = curveNusdAmount * vToken / (vNusd + curveNusdAmount), capped at tokenReserve
```

A buy close to the target is capped: it pulls less than `maxNusdIn`. The
contract transfers exactly `userNusdAmount` (V2:291).

Sell (V2:593-601):

```
curveNusdAmount = tokenIn * vNusd / (vToken + tokenIn), capped at realNusdReserve
feeNusd         = curveNusdAmount * feeBps / 10_000
userNusdAmount  = curveNusdAmount - feeNusd           // what the seller receives
```

Trade fees accrue in `accruedProtocolFeesNusd()` (V2:105, 298, 341). The
creation fee is paid at `reserveMarket`, accrues in the same counter (V2:211)
and is not refundable.

## Market lifecycle

`status(token)` returns a `uint8` (V2:49-54, 469-471). It reverts
`MarketNotFound()` for an unknown token. `markets(token)` does not revert; it
returns `lifecycle = 0` for an unknown token (field index 7).

| `uint8` | Contract name | Subgraph `MarketStatus` | Allowed |
| --- | --- | --- | --- |
| 0 | `NONE` | (no market) | nothing |
| 1 | `TRADING` | `CURVE` | `quoteBuy`/`buy`, `quoteSell`/`sell` |
| 2 | `READY` | `READY` | `quoteSell`/`sell` (a sell reopens the curve), graduation |
| 3 | `GRADUATED` | `GRADUATED` | nothing on the curve; trade on the 0xFi pool `markets(token).pool` |

- `TRADING` to `READY`: inside `buy`, when
  `realNusdReserve + curveNusdAmount >= graduationReserveThresholdNusd`
  (V2:588, 303-308). The gate is the real NUSD reserve (1,500 NUSD with current
  terms). `_setMarketParams` derives that reserve target so the market cap at
  that point is at least the 6,000 NUSD target (V2:536-547). Emits
  `TokenReadyForGraduation`.
- `READY` to `TRADING`: any successful `sell` on a `READY` market (V2:342,
  346-348). Emits `TokenCurveReopened`.
- `READY` to `GRADUATED`: `PumpGraduationController.graduateReady(token)`,
  callable by anyone.
- Progress: `curveProgressBps(token) = min(10_000, realNusdReserve * 10_000 /
  reserveThreshold)`, and `10_000` once graduated (V2:477-481, 632-637).
- Pausing (`paused()`) blocks `reserveMarket`, `createMarket` and `buy`
  (V2:201, 224, 279). `sell` stays open while paused (V2:316-318).

## ABI

These fragments match `apps/web/features/pump/abis.ts` where the web ABI has
them, with three changes: `createFee`/`tradeFeeBps` are `view` (and `createFee`
returns `uint128`, as on the contract), `marketParams`
is added (V2:98), and the fee event is `ProtocolFeesDistributed` (V2:156). The
web ABI's `ProtocolFeesWithdrawn` event (`abis.ts:37`) does not exist on
`ZeroXPumpV2`. The custom errors are from V2:26-38 and `PumpToken.sol:5-10`;
include them so viem can decode reverts.

```ts
// pump/abi.ts
import { parseAbi } from "viem";

export const pumpAbi = parseAbi([
  // reads
  "function markets(address token) view returns (address creator,uint256 tokenReserve,uint256 realNusdReserve,uint256 virtualTokenReserve,uint256 virtualNusdReserve,uint256 totalNusdVolume,uint64 createdAt,uint8 lifecycle,address dex,bytes32 dexPairId,address pool)",
  "function marketParams(address token) view returns (uint16 tradeFeeBps,uint120 graduationThresholdNusd,uint120 graduationReserveThresholdNusd)",
  "function status(address token) view returns (uint8)",
  "function spotPriceNusdWad(address token) view returns (uint256)",
  "function curveProgressBps(address token) view returns (uint256)",
  "function graduationThresholdNusd() view returns (uint256)",
  "function graduationReserveThresholdNusd() view returns (uint256)",
  "function createFee() view returns (uint128)",
  "function tradeFeeBps() view returns (uint256)",
  "function paused() view returns (bool)",
  "function nusd() view returns (address)",
  "function vault() view returns (address)",
  "function admin() view returns (address)",
  "function graduationRouter() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function accruedProtocolFeesNusd() view returns (uint256)",
  "function totalMarkets() view returns (uint256)",
  "function getAllTokens() view returns (address[])",
  "function getTokensByCreator(address creator) view returns (address[])",
  "function creationReservations(address owner,bytes32 contentHash) view returns (bool)",
  "function createdTokenByContentHash(address owner,bytes32 contentHash) view returns (address token)",
  "function quoteBuy(address token,uint256 maxNusdIn) view returns (uint256 tokenOut,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,bool readyAfter)",
  "function quoteSell(address token,uint256 tokenIn) view returns (uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd)",
  // writes
  "function buy(address token,uint256 maxNusdIn,uint256 minTokenOut,uint256 deadline) returns (uint256 tokenOut,uint256 userNusdAmount)",
  "function sell(address token,uint256 tokenIn,uint256 minNusdOut,uint256 deadline) returns (uint256 userNusdAmount)",
  "function reserveMarket(bytes32 contentHash)",
  "function createMarket(string name,string symbol,string metadataURI,string imageURI,bytes32 contentHash) returns (address token)",
  "function distributeFees() returns (uint256 amountNusd)",
  // events
  "event TokenCreated(address indexed token,address indexed creator,bytes32 indexed contentHash,string name,string symbol,string metadataURI,string imageURI,uint256 totalSupply,uint256 curveTokenSupply,uint256 virtualNusdReserve,uint256 virtualTokenReserve,uint256 graduationThresholdNusd,uint256 graduationReserveThresholdNusd,uint256 creationFeeNusd)",
  "event CreationFeePaid(address indexed owner,bytes32 indexed contentHash,uint256 creationFeeNusd)",
  "event TokenTraded(address indexed token,address indexed trader,bool indexed isBuy,uint256 tokenAmount,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,uint256 realNusdReserveAfter,uint256 tokenReserveAfter,uint256 virtualNusdReserveAfter,uint256 virtualTokenReserveAfter,uint256 circulatingSupplyAfter,uint256 spotPriceNusdWad,uint256 curveProgressBps)",
  "event TokenReadyForGraduation(address indexed token,uint256 realNusdReserve,uint256 tokenReserve,uint256 thresholdNusd)",
  "event TokenCurveReopened(address indexed token,uint256 realNusdReserve,uint256 tokenReserve)",
  "event TokenGraduated(address indexed token,address indexed dex,bytes32 indexed pairId,address pool,uint256 nusdLiquidity,uint256 tokenLiquidity,uint256 lpAmount,address lpRecipient)",
  "event ProtocolFeesDistributed(address indexed caller,address indexed recipient,uint256 amountNusd)",
  // errors
  "error InvalidConfiguration()",
  "error InvalidMetadata()",
  "error MarketNotFound()",
  "error MarketNotTrading()",
  "error MarketNotReady()",
  "error DeadlineExpired()",
  "error InvalidAmount()",
  "error SlippageExceeded()",
  "error ContractPaused()",
  "error AssetTransferMismatch()",
  "error InsufficientProtocolFees()",
  "error InvalidCommitment()",
  "error InvalidReservation()",
]);

// PumpToken (abis.ts:40-50 plus PumpToken.sol errors)
export const pumpTokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function metadataURI() view returns (string)",
  "function imageURI() view returns (string)",
  "error ERC20InvalidAddress()",
  "error ERC20InsufficientBalance()",
  "error ERC20InsufficientAllowance()",
]);

// PumpGraduationController (abis.ts:52-60; previewGraduation from
// 0xFi/contracts/src/graduation/PumpGraduationController.sol:170; errors L78-85)
export const pumpControllerAbi = parseAbi([
  "function pump() view returns (address)",
  "function adapter() view returns (address)",
  "function router() view returns (address)",
  "function graduationsPaused() view returns (bool)",
  "function previewGraduation(address token) view returns ((bool ready,address pool,uint256 tokenAmount,uint256 nusdAmount,uint256 expectedLp,uint256 minimumLp))",
  "function graduateReady(address token) returns (address dex,bytes32 pairId,address pool,address lpToken,uint256 lpAmount)",
  "event ReadyMarketGraduated(address indexed caller,address indexed token,address indexed pool,uint256 tokenAmount,uint256 nusdAmount,uint256 lpAmount)",
  "error InvalidGraduationPreview()",
  "error InvalidGraduationResult()",
  "error GraduationsPaused()",
  "error MarketNotReady()",
  "error RouterUnavailable()",
]);

// GraduationRouter (abis.ts:62-66)
export const pumpRouterAbi = parseAbi([
  "function admin() view returns (address)",
  "function enabled() view returns (bool)",
  "function isAdapterAllowed(address adapter) view returns (bool)",
]);

export const STATUS = ["NONE", "TRADING", "READY", "GRADUATED"] as const;
```

Note: the web controller ABI lists `pump()` twice (`abis.ts:53`, `:57`); keep
one copy.

## Flow: read a market

**Purpose.** Show price, progress, reserves, fee and status for one token.

**Preconditions.** None; this is read-only.

**Steps.**

1. Read `markets(token)` first and treat `lifecycle === 0` as "not a 0xPump
   market". `markets` never reverts, but `spotPriceNusdWad` and
   `curveProgressBps` revert `MarketNotFound()` for an unknown token
   (V2:473-481, 672-675), so a multicall with `allowFailure: false` would throw
   before you could check.
2. Then read `marketParams(token)`, `spotPriceNusdWad(token)`,
   `curveProgressBps(token)` and the token's `totalSupply()` in one multicall.
3. Market cap is `price * totalSupply / 1e18`, the same formula the subgraph
   uses (`subgraphs/0xpump/src/mapping.ts:98-100`). Read `totalSupply` from the
   token: graduation burns unsold tokens, so it shrinks (V2:367-368).

```ts
// pump/read.ts
import type { Address } from "viem";
import { publicClient } from "../chain";
import { PUMP } from "./addresses";
import { pumpAbi, pumpTokenAbi, STATUS } from "./abi";

export async function readMarket(token: Address) {
  const m = await publicClient.readContract({
    address: PUMP, abi: pumpAbi, functionName: "markets", args: [token],
  });
  const [creator, tokenReserve, realNusdReserve, , , totalNusdVolume, createdAt, lifecycle, dex, dexPairId, pool] = m;
  if (lifecycle === 0) throw new Error("Not a 0xPump market");

  const [params, priceNusdWad, progressBps, totalSupply] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: PUMP, abi: pumpAbi, functionName: "marketParams", args: [token] },
      { address: PUMP, abi: pumpAbi, functionName: "spotPriceNusdWad", args: [token] },
      { address: PUMP, abi: pumpAbi, functionName: "curveProgressBps", args: [token] },
      { address: token, abi: pumpTokenAbi, functionName: "totalSupply" },
    ],
  });
  const [tradeFeeBps, marketCapTargetNusd, reserveTargetNusd] = params;
  return {
    creator,
    status: STATUS[lifecycle],
    lifecycle,
    tokenReserve,
    realNusdReserve,
    totalNusdVolume,
    createdAt,
    tradeFeeBps,
    marketCapTargetNusd,
    reserveTargetNusd,
    priceNusdWad,
    progressBps,
    marketCapNusd: (priceNusdWad * totalSupply) / 10n ** 18n,
    dex,
    dexPairId,
    pool,
  };
}
```

`multicall` needs `contracts.multicall3` on the chain object, which the shared
`liteforge` chain sets (`0xca11bde05977b3631167028862be2a173976ca11`,
`apps/web/lib/publicConfig.ts:10`).

## Flow: quote

```
quoteBuy(token, maxNusdIn)  -> (tokenOut, curveNusdAmount, userNusdAmount, feeNusd, readyAfter)   // V2:448-454
quoteSell(token, tokenIn)   -> (curveNusdAmount, userNusdAmount, feeNusd)                         // V2:456-462
```

- `quoteBuy` reverts `MarketNotTrading()` unless the market is `TRADING`.
- `quoteSell` reverts `MarketNotTrading()` unless it is `TRADING` or `READY`.
- Both revert `MarketNotFound()` for an unknown token.
- A zero amount returns all zeros; the matching `buy`/`sell` would revert
  `InvalidAmount()`.
- For a buy, show `tokenOut` as the output, `userNusdAmount` as the NUSD that
  will actually be spent (it can be less than `maxNusdIn` near the target), and
  `feeNusd` as the fee. `readyAfter = true` means this buy completes the curve.
- For a sell, show `userNusdAmount` as the output and `feeNusd` as the fee
  (`apps/web/features/pump/components/TradePanel.tsx:127-129`).

## Flow: buy (NUSD to token)

**Purpose.** Spend NUSD on the curve for tokens.

**Preconditions.** Wallet on chain 4441; market `TRADING`; launchpad not
paused; enough NUSD; NUSD allowance to the launchpad of at least the quoted
`userNusdAmount`. No zkLTC value is sent.

**Steps.**

1. Check the chain id.
2. Read `markets(token)` and require `lifecycle === 1`; read `paused()`.
3. Read `quoteBuy(token, maxNusdIn)`. Reject `tokenOut === 0n`.
4. Compute `minTokenOut = minOut(tokenOut, slippageBps)`.
5. Check the NUSD balance covers `userNusdAmount`.
6. If the NUSD allowance to `PUMP` is below `userNusdAmount`, approve that
   amount and wait for the receipt.
7. `deadline = now + 20 minutes` (the web app uses 20 minutes,
   `TradePanel.tsx:216`).
8. Simulate `buy(token, userNusdAmount, minTokenOut, deadline)`, send, and
   require a successful receipt.

Passing the quoted `userNusdAmount` as `maxNusdIn` keeps the approval and the
pull equal. The web app passes the typed amount and approves `maxUint256`
(`TradePanel.tsx:207-212`); approving the exact amount is safer.

```ts
// pump/buy.ts
import { erc20Abi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, minOut, send } from "../tx";
import { NUSD, PUMP } from "./addresses";
import { pumpAbi } from "./abi";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export async function buyOnCurve(
  walletClient: WalletClient,
  account: Address,
  token: Address,
  maxNusdIn: bigint,          // parseUnits(input, 18)
  slippageBps = 100n,         // 1%; the web app offers 50 / 100 / 200
) {
  await assertChain(walletClient);
  if (maxNusdIn <= 0n) throw new Error("Enter an amount");

  const [market, paused] = await Promise.all([
    publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "markets", args: [token] }),
    publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "paused" }),
  ]);
  if (paused) throw new Error("0xPump is paused; buys are disabled");
  if (market[7] !== 1) throw new Error("Buys are open only while the market is TRADING");

  const [tokenOut, , userNusdAmount, feeNusd, readyAfter] = await publicClient.readContract({
    address: PUMP, abi: pumpAbi, functionName: "quoteBuy", args: [token, maxNusdIn],
  });
  if (tokenOut === 0n || userNusdAmount === 0n) throw new Error("Amount too small");
  const minTokenOut = minOut(tokenOut, slippageBps);

  const balance = await publicClient.readContract({
    address: NUSD, abi: erc20Abi, functionName: "balanceOf", args: [account],
  });
  if (balance < userNusdAmount) throw new Error("Not enough NUSD");

  await ensureAllowance(walletClient, account, NUSD, PUMP, userNusdAmount);

  const deadline = nowSec() + 20n * 60n;
  const { hash, result, receipt } = await send(walletClient, {
    account, address: PUMP, abi: pumpAbi, functionName: "buy",
    args: [token, userNusdAmount, minTokenOut, deadline],
  });
  return { hash, receipt, simulated: result, feeNusd, readyAfter };
}
```

**Errors to handle.**

| Error | Meaning | What to do |
| --- | --- | --- |
| `ContractPaused` | Launchpad paused (V2:279) | Disable buy |
| `DeadlineExpired` | `block.timestamp > deadline` (V2:280) | Re-quote and resend |
| `MarketNotFound` / `MarketNotTrading` | Unknown token, or `READY`/`GRADUATED` (V2:281) | Refresh status; offer sell or graduate |
| `InvalidAmount` | Zero output (V2:288) | Ask for a larger amount |
| `SlippageExceeded` | `tokenOut < minTokenOut` (V2:289) | Re-quote; show the new price |
| `AssetTransferMismatch` | NUSD moved a different amount (V2:646) | Stop and report |
| NUSD transfer revert | Balance or allowance too low | Re-read balance and allowance |

Events: `TokenTraded` with `isBuy = true`, and `TokenReadyForGraduation` when
the buy completes the curve.

## Flow: sell (token to NUSD)

**Purpose.** Sell tokens back to the curve for NUSD.

**Preconditions.** Wallet on chain 4441; market `TRADING` or `READY` (selling
works while paused); token balance at least `tokenIn`; token allowance to the
launchpad at least `tokenIn`. No zkLTC value.

**Steps.**

1. Check the chain id.
2. Read `markets(token)` and require `lifecycle` 1 or 2.
3. Read `quoteSell(token, tokenIn)`; reject `userNusdAmount === 0n`.
4. `minNusdOut = minOut(userNusdAmount, slippageBps)`.
5. Check the token balance; approve `tokenIn` to `PUMP` if needed and wait.
6. Simulate `sell(token, tokenIn, minNusdOut, deadline)`, send, check the
   receipt.

```ts
// pump/sell.ts
import type { Address, WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, minOut, send } from "../tx";
import { PUMP } from "./addresses";
import { pumpAbi, pumpTokenAbi } from "./abi";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export async function sellOnCurve(
  walletClient: WalletClient,
  account: Address,
  token: Address,
  tokenIn: bigint,            // parseUnits(input, 18)
  slippageBps = 100n,
) {
  await assertChain(walletClient);
  if (tokenIn <= 0n) throw new Error("Enter an amount");

  const market = await publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "markets", args: [token] });
  if (market[7] !== 1 && market[7] !== 2) throw new Error("The curve is closed for this market");

  const [, userNusdAmount, feeNusd] = await publicClient.readContract({
    address: PUMP, abi: pumpAbi, functionName: "quoteSell", args: [token, tokenIn],
  });
  if (userNusdAmount === 0n) throw new Error("Amount too small");
  const minNusdOut = minOut(userNusdAmount, slippageBps);

  const balance = await publicClient.readContract({
    address: token, abi: pumpTokenAbi, functionName: "balanceOf", args: [account],
  });
  if (balance < tokenIn) throw new Error("Not enough tokens");

  await ensureAllowance(walletClient, account, token, PUMP, tokenIn);

  const { hash, receipt } = await send(walletClient, {
    account, address: PUMP, abi: pumpAbi, functionName: "sell",
    args: [token, tokenIn, minNusdOut, nowSec() + 20n * 60n],
  });
  return { hash, receipt, quotedNusdOut: userNusdAmount, feeNusd, reopensCurve: market[7] === 2 };
}
```

**Errors to handle.** `DeadlineExpired` (V2:318), `MarketNotFound` /
`MarketNotTrading` (V2:319, market graduated), `InvalidAmount` (V2:326),
`SlippageExceeded` (V2:327), `AssetTransferMismatch` (V2:331-333), and the
PumpToken errors `ERC20InsufficientAllowance` / `ERC20InsufficientBalance`
(`PumpToken.sol:69, 93`).

Events: `TokenTraded` with `isBuy = false`, and `TokenCurveReopened` when the
market was `READY`.

## Flow: create a token (two transactions)

**Purpose.** Launch a new market. The creator pays the creation fee in a
reservation transaction, uploads metadata, then creates the market.

**Preconditions.** Wallet on chain 4441; launchpad not paused; NUSD balance and
allowance to the launchpad of at least `createFee()`; metadata and image
already pinned on IPFS.

What the contract checks:

- `reserveMarket(contentHash)` (V2:200-215): `contentHash != 0`
  (`InvalidCommitment`), and the caller has no unused reservation and no
  created token for that hash (`InvalidReservation`). It pulls exactly
  `createFee()` NUSD and emits `CreationFeePaid`.
- `createMarket(name, symbol, metadataURI, imageURI, contentHash)`
  (V2:217-272): `name` 1-64 bytes, `symbol` 1-16 bytes, `metadataURI` and
  `imageURI` each 8-200 bytes and starting with the literal `ipfs://`
  (case-sensitive), else `InvalidMetadata` (V2:651-670). The caller must hold an
  unused reservation for the same hash (`InvalidReservation`). No fee is
  charged here. It emits `TokenCreated`. The creator receives no tokens; the
  launchpad holds the full supply.
- Reservations are per caller address. Use the same account for both steps.

**The content hash.** The contract only requires a non-zero `bytes32`; it does
not check the preimage or fetch IPFS. The web app commits to the content with
`apps/web/features/pump/contentHash.ts:52-72`:

```
keccak256(abi.encode(
  "0xPump Market Content", uint256 1, uint256 chainId, address factory, address owner,
  name.trim(), symbol.trim().toUpperCase(), description.trim(), website.trim(), twitter.trim(),
  mimeType.trim().toLowerCase(), uint256 fileByteLength, bytes32 keccak256(fileBytes)))
```

with line endings normalised to `\n` first (L48-50). Using the same scheme makes
the hash deterministic, so you can recover after a lost receipt.

**Steps.**

1. Check the chain id; trim the name, upper-case the symbol, validate lengths
   and `ipfs://` prefixes locally.
2. Compute the content hash.
3. If `createdTokenByContentHash(account, hash)` is non-zero, the market already
   exists: return it.
4. If `creationReservations(account, hash)` is false: read `createFee()`,
   check balance, approve that amount to `PUMP` and wait, then simulate, send
   and confirm `reserveMarket(hash)`.
5. Simulate, send and confirm `createMarket(...)`.
6. Decode `TokenCreated` from the receipt logs emitted by `PUMP` to get the
   token address.

The web app follows these steps, checking the two recovery views before the
fee, before the upload and before create (`CreateTokenForm.tsx:158-163,
196-199, 234-246, 268-290`).

```ts
// pump/create.ts
import { decodeEventLog, erc20Abi, isAddressEqual, zeroAddress, type Address, type Hex, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, send } from "../tx";
import { NUSD, PUMP } from "./addresses";
import { pumpAbi } from "./abi";

const bytes = (s: string) => new TextEncoder().encode(s).length;

export async function createToken(
  walletClient: WalletClient,
  account: Address,
  input: { name: string; symbol: string; metadataURI: string; imageURI: string; contentHash: Hex },
) {
  await assertChain(walletClient);
  const name = input.name.trim();
  const symbol = input.symbol.trim().toUpperCase();
  if (bytes(name) < 1 || bytes(name) > 64) throw new Error("Name must be 1-64 bytes");
  if (bytes(symbol) < 1 || bytes(symbol) > 16) throw new Error("Symbol must be 1-16 bytes");
  for (const uri of [input.metadataURI, input.imageURI]) {
    if (!uri.startsWith("ipfs://") || bytes(uri) < 8 || bytes(uri) > 200) throw new Error("URIs must be ipfs:// and 8-200 bytes");
  }
  if (/^0x0{64}$/i.test(input.contentHash)) throw new Error("Content hash must be non-zero");

  // Recovery: already created?
  const existing = await publicClient.readContract({
    address: PUMP, abi: pumpAbi, functionName: "createdTokenByContentHash", args: [account, input.contentHash],
  });
  if (!isAddressEqual(existing, zeroAddress)) return { token: existing, recovered: true };

  // Step 1: pay the creation fee once.
  const reserved = await publicClient.readContract({
    address: PUMP, abi: pumpAbi, functionName: "creationReservations", args: [account, input.contentHash],
  });
  if (!reserved) {
    const [paused, fee, balance] = await Promise.all([
      publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "paused" }),
      publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "createFee" }),
      publicClient.readContract({ address: NUSD, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    ]);
    if (paused) throw new Error("0xPump is paused; creation is disabled");
    if (balance < fee) throw new Error("Not enough NUSD for the creation fee");
    await ensureAllowance(walletClient, account, NUSD, PUMP, fee);
    await send(walletClient, {
      account, address: PUMP, abi: pumpAbi, functionName: "reserveMarket", args: [input.contentHash],
    });
  }

  // Step 2: create the market (no fee here).
  const { receipt } = await send(walletClient, {
    account, address: PUMP, abi: pumpAbi, functionName: "createMarket",
    args: [name, symbol, input.metadataURI, input.imageURI, input.contentHash],
  });
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, PUMP)) continue;
    try {
      const event = decodeEventLog({ abi: pumpAbi, data: log.data, topics: log.topics });
      if (event.eventName === "TokenCreated") return { token: event.args.token, recovered: false };
    } catch {
      // not a launchpad event we know
    }
  }
  throw new Error("TokenCreated not found in the receipt");
}
```

**Errors to handle.** `ContractPaused`, `InvalidCommitment` (zero hash),
`InvalidReservation` (no reservation, already reserved, or already created:
call the two recovery views), `InvalidMetadata` (length or `ipfs://` rules),
NUSD transfer reverts on low balance/allowance. If the reservation succeeded but
create failed, do not reserve again: the fee is already paid and
`creationReservations` stays `true` until `createMarket` uses it.

The web app shows a logo only for an `imageURI` that starts with `ipfs://` and
holds a valid CIDv0 or base32 CIDv1 (`apps/web/features/pump/config.ts`,
`normalizePumpIpfsPath`). Follow the same rule when rendering.

## Flow: graduate a READY market

**Purpose.** Move a `READY` market's liquidity into a new 0xFi pool.

**Preconditions.** Wallet on chain 4441; `markets(token).lifecycle === 2`;
`controller.graduationsPaused() === false`; `router.enabled() === true`;
`router.isAdapterAllowed(adapter) === true`. Anyone can call it. No approvals
and no value. The caller cannot choose the adapter, pool, price or LP
recipient.

`ZeroXPumpV2.graduate(...)` itself is `onlyAdmin` (V2:351-354); the admin is the
controller, so integrators call `PumpGraduationController.graduateReady(token)`
(`0xFi/contracts/src/graduation/PumpGraduationController.sol:193-214`).

What happens (V2:351-397): unsold tokens beyond
`tokenLiquidity = realNusdReserve * 1e18 / spotPrice` are burned; an empty 0xFi
pair is seeded with all real NUSD plus `tokenLiquidity`; the LP goes to
`router.lpRecipient()` (the LP locker). The market becomes `GRADUATED` and
`markets(token).dex`, `dexPairId` and `pool` are set. Events: `TokenGraduated`
(launchpad) and `ReadyMarketGraduated` (controller).

**Steps.**

1. Check the chain id; require `READY`.
2. Read the gating values. The web app also checks that the wiring matches the
   manifest (`TokenDetail.tsx:130-138`): `controller.pump() == PUMP`,
   `pump.graduationRouter() == router`, `controller.router() == router`,
   `controller.adapter() == adapter`, `router.admin() == controller`.
3. Optionally read `previewGraduation(token)` to show the pool and expected LP.
4. Simulate, send and confirm `graduateReady(token)`.
5. Link to the 0xFi pool at `markets(token).pool`.

```ts
// pump/graduate.ts
import { isAddressEqual, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, send } from "../tx";
import { PUMP, PUMP_ADAPTER, PUMP_CONTROLLER, PUMP_ROUTER } from "./addresses";
import { pumpAbi, pumpControllerAbi, pumpRouterAbi } from "./abi";

export async function graduate(walletClient: WalletClient, account: Address, token: Address) {
  await assertChain(walletClient);
  const [market, ctrlPump, ctrlRouter, ctrlAdapter, paused, pumpRouter, routerAdmin, enabled, adapterAllowed] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: PUMP, abi: pumpAbi, functionName: "markets", args: [token] },
        { address: PUMP_CONTROLLER, abi: pumpControllerAbi, functionName: "pump" },
        { address: PUMP_CONTROLLER, abi: pumpControllerAbi, functionName: "router" },
        { address: PUMP_CONTROLLER, abi: pumpControllerAbi, functionName: "adapter" },
        { address: PUMP_CONTROLLER, abi: pumpControllerAbi, functionName: "graduationsPaused" },
        { address: PUMP, abi: pumpAbi, functionName: "graduationRouter" },
        { address: PUMP_ROUTER, abi: pumpRouterAbi, functionName: "admin" },
        { address: PUMP_ROUTER, abi: pumpRouterAbi, functionName: "enabled" },
        { address: PUMP_ROUTER, abi: pumpRouterAbi, functionName: "isAdapterAllowed", args: [PUMP_ADAPTER] },
      ],
    });
  if (market[7] !== 2) throw new Error("Market is not READY");
  const wired =
    isAddressEqual(ctrlPump, PUMP) && isAddressEqual(ctrlRouter, PUMP_ROUTER) &&
    isAddressEqual(ctrlAdapter, PUMP_ADAPTER) && isAddressEqual(pumpRouter, PUMP_ROUTER) &&
    isAddressEqual(routerAdmin, PUMP_CONTROLLER);
  if (!wired) throw new Error("Graduation wiring does not match the manifest");
  if (paused || !enabled || !adapterAllowed) throw new Error("Graduation is unavailable right now");

  const preview = await publicClient.readContract({
    address: PUMP_CONTROLLER, abi: pumpControllerAbi, functionName: "previewGraduation", args: [token],
  });
  if (!preview.ready) throw new Error("Market is not READY");

  const { hash, result, receipt } = await send(walletClient, {
    account, address: PUMP_CONTROLLER, abi: pumpControllerAbi, functionName: "graduateReady", args: [token],
  });
  const [, , pool, , lpAmount] = result as readonly [Address, `0x${string}`, Address, Address, bigint];
  return { hash, receipt, pool, lpAmount, expectedLp: preview.expectedLp };
}
```

**Errors to handle.** `GraduationsPaused`, `RouterUnavailable` (router disabled
or adapter not allowed), `MarketNotReady` (someone sold and reopened the curve,
or someone else graduated first), `InvalidGraduationPreview`,
`InvalidGraduationResult` (controller L177-211), and launchpad-side
`MarketNotReady` (V2:359). The launchpad's `DeadlineExpired` (V2:357) cannot
fire on this path: the controller passes `block.timestamp` as the deadline
(controller L208). After a revert, re-read the status before retrying.

After graduation, trade the token through the 0xFi DEX router (`dexRouter`);
see [0xfi.md](./0xfi.md).

## Flow: distribute protocol fees

**Purpose.** Send accrued trade and creation fees to the FeeSplitter. Anyone
can call it.

`distributeFees()` sends all of `accruedProtocolFeesNusd()` to `feeRecipient`
and calls `distribute()` on it. It reverts `InsufficientProtocolFees` when
nothing has accrued, and emits
`ProtocolFeesDistributed(address indexed caller, address indexed recipient, uint256 amountNusd)`
(V2:156, 402-409). There is no admin fee withdrawal on `ZeroXPumpV2`.

```ts
import type { Address, WalletClient } from "viem";
import { publicClient } from "../chain";
import { send } from "../tx";
import { PUMP } from "./addresses";
import { pumpAbi } from "./abi";

export async function distributeFees(walletClient: WalletClient, account: Address) {
  const accrued = await publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "accruedProtocolFeesNusd" });
  if (accrued === 0n) throw new Error("No fees to distribute");
  return send(walletClient, { account, address: PUMP, abi: pumpAbi, functionName: "distributeFees", args: [] });
}
```

## Reading data: RPC or subgraph

Use RPC for anything that sizes or gates a transaction: status, quotes,
reserves, balances, allowances, reservations. Use the subgraph for lists,
trade history, candles, holders and totals. The subgraph lags the chain; check
`_meta.block.number`.

`getAllTokens()` returns the whole token array in one call. For long lists,
paging and sorting, use the subgraph.

### Subgraph

Endpoint (`apps/web/features/fi/config/testnet.generated.json:41`, key
`pumpGoldskyEndpoint`):

```
https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxpump-testnet/1.0.0/gn
```

Schema: `subgraphs/0xpump/schema.graphql`. Main entities:

- `enum MarketStatus { CURVE READY GRADUATED }` (L1-5). `CURVE` is the
  contract's `TRADING`. `enum TradeSide { BUY SELL }`.
- `Protocol` (id `"global"`): `tokenCount`, `activeTokenCount`,
  `readyTokenCount`, `graduatedTokenCount`, `tradeCount`, `totalVolumeNusd`,
  `totalTradeFeesNusd`, `totalCreationFeesNusd`, `totalFeesNusd`,
  `totalFeesWithdrawnNusd`.
- `Market` (id = token address): `name`, `symbol`, `metadataURI`, `imageURI`,
  `status`, `holderCount`, `totalSupply`, `reserveNusd`, `reserveToken`,
  `virtualNusd`, `virtualToken`, `priceNusdWad`, `priceNusd` (BigDecimal),
  `marketCapNusd`, `graduationThresholdNusd`, `graduationReserveThresholdNusd`,
  `progressBps`, `volumeNusd`, `feesNusd`, `createdAt`, `lastTradeAt`,
  `graduation`, and the `trades`, `candles`, `holders` relations.
- `Trade`: `side`, `trader`, `tokenAmount`, `curveNusdAmount`,
  `userNusdAmount`, `feeNusd`, `priceNusd`, `timestamp`, `txHash`. `nusdAmount`
  equals `curveNusdAmount` (the volume).
- `Candle` (id `<market>-<period>-<bucket>`): `period` in minutes (`1`, `15`,
  `60`, `240`, `1440`), `bucket` = start time in seconds, `open`, `high`,
  `low`, `close` (BigDecimal NUSD), `volumeNusd`.
- `TokenBalance`: per holder. The launchpad's own row is the curve inventory
  (`isFactory = true`) and is excluded from `holderCount`.
- `Graduation`, `GraduationReadiness`, `CurveReopening`,
  `CreationFeePayment`, `FeeWithdrawal` (records `ProtocolFeesDistributed`).

Example (POST JSON `{ query, variables }`):

```graphql
query Pump($token: Bytes!, $since: BigInt!) {
  protocol(id: "global") { tokenCount activeTokenCount readyTokenCount graduatedTokenCount tradeCount totalVolumeNusd totalFeesNusd }
  markets(first: 20, orderBy: createdAt, orderDirection: desc, where: { status: CURVE }) {
    id name symbol imageURI status priceNusd marketCapNusd progressBps reserveNusd graduationReserveThresholdNusd holderCount volumeNusd
  }
  trades(first: 50, orderBy: timestamp, orderDirection: desc, where: { market: $token }) {
    side trader tokenAmount userNusdAmount feeNusd priceNusd timestamp txHash
  }
  candles(first: 500, orderBy: bucket, orderDirection: asc, where: { market: $token, period: 60, bucket_gte: $since }) {
    bucket open high low close volumeNusd
  }
  _meta { block { number } }
}
```

```ts
import { PUMP_SUBGRAPH_URL } from "./addresses";

export async function querySubgraph<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(PUMP_SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}
// variables: { token: tokenAddress.toLowerCase(), since: String(startSeconds) }
```

BigInt fields arrive as decimal strings; convert them with `BigInt(value)`, not
`Number`.

### Events over RPC

If the subgraph is down, scan launchpad logs from block `61141359` in bounded
windows with `getLogs` and the event fragments above (`TokenCreated`,
`TokenTraded`, `TokenReadyForGraduation`, `TokenCurveReopened`,
`TokenGraduated`). After any event, read state again over RPC instead of using
the event payload as the new state.

## Safety checklist

- [ ] Addresses come from the manifest (`pump`, `nusd`,
      `pumpGraduationController`, `pumpGraduationRouter`,
      `pumpGraduationAdapter`), passed through `getAddress`.
- [ ] Every write checks the wallet chain id is `4441`.
- [ ] Status is read over RPC right before acting: buy only in `TRADING` (1),
      sell in `TRADING` or `READY` (1 or 2), graduate only in `READY` (2).
- [ ] Fee and target are read per market from `marketParams(token)`, not from
      `tradeFeeBps()` or a constant.
- [ ] Amounts are `bigint` with 18 decimals (`parseUnits` / `formatUnits`); no
      `Number` or floats.
- [ ] Every buy and sell uses a fresh `quoteBuy`/`quoteSell`, a non-zero
      minimum from integer bps slippage, and a deadline (20 minutes in the web
      app).
- [ ] Buys pass the quoted `userNusdAmount`, which can be less than the typed
      amount near the target; the UI shows the actual spend.
- [ ] NUSD is approved to the launchpad before `buy` and `reserveMarket`; the
      token is approved to the launchpad before `sell`; the code waits for the
      approval receipt.
- [ ] `simulateContract` runs with the real account before every
      `writeContract`, and decoded revert names are shown to the user.
- [ ] Every receipt is checked for `status === "success"`.
- [ ] Creation checks `createdTokenByContentHash` and `creationReservations`
      before paying, so a lost receipt never pays the fee twice.
- [ ] Metadata URIs start with `ipfs://` and respect the byte limits.
- [ ] The subgraph is used only for display, never to size a transaction.
- [ ] The web app's `/api/*` routes are not called.
- [ ] No private key or API key is in the code or in URLs.
