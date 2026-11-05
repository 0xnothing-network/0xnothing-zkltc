# 0xFi integration guide

0xFi is the DeFi suite of 0xNothing on the LitVM LiteForge testnet. It has:

- a constant-product DEX (`ZeroXFiFactoryV2`, `ZeroXFiRouterV2`) where every
  pool contains NUSD or WzkLTC;
- LP farms (`GaugeFactory`, `LiquidityGauge`) that pay NUSD rewards;
- a pooled NUSD lending market with cross-asset collateral
  (`PooledNUSDLendingPoolV2`);
- oracle-priced synthetic nBTC and nETH minted against NUSD (`SyntheticVault`);
- an RWA market contract (`RwaMarket`) that is **not deployed** yet.

This guide covers the contracts, one section per user flow, how to read data,
and a safety checklist. It assumes the shared setup in [README.md](./README.md):
the `liteforge` chain, `publicClient`, and the `minOut`, `assertChain`,
`confirm`, `ensureAllowance` and `send` helpers from `chain.ts` and `tx.ts`.

Paths below are relative to `0xNothing-zkLTC-Testnet/`. Contract line numbers
refer to `0xFi/contracts/src/...` unless a path is given. Exact zkLTC to NUSD
conversion (`mintAtOracle` / `redeemAtOracle`) belongs to NUSD and is covered in
[nusd.md](./nusd.md).

Prompts for AI coding agents are in [prompts/0xfi.md](./prompts/0xfi.md).

## Which deployment is live

The live set is **v3**: `0xFi/contracts/deployments/v3-fi.json` together with
`contracts/deployments/v3-core.json`. The web app reads the flat file
`apps/web/features/fi/config/testnet.generated.json`
(`apps/web/features/fi/config/deployment.ts:2,59-114`), and its addresses match
`v3-fi.json` for every shared key.

`0xFi/contracts/deployments/latest.json` is the **retired v1 suite** (router
`0x7b17…`, NUSD `0x5317…`, lending pool `0x7CB6…`, `nusdPointsStaking`). Do not
integrate against it.

The web app ignores environment overrides of these addresses unless
`NEXT_PUBLIC_ALLOW_DEPLOYMENT_OVERRIDES=true` (`deployment.ts:26-32`), so the JSON
values are what users actually transact with.

## Contracts and addresses

| Contract | Address | Key in `testnet.generated.json` (line) | Key in `v3-fi.json` |
| --- | --- | --- | --- |
| NUSD (`OracleNUSDv2`, 18 decimals) | `0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19` | `nusd` (5) | `nusd`; also `v3-core.json:9` |
| WzkLTC (18 decimals) | `0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F` | `wzkltc` (6) | `wzkLTC` |
| nBTC | `0xAA612e178ff9c4Ea044eF507670C7502D58CbA46` | `nbtc` (7) | `nBTC` |
| nETH | `0x3f3B4F9DfE1AE3CDaa89788810557194c662a8Ef` | `neth` (8) | `nETH` |
| DEX factory `ZeroXFiFactoryV2` | `0xc6B675d701a168789A5cc7Dd04Ef9e531886114c` | `dexFactory` (9) | `dexFactory` |
| DEX router `ZeroXFiRouterV2` | `0x1cda4793122a223A09be54ED5f664ba222eEe042` | `dexRouter` (10) | `dexRouter` |
| `GaugeFactory` | `0xB300Faa8AE7a36eFa17e028dE325dA0c12110904` | `farmFactory` (11) | `gaugeFactory` (name differs) |
| Synth safety reserve | `0xA8701A2ed4a085105EDe2F68BA2383b98C5d6E6b` | `synthSafetyReserve` (12) | `synthSafetyReserve` |
| Lending pool `PooledNUSDLendingPoolV2` | `0x6Cc96c044321b3205Ac108107Fc6d2d47e0B3E44` | `lendingPool` (14) | `lendingPool` |
| nBTC vault `SyntheticVault` | `0x094343B925941D00424E8440C572231D6b93a751` | `nbtcVault` (16) | `nBTCVault` |
| nETH vault `SyntheticVault` | `0xF909924f8BD003673d97667EA150173f87FaFA1B` | `nethVault` (17) | `nETHVault` |
| LTC/USD `OracleRouter` | `0xf9CCF611b7c4e642852D3d1a7A6C3883985A2962` | `ltcOracle` (18) | `ltcOracle`; `v3-core.json:8` |
| BTC/USD `OracleRouter` | `0xacB29CD8e1d7A206133bD4409b744d7C621c4535` | `btcOracle` (19) | `btcOracle`; `v3-core.json:2` |
| ETH/USD `OracleRouter` | `0xc8Df5A07a2aB6c98694ee77ADf1DD4eC26541677` | `ethOracle` (20) | `ethOracle`; `v3-core.json:5` |
| DIA LTC aggregator (raw) | `0x45dDa5d881BD2C917976CCfde74fFd6f6412da29` | `diaLtcFeed` (21) | none |
| DIA BTC aggregator (raw) | `0x7d0445782E383223c7B4B660bb96b87213e9b605` | `diaBtcFeed` (22) | none |
| DIA ETH aggregator (raw) | `0xc760B46beF9eD3F9A3d2b825164324D6703F0185` | `diaEthFeed` (23) | none |
| WzkLTC/NUSD pair | `0x7a9295742b237802571E80148C2CEc629C5D6E67` | `wzkLtcNusdPair` (24) | `wzkLtcNusdPair` |
| nBTC/NUSD pair | `0x1D7e66D1301154146467dC7E3fc2916aa1a8Bc4c` | `nbtcNusdPair` (25) | `nBTCNusdPair` |
| nETH/NUSD pair | `0x1890bb89CB57551575ccc84D0079d6A8A245285B` | `nethNusdPair` (26) | `nETHNusdPair` |
| WzkLTC/NUSD gauge | `0x41c7ac8164Ef6c3F7CFCD9A55C62f047C708C74e` | `wzkLtcNusdGauge` (27) | `wzkLtcNusdGauge` |
| nBTC/NUSD gauge | `0xEadD7394330817c118383F6A593B1F6CF832a8Ee` | `nbtcNusdGauge` (28) | `nBTCNusdGauge` |
| nETH/NUSD gauge | `0x495A7d607a3e883ef746a5130e9B5BDFdF92C2B1` | `nethNusdGauge` (29) | `nETHNusdGauge` |
| LP locker | `0x84d36BAc1f7C4E287380d35C1F51E6636AF56D5E` | `lpLocker` (33) | `lpLocker` |
| Fee splitter | `0xAea1Ef82Dbe800BB3683009630813457D990a9B0` | `feeSplitter` (36) | `v3-core.json:6` |
| 0xFi subgraph | `https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxfi-testnet/1.0.0/gn` | `goldskyEndpoint` (3) | none |
| Start block | `61141359` | `deploymentBlock` (4) | `0xFi/subgraph/subgraph.config.json:9` |

Each `*Oracle` is a core `OracleRouter` labelled "LTC/USD", "BTC/USD" or
"ETH/USD" (`contracts/script/DeployV3Core.s.sol:89-91`). Its sources are DIA
adapters (`DeployV3Core.s.sol:48-50`).

**Load addresses from the manifest, do not hard-code them.** The table is for
reading. Your code should import a copy of
`apps/web/features/fi/config/testnet.generated.json` and pass every value
through `getAddress`. Contracts have no proxies: a redeploy means new addresses
and a new manifest.

```ts
// fi/addresses.ts
import { getAddress } from "viem";
// A copy of apps/web/features/fi/config/testnet.generated.json
import manifest from "./testnet.generated.json";

export const FI = {
  nusd: getAddress(manifest.nusd),
  wzkLtc: getAddress(manifest.wzkltc),
  nbtc: getAddress(manifest.nbtc),
  neth: getAddress(manifest.neth),
  factory: getAddress(manifest.dexFactory),
  router: getAddress(manifest.dexRouter),
  gaugeFactory: getAddress(manifest.farmFactory),
  lendingPool: getAddress(manifest.lendingPool),
  nbtcVault: getAddress(manifest.nbtcVault),
  nethVault: getAddress(manifest.nethVault),
  ltcOracle: getAddress(manifest.ltcOracle),
  btcOracle: getAddress(manifest.btcOracle),
  ethOracle: getAddress(manifest.ethOracle),
} as const;

export const FI_SUBGRAPH_URL: string = manifest.goldskyEndpoint;
export const FI_START_BLOCK = BigInt(manifest.deploymentBlock); // 61141359
export const ZERO = "0x0000000000000000000000000000000000000000" as const;
```

The web app takes the router address from this metadata, not from
`factory.router()` (`apps/web/features/fi/lib/hooks/useActiveDexRouter.ts:4-8`).
You can compare the two as a sanity check.

### Decimals

| Token | Decimals | Source |
| --- | --- | --- |
| NUSD | 18 | required by the lending constructor, `lending/PooledNUSDLendingPoolV2.sol:154` |
| WzkLTC, native zkLTC | 18 | `WzkLTC.sol:14` (OpenZeppelin ERC-20) |
| LP tokens (`0xFI-LP`) | 18 | `amm/ZeroXFiPair.sol:55` |
| Lending shares (`xfiNUSD`) | 18 | `PooledNUSDLendingPoolV2.sol:148` |
| nBTC, nETH | 18 (inferred from `0.01 ether` / `0.25 ether` debt ceilings, `0xFi/contracts/script/Deploy0xFiV3.s.sol:80-81`) | read `decimals()` live |
| Any other ERC-20 | read `decimals()` live | as `apps/web/features/fi/components/CreatePoolForm.tsx:51-53` does |

### Decoding errors

All errors below are parameterless unless shown with arguments. Add them to your
ABI fragments so `simulateContract` throws a `ContractFunctionRevertedError`
with a readable `errorName`:

```ts
// fi/errors.ts
import { BaseError, ContractFunctionRevertedError, parseAbi } from "viem";

export const fiErrorsAbi = parseAbi([
  // ZeroXFiRouterV2.sol:29-42
  "error DeadlineExpired()", "error ExcessiveInputAmount()", "error FeeOnTransferUnsupported()",
  "error InsufficientAmount()", "error InsufficientLiquidity()", "error InsufficientLiquidityMinted()",
  "error InsufficientOutputAmount()", "error InvalidPath()", "error InvalidRecipient()",
  "error NativeTransferFailed()", "error NothingToDistribute()", "error PairNotFound()",
  "error UnauthorizedNativeSender()",
  // ZeroXFiPair.sol:14-22, ZeroXFiFactoryV2.sol:13-17
  "error Forbidden()", "error SwapsPaused()", "error InvariantViolation()",
  "error IdenticalTokens()", "error BaseAssetRequired()", "error InvalidContract()",
  "error PairExists()", "error ProtectedPumpPair()",
  // PooledNUSDLendingPoolV2.sol:25-45
  "error InvalidAmount()", "error UnsupportedCollateral()", "error TooManyCollateralAssets()",
  "error SupplyPaused()", "error BorrowPaused()", "error CollateralWithdrawalPaused()",
  "error SupplyCapExceeded()", "error BorrowCapExceeded()", "error CollateralCapExceeded()",
  "error InsufficientCollateral()", "error PositionHealthy()", "error ExactTransferRequired()",
  "error InsolventPool()", "error AccountHasBadDebt()", "error SlippageExceeded()",
  "error MarketNotActivated()",
  // SyntheticVault.sol:36-49
  "error MintPaused()", "error WithdrawPaused()", "error DebtCeilingExceeded()",
  "error MintFeeExceeded(uint256 feeNusd, uint256 maximumFeeNusd)",
  // LiquidityGauge.sol:12-17, GaugeFactory.sol:24-30
  "error DepositsPaused()", "error GaugeAlreadyExists()", "error InvalidPair()",
  // DIAOracleV2Adapter.sol:17-21, contracts/src/oracle/OracleRouter.sol:12-14
  "error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp)",
  "error OraclePriceOutOfBounds(uint256 priceWad, uint256 minimumPriceWad, uint256 maximumPriceWad)",
  "error IncompleteOracleRound()", "error FutureOracleTimestamp()", "error InvalidOracleAnswer()",
  "error SourceUnusable()",
]);

/** Returns the decoded custom error name, or viem's short message. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.shortMessage;
    return err.shortMessage;
  }
  return String(err);
}
```

Spread `...fiErrorsAbi` into each ABI below (for example
`[...routerAbi, ...fiErrorsAbi]`) when you pass it to `simulateContract`.

---

## Flow: swap

**Purpose.** Exchange one token for another through one to three 0xFi pools,
including native zkLTC in or out.

**Contract.** `ZeroXFiRouterV2` at `dexRouter`. Web ABI
`apps/web/features/fi/lib/abis/dex.ts:56-92`; source `amm/ZeroXFiRouterV2.sol`.

| Function | Signature | Notes |
| --- | --- | --- |
| Quote | `getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)` | Router L323. The last element is what the user receives **after LP fees and the router fee** (L322). |
| ERC-20 to ERC-20 | `swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])` | L249 |
| Native in | `swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])` | L270. `path[0]` must be WzkLTC and `msg.value > 0` (L277). |
| Native out | `swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])` | L294. The last path entry must be WzkLTC (L302); the router unwraps and pays zkLTC (L316-317). |
| Reserves | `getReserves(address tokenA, address tokenB) view returns (uint256 reserveA, uint256 reserveB)` | L367, ordered as the arguments |
| Fee constants | `LP_FEE_BPS()` = 50, `DIRECT_FEE_BPS()` = 10, `CROSS_FEE_BPS()` = 30 | L45-47; `FEE_DENOMINATOR` 10000 (L44), `MAX_HOPS` 3 (L48) |
| Fee detail (contract only) | `quoteSwap(uint256 amountIn, address[] path)`, `routerFeeBpsForPath(address[] path) view returns (uint256)` | L329, L360; not in the web ABI |

Events: `RouterFeeAccrued(address indexed payer, address indexed token, uint256 feeBps, uint256 fee)`
(L57) and `RouterFeesDistributed(address indexed caller, address indexed token, address indexed recipient, uint256 amount)`
(L58-60). Each hop also emits the pair's `Swap` event (see the liquidity flow).

### Fees

- **LP fee:** 50 bps on every hop, kept in that pool (`getAmountOut` L381-391;
  `amm/ZeroXFiPair.sol:26`).
- **Router fee:** charged **once per route**, with no surcharge. It is 10 bps if
  `path[0]` or the last path entry is a base asset (NUSD or WzkLTC), otherwise
  30 bps (L337, L359-365). It is taken in `path[0]` when the input is a base
  asset, otherwise in `path[1]`, which must be a base asset; a non-base input
  followed by a non-base `path[1]` reverts `InvalidPath` (L333-336).
- Fees accrue in `accruedRouterFees[token]`. `distributeFees(token)` is
  permissionless and pays NUSD to the fee splitter and WzkLTC to the treasury
  (L130-147); in v3 both recipients are the fee splitter
  (`0xFi/contracts/script/Deploy0xFiV3.s.sol:139`).

| Route | Nominal total fee |
| --- | --- |
| 1 hop with a base end (every pool has one) | 0.5% + 0.1% = 0.6% |
| 2 hops, one end is NUSD or WzkLTC | 1.0% + 0.1% = 1.1% |
| TOKEN → NUSD (or WzkLTC) → TOKEN | 1.0% + 0.3% = 1.3% |
| 3 hops (maximum) | 1.5% + 0.1% or 0.3% |

Do not compute output yourself from these numbers. `getAmountsOut` already
returns the net amount.

### Path rules

- Every pair contains NUSD or WzkLTC (`createPair` reverts `BaseAssetRequired`,
  `amm/ZeroXFiFactoryV2.sol:131`).
- A path has 2 to 4 entries, no zero address and no duplicates (Router L467-476).
- Every hop's pair must exist, otherwise `PairNotFound` (L478-481).
- Fee-on-transfer tokens are rejected: the router checks exact balance deltas
  (`FeeOnTransferUnsupported`, L483-493).
- Exact zkLTC ↔ NUSD should not use the AMM. The web app calls
  `NUSD.mintAtOracle(minNusdOut, recipient)` with value, or
  `redeemAtOracle(amountNusd, minCollateralOutWei, recipient)`
  (`apps/web/features/fi/components/SwapWorkspace.tsx:473-476`;
  ABI `apps/web/features/fi/lib/abis/nusd.ts:1-36`). See [nusd.md](./nusd.md).

### How the web app routes

`apps/web/features/fi/lib/hooks/useSwapRoute.ts:108-235` quotes up to four
candidates with `getAmountsOut` and keeps the largest output (L376):

1. the direct path `[in, out]`;
2. the NUSD bridge `[in, NUSD, out]`;
3. when native zkLTC is paid: `mintAtOracle`, then the pool hop `[NUSD, out]`;
4. when native zkLTC is received: the pool hop `[in, NUSD]`, then `redeemAtOracle`.

The oracle-plus-pool routes are **two wallet transactions**. The second leg uses
the NUSD that actually arrived and scales its minimum down accordingly
(`SwapWorkspace.tsx:485-546`). Default slippage is 50 bps (`SwapWorkspace.tsx:64`)
and the deadline is now + 20 minutes (`apps/web/features/fi/lib/format.ts:75`).
The single-transaction snippet below also probes the WzkLTC bridge
`[in, WzkLTC, out]`, which the router accepts.

### Preconditions and approvals

- ERC-20 input: approve the **router** for `amountIn`. The router pulls the
  whole input, keeps the fee and sends the rest to the first pair (L425-433).
  The web app approves exactly `amountIn` (`SwapWorkspace.tsx:565`).
- Native input: no approval; send `value = amountIn`
  (`apps/web/features/fi/lib/swap.ts:208-213`).
- Native output: approve the ERC-20 input; the path must end in WzkLTC
  (`swap.ts:215-217`).
- Never send zkLTC to the router directly (`UnauthorizedNativeSender`, L124-126).

### Steps

1. Check chain 4441 on the wallet and the RPC.
2. Build candidate paths and quote each with `getAmountsOut`. Keep the best.
3. `amountOutMin = minOut(quote, slippageBps)`. Refuse a zero minimum.
4. ERC-20 input: check the allowance for the router and approve if short; wait
   for the approval receipt.
5. Simulate the swap with the exact account, args and value. Then write and wait
   for the receipt.

### Snippet

```ts
// fi/swap.ts
import { parseAbi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, minOut, send } from "../tx";
import { FI } from "./addresses";
import { fiErrorsAbi } from "./errors";

const routerAbi = [
  ...parseAbi([
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
    "function swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
    "function swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  ]),
  ...fiErrorsAbi,
] as const;

const eq = (x: Address, y: Address) => x.toLowerCase() === y.toLowerCase();
export const deadlineIn = (minutes = 20) => BigInt(Math.floor(Date.now() / 1000) + minutes * 60);

export type Side = Address | "native";

export async function quoteBestRoute(tokenIn: Side, tokenOut: Side, amountIn: bigint) {
  const a = tokenIn === "native" ? FI.wzkLtc : tokenIn;
  const b = tokenOut === "native" ? FI.wzkLtc : tokenOut;
  if (eq(a, b)) throw new Error("Same token: wrap or unwrap with WzkLTC deposit/withdraw instead");
  const candidates: Address[][] = [[a, b]];
  for (const base of [FI.nusd, FI.wzkLtc]) {
    if (!eq(a, base) && !eq(b, base)) candidates.push([a, base, b]);
  }
  const quotes = await Promise.all(
    candidates.map(async (path) => {
      try {
        const amounts = await publicClient.readContract({
          address: FI.router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path],
        });
        return { path, out: amounts[amounts.length - 1] };
      } catch {
        return undefined; // PairNotFound, InvalidPath, InsufficientLiquidity
      }
    }),
  );
  let best: { path: Address[]; out: bigint } | undefined;
  for (const q of quotes) if (q && (!best || q.out > best.out)) best = q;
  if (!best || best.out === 0n) throw new Error("No executable 0xFi route");
  return best;
}

export async function swap(
  walletClient: WalletClient,
  account: Address,
  tokenIn: Side,
  tokenOut: Side,
  amountIn: bigint,
  slippageBps = 50n,
) {
  if (amountIn <= 0n) throw new Error("Amount must be positive");
  if (slippageBps < 0n || slippageBps >= 10_000n) throw new Error("Slippage out of range");
  await assertChain(walletClient);
  if ((await publicClient.getChainId()) !== 4441) throw new Error("RPC is not chain 4441");
  const nativeNusd =
    (tokenIn === "native" && tokenOut !== "native" && eq(tokenOut, FI.nusd)) ||
    (tokenOut === "native" && tokenIn !== "native" && eq(tokenIn, FI.nusd));
  if (nativeNusd) throw new Error("Use NUSD mintAtOracle / redeemAtOracle for zkLTC <-> NUSD");

  // Fresh quote right before sending.
  const best = await quoteBestRoute(tokenIn, tokenOut, amountIn);
  const amountOutMin = minOut(best.out, slippageBps);
  if (amountOutMin === 0n) throw new Error("Minimum output rounds to zero");

  if (tokenIn === "native") {
    return send(walletClient, {
      account, address: FI.router, abi: routerAbi, functionName: "swapExactNativeForTokens",
      args: [amountOutMin, best.path, account, deadlineIn()], value: amountIn,
    });
  }
  await ensureAllowance(walletClient, account, tokenIn, FI.router, amountIn);
  return send(walletClient, {
    account, address: FI.router, abi: routerAbi,
    functionName: tokenOut === "native" ? "swapExactTokensForNative" : "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, best.path, account, deadlineIn()],
  });
}
```

If the user waits before confirming, quote again. A stale quote shows up as
`InsufficientOutputAmount` in simulation.

### Errors to handle

| Error | Meaning | What to show |
| --- | --- | --- |
| `InsufficientOutputAmount` | Price moved beyond slippage (L259, L280, L306) | "Price moved, review the new quote" |
| `DeadlineExpired` | `block.timestamp > deadline` (L503) | Re-quote and resend |
| `PairNotFound`, `InvalidPath` | A hop has no pool, or the route shape is invalid | Hide the route |
| `InsufficientLiquidity`, `InsufficientAmount` | Pool too small or amount zero (L376, L386-387) | "Not enough liquidity" |
| `FeeOnTransferUnsupported` | Token takes a transfer fee | "Token not supported" |
| `SwapsPaused` (pair) | Factory paused swaps (`ZeroXFiPair.sol:125`) | Disable swapping; `factory.swapsPaused()` is readable |
| `InvalidRecipient` | `to` is zero (L504) | Fix the recipient |

---

## Flow: add and remove liquidity

**Purpose.** Deposit two tokens into a pool for LP tokens, or burn LP tokens for
the underlying tokens.

**Contracts.** The router (struct arguments; `dex.ts:31-54,88-91`; Router
L62-101, L151-245), the factory, and the pair.

| Function | Signature |
| --- | --- |
| Add | `addLiquidity((address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 minimumLiquidity, address to, uint256 deadline)) returns (uint256 amountA, uint256 amountB, uint256 liquidity)` |
| Add with zkLTC | `addLiquidityNative((address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountNativeMin, uint256 minimumLiquidity, address to, uint256 deadline)) payable returns (uint256 amountToken, uint256 amountNative, uint256 liquidity)`. `msg.value` is the desired zkLTC; the unused part is refunded (L186, L196). |
| Remove | `removeLiquidity((address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)) returns (uint256 amountA, uint256 amountB)` |
| Remove to zkLTC | `removeLiquidityNative((address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountNativeMin, address to, uint256 deadline)) returns (uint256 amountToken, uint256 amountNative)`. Pays native zkLTC (L243-244). |
| Find pool | `factory.getPair(address tokenA, address tokenB) view returns (address pair)` (`dex.ts:3-7`) |
| Pair views | `token0()`, `token1()`, `getReserves() returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)`, `totalSupply()`, `balanceOf(address)` (`dex.ts:20-29`) |

Pair facts (`amm/ZeroXFiPair.sol`): one LP token per unordered pair, named
"0xFi LP Token", symbol "0xFI-LP" (L55), with `token0 < token1` (L56). On the
first deposit `liquidity = sqrt(amount0 * amount1) - 1000` and 1000 LP is locked
to `address(1)`; the deposit reverts `InsufficientLiquidityMinted` unless
`sqrt(amount0 * amount1) > 1000` (L80-84). Later deposits mint
`min(amount0 * supply / reserve0, amount1 * supply / reserve1)` (L86).

Pair events: `Mint(address indexed sender, uint256 amount0, uint256 amount1, address indexed to, uint256 liquidity)` (L41),
`Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to, uint256 liquidity)` (L42),
`Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)` (L43-50; `sender` is always the router),
`Sync(uint112 reserve0, uint112 reserve1)` (L51).

### Rules

- `addLiquidity*` **creates the pair if it does not exist** (`_prepareLiquidity`
  L404-405). Creation still needs a base asset, and a protected 0xPump pair
  reverts.
- For an existing pool the router fits your amounts to the reserves ratio and
  reverts `InsufficientAmount` or `ExcessiveInputAmount` if the fitted amount
  falls below your minimum (L407-421). It reverts
  `InsufficientLiquidityMinted` if LP < `minimumLiquidity` (L169, L194).
- Approvals: each ERC-20 side goes to the **router** for its desired amount.
  For removal, approve the **pair (LP token)** to the router for `liquidity`;
  the router pulls it with `transferFrom` (L206, L227).
- The first deposit sets the price. Make the user confirm both amounts
  explicitly when the pool is new or empty.

The web app (`apps/web/features/fi/components/PoolDetail.tsx`) reads `getPair`
(L73) and the pair state (L83-115), derives the second amount as
`b = a * reserveB / reserveA` (L151-161), approves exact amounts and skips the
native side (L166-169), and sets `minimumLiquidity` and each `amount*Min` with
50 bps slippage (L57, L170-184). Removal approves the pair to the router (L219)
and calls `removeLiquidity` or `removeLiquidityNative` with minimums (L211-216).

### Steps (add)

1. Check the chain. Read `getPair`; if it exists, read `router.getReserves(tokenA, tokenB)`
   and `pair.totalSupply()`.
2. Derive the second amount from reserves (or take both from the user for a new pool).
3. Compute expected LP and apply slippage to `amountAMin`, `amountBMin` and
   `minimumLiquidity`.
4. Approve each ERC-20 side to the router; wait for receipts.
5. Simulate, write, wait for the receipt.

### Snippet

```ts
// fi/liquidity.ts
import { parseAbi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, minOut, send } from "../tx";
import { FI, ZERO } from "./addresses";
import { fiErrorsAbi } from "./errors";
import { deadlineIn } from "./swap";

const liqAbi = [
  ...parseAbi([
    "function getReserves(address tokenA, address tokenB) view returns (uint256 reserveA, uint256 reserveB)",
    "struct AddParams { address tokenA; address tokenB; uint256 amountADesired; uint256 amountBDesired; uint256 amountAMin; uint256 amountBMin; uint256 minimumLiquidity; address to; uint256 deadline; }",
    "function addLiquidity(AddParams params) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
    "struct AddNative { address token; uint256 amountTokenDesired; uint256 amountTokenMin; uint256 amountNativeMin; uint256 minimumLiquidity; address to; uint256 deadline; }",
    "function addLiquidityNative(AddNative params) payable returns (uint256 amountToken, uint256 amountNative, uint256 liquidity)",
    "struct RemoveParams { address tokenA; address tokenB; uint256 liquidity; uint256 amountAMin; uint256 amountBMin; address to; uint256 deadline; }",
    "function removeLiquidity(RemoveParams params) returns (uint256 amountA, uint256 amountB)",
  ]),
  ...fiErrorsAbi,
] as const;
const factoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address pair)"]);
const pairAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/** Reads pool state. `amountB` is derived from reserves when the pool has liquidity. */
export async function planAdd(tokenA: Address, tokenB: Address, amountA: bigint, amountBForNewPool?: bigint) {
  const pair = await publicClient.readContract({ address: FI.factory, abi: factoryAbi, functionName: "getPair", args: [tokenA, tokenB] });
  if (pair !== ZERO) {
    const [[rA, rB], supply] = await Promise.all([
      publicClient.readContract({ address: FI.router, abi: liqAbi, functionName: "getReserves", args: [tokenA, tokenB] }),
      publicClient.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }),
    ]);
    if (rA > 0n && rB > 0n && supply > 0n) {
      const amountB = (amountA * rB) / rA;
      const lpA = (amountA * supply) / rA, lpB = (amountB * supply) / rB;
      return { pair, isNew: false, amountB, expectedLp: lpA < lpB ? lpA : lpB };
    }
  }
  if (amountBForNewPool === undefined) throw new Error("New pool: the user must choose both amounts (this sets the price)");
  const root = sqrt(amountA * amountBForNewPool);
  if (root <= 1000n) throw new Error("First deposit too small");
  return { pair, isNew: true, amountB: amountBForNewPool, expectedLp: root - 1000n };
}

export async function addLiquidity(
  walletClient: WalletClient, account: Address,
  tokenA: Address, tokenB: Address, amountA: bigint, amountBForNewPool?: bigint, slippageBps = 50n,
) {
  await assertChain(walletClient);
  const plan = await planAdd(tokenA, tokenB, amountA, amountBForNewPool);
  if (plan.amountB === 0n || plan.expectedLp === 0n) throw new Error("Amount too small for this pool");
  await ensureAllowance(walletClient, account, tokenA, FI.router, amountA);
  await ensureAllowance(walletClient, account, tokenB, FI.router, plan.amountB);
  return send(walletClient, {
    account, address: FI.router, abi: liqAbi, functionName: "addLiquidity",
    args: [{
      tokenA, tokenB, amountADesired: amountA, amountBDesired: plan.amountB,
      amountAMin: minOut(amountA, slippageBps), amountBMin: minOut(plan.amountB, slippageBps),
      minimumLiquidity: minOut(plan.expectedLp, slippageBps), to: account, deadline: deadlineIn(),
    }],
  });
}

/** TOKEN + native zkLTC. The pool is TOKEN/WzkLTC; zkLTC is sent as value, no approval. */
export async function addLiquidityWithZkLtc(
  walletClient: WalletClient, account: Address, token: Address, tokenAmount: bigint, zkLtcForNewPool?: bigint, slippageBps = 50n,
) {
  await assertChain(walletClient);
  const plan = await planAdd(token, FI.wzkLtc, tokenAmount, zkLtcForNewPool);
  await ensureAllowance(walletClient, account, token, FI.router, tokenAmount);
  return send(walletClient, {
    account, address: FI.router, abi: liqAbi, functionName: "addLiquidityNative", value: plan.amountB,
    args: [{
      token, amountTokenDesired: tokenAmount, amountTokenMin: minOut(tokenAmount, slippageBps),
      amountNativeMin: minOut(plan.amountB, slippageBps), minimumLiquidity: minOut(plan.expectedLp, slippageBps),
      to: account, deadline: deadlineIn(),
    }],
  });
}

export async function removeLiquidity(
  walletClient: WalletClient, account: Address, tokenA: Address, tokenB: Address, liquidity: bigint, slippageBps = 50n,
) {
  await assertChain(walletClient);
  const pair = await publicClient.readContract({ address: FI.factory, abi: factoryAbi, functionName: "getPair", args: [tokenA, tokenB] });
  if (pair === ZERO) throw new Error("Pool not found");
  const [[rA, rB], supply, balance] = await Promise.all([
    publicClient.readContract({ address: FI.router, abi: liqAbi, functionName: "getReserves", args: [tokenA, tokenB] }),
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: pair, abi: pairAbi, functionName: "balanceOf", args: [account] }),
  ]);
  if (liquidity <= 0n || liquidity > balance) throw new Error("Invalid LP amount");
  await ensureAllowance(walletClient, account, pair, FI.router, liquidity); // LP token approval
  return send(walletClient, {
    account, address: FI.router, abi: liqAbi, functionName: "removeLiquidity",
    args: [{
      tokenA, tokenB, liquidity,
      amountAMin: minOut((liquidity * rA) / supply, slippageBps),
      amountBMin: minOut((liquidity * rB) / supply, slippageBps),
      to: account, deadline: deadlineIn(),
    }],
  });
}
```

`removeLiquidityNative` works the same way with `{ token, liquidity, amountTokenMin, amountNativeMin, to, deadline }`
against the TOKEN/WzkLTC pair and pays zkLTC.

### Create a pool explicitly

`factory.createPair(address tokenA, address tokenB) returns (address pair)` is
permissionless (`amm/ZeroXFiFactoryV2.sol:129-134`; `dex.ts:13-17`). It emits
`PairCreated(address indexed token0, address indexed token1, address pair, bytes32 indexed pairId, bool protectedBootstrap, uint256 pairCount)`
(L38-45). The web UI only offers TOKEN/NUSD (`CreatePoolForm.tsx:125-131`); the
contract also accepts TOKEN/WzkLTC. Usually you do not need it, because
`addLiquidity` creates the pair.

### Errors to handle

| Error | Meaning |
| --- | --- |
| `BaseAssetRequired` | Neither token is NUSD or WzkLTC (factory L131) |
| `ProtectedPumpPair` | The token is a 0xPump token still in its launch lifecycle; its NUSD pool is created by graduation (L132, L148-153, L170-174) |
| `PairExists`, `InvalidContract`, `IdenticalTokens` | `createPair` input problems (L159-160) |
| `InsufficientAmount`, `ExcessiveInputAmount` | Ratio moved past your minimums (Router L407-421) |
| `InsufficientLiquidityMinted` | LP below `minimumLiquidity`, or first deposit too small |
| `InsufficientOutputAmount` | A removal returned less than `amountAMin`/`amountBMin` (or the native minimums) (Router L213, L234-235) |
| `DeadlineExpired` | Re-read reserves and resend |

---

## Flow: farm LP tokens

**Purpose.** Stake LP tokens in a gauge to earn NUSD, then claim or withdraw.

**Contracts.** `GaugeFactory` at `farmFactory` and one `LiquidityGauge` per pair.
Web ABI `apps/web/features/fi/lib/abis/farm.ts:1-117`.

| Function | Signature | Source |
| --- | --- | --- |
| Find gauge | `gaugeForPair(address lpToken) view returns (address gauge)`; also `allGauges(uint256)`, `allGaugesLength()` | `farming/GaugeFactory.sol:37-38,57` |
| Create gauge | `createGauge(address pair)`, permissionless, needs `dexFactory.isPair(pair)` | L61-68 |
| Stake | `stake(uint256 amount)` | `farming/LiquidityGauge.sol:91` |
| Withdraw | `withdraw(uint256 amount)` | L102 |
| Claim | `getReward() returns (uint256 reward)` | L111 |
| Exit (contract only) | `exit()` | L120 |
| Views | `stakingToken`, `rewardRate`, `periodFinish`, `totalSupply`, `totalFunded`, `totalPaid`, `depositsPaused`, `pausedRewardDuration`, `balanceOf(account)`, `earned(account)` | L23-40, L86-89 |

- The reward token is **NUSD** and the staking token is the pair's LP token
  (`GaugeFactory.sol:64`).
- `fundGauge` is owner-only (L70). Rewards exist only while a funded schedule
  runs. `rewardRate` is NUSD wei per second; accounting uses `PRECISION` 1e18
  (`LiquidityGauge.sol:19`); a schedule lasts 1 to 365 days (L20-21).
- An APR derived from `rewardRate` is only meaningful while
  `block.timestamp < periodFinish` and `totalSupply > 0`. Do not label it as
  guaranteed.
- Approval: the pair (LP token) to the **gauge** for the stake amount
  (`apps/web/features/fi/components/FarmDashboard.tsx:222`).

Events: `Staked(address indexed account, uint256 amount)`,
`Withdrawn(address indexed account, uint256 amount)`,
`RewardPaid(address indexed account, uint256 reward)`,
`RewardAdded(uint256 amount, uint256 duration, uint256 rewardRate, uint256 periodFinish)`,
`RewardSchedulePaused`, `RewardScheduleResumed`, `DepositsPauseUpdated`
(`LiquidityGauge.sol:42-48`).

The web app (`FarmDashboard.tsx`) reads `getPair` (L44), uses the configured
gauge for nBTC/nETH or else `gaugeForPair` (L56-69), reads the gauge (L71-85),
then stakes or withdraws (L222-223) and claims with `getReward` (L233).

### Snippet

```ts
// fi/farm.ts
import { parseAbi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, send } from "../tx";
import { FI, ZERO } from "./addresses";
import { fiErrorsAbi } from "./errors";

const gaugeAbi = [
  ...parseAbi([
    "function gaugeForPair(address lpToken) view returns (address gauge)",
    "function stake(uint256 amount)",
    "function withdraw(uint256 amount)",
    "function getReward() returns (uint256 reward)",
    "function earned(address account) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function depositsPaused() view returns (bool)",
  ]),
  ...fiErrorsAbi,
] as const;

export async function gaugeFor(pair: Address) {
  const gauge = await publicClient.readContract({ address: FI.gaugeFactory, abi: gaugeAbi, functionName: "gaugeForPair", args: [pair] });
  if (gauge === ZERO) throw new Error("No gauge for this pool");
  return gauge;
}

export async function stakeLp(walletClient: WalletClient, account: Address, pair: Address, amount: bigint) {
  if (amount <= 0n) throw new Error("Amount must be positive");
  await assertChain(walletClient);
  const gauge = await gaugeFor(pair);
  if (await publicClient.readContract({ address: gauge, abi: gaugeAbi, functionName: "depositsPaused" })) {
    throw new Error("Deposits are paused on this gauge");
  }
  await ensureAllowance(walletClient, account, pair, gauge, amount);
  return send(walletClient, { account, address: gauge, abi: gaugeAbi, functionName: "stake", args: [amount] });
}

export async function withdrawLp(walletClient: WalletClient, account: Address, pair: Address, amount: bigint) {
  await assertChain(walletClient);
  const gauge = await gaugeFor(pair);
  const staked = await publicClient.readContract({ address: gauge, abi: gaugeAbi, functionName: "balanceOf", args: [account] });
  if (amount <= 0n || amount > staked) throw new Error("Invalid amount");
  return send(walletClient, { account, address: gauge, abi: gaugeAbi, functionName: "withdraw", args: [amount] });
}

export async function claim(walletClient: WalletClient, account: Address, pair: Address) {
  await assertChain(walletClient);
  const gauge = await gaugeFor(pair);
  const earned = await publicClient.readContract({ address: gauge, abi: gaugeAbi, functionName: "earned", args: [account] });
  if (earned === 0n) throw new Error("Nothing to claim");
  return send(walletClient, { account, address: gauge, abi: gaugeAbi, functionName: "getReward", args: [] });
}
```

Errors: `DepositsPaused`, `InvalidAmount` (zero, or withdraw above balance),
`FeeOnTransferUnsupported` (`LiquidityGauge.sol:12-17`); on `createGauge`,
`InvalidPair` and `GaugeAlreadyExists`.

---

## Flow: lend and borrow

**Purpose.** Supply NUSD to earn interest, or deposit WzkLTC, nBTC or nETH as
collateral and borrow NUSD.

**Contract.** `PooledNUSDLendingPoolV2` at `lendingPool`. Web ABI
`apps/web/features/fi/lib/abis/lending.ts`; source
`lending/PooledNUSDLendingPoolV2.sol`.

### Parameters

| Parameter | Value | Source |
| --- | --- | --- |
| Borrow APR (fixed) | 450 bps | `PooledNUSDLendingPoolV2.sol:49` |
| Lender APR | 400 bps, applied to the borrowed share (supply rate = lender rate × utilization) | L50, L642-652 |
| Protocol spread | 50 bps | L51 |
| Close factor | 5000 bps | L52 |
| Collateral assets the pool can list | at most 8 (pool-wide; the owner's `configureCollateral` reverts `TooManyCollateralAssets` on a ninth asset) | L53, L195 |
| Supply cap / borrow cap | 5,000 NUSD / 2,500 NUSD | `Deploy0xFiV3.s.sol:82-83,177-178` |
| WzkLTC collateral | `ltcOracle`, cap 50e18, LTV 8000, margin call 8500, liquidation 9000, bonus 500 | `Deploy0xFiV3.s.sol:180-187` |
| nBTC collateral | `btcOracle`, cap 0.01e18, same ratios | same |
| nETH collateral | `ethOracle`, cap 0.25e18, same ratios | same |

Caps and ratios can be changed by the owner. Read them live:
`collateralConfigs(asset)` returns `(oracle, supplyCap, loanToValueBps, liquidationThresholdBps, liquidationBonusBps, decimals, enabled, marginCallThresholdBps)`
in that order (`lending.ts:5-15`).

Supply shares are the ERC-20 "0xFi Pooled NUSD" (`xfiNUSD`); 1000 shares are
locked to `address(1)` on the first supply (L55, L148, L318-328).

### Risk model

- Collateral value = `amount * oracle.readPriceWad().priceWad / 10**decimals`.
  Borrowing capacity sums LTV-weighted value across **all** enabled collateral
  assets of the account; margin-call and liquidation capacities use their
  thresholds (L746-772). Risk is **pooled across the account's assets**, not
  isolated per asset.
- `healthFactor(account)` = liquidation capacity × 1e18 / debt, or
  `type(uint256).max` with no debt (L547-552). At or below 1e18
  (`debt >= liquidationCapacity`) the account can be liquidated
  (`isLiquidatable`, L666-671).
- Collateral is the **ERC-20 WzkLTC, not native zkLTC**. Wrap first with
  `WzkLTC.deposit()` (payable, `WzkLTC.sol:20`); unwrap with `withdraw(uint256)`
  (L24). The web app does this as a separate step and labels WzkLTC "nLTC"
  (`apps/web/features/fi/components/BorrowWorkspace.tsx:197-205`).
- A stale or out-of-bounds oracle price makes debt-increasing actions revert.

### Functions

| Function | Signature | Web ABI line |
| --- | --- | --- |
| Supply | `supply(uint256 amount, address onBehalfOf) returns (uint256 shares)` | 147 |
| Withdraw supply | `withdraw(uint256 amount, address recipient) returns (uint256)`. `amount` is NUSD; the return value is the number of supply shares burned (the contract names it `sharesBurned`, L333; the web ABI calls it `assets`) | 157 |
| Deposit collateral | `depositCollateral(address asset, uint256 amount, address onBehalfOf)` | 167 |
| Withdraw collateral | `withdrawCollateral(address asset, uint256 amount, address recipient)` | 178 |
| Borrow | `borrow(uint256 amount, address recipient)` (the contract returns `uint256 debtSharesMinted`, L399; the web ABI declares no outputs) | 189 |
| Repay | `repay(uint256 amount, address onBehalfOf) returns (uint256 repaid)`; the amount is a maximum, capped at the debt (L425-440) | 199 |
| Views | `healthFactor`, `accountRisk(account) returns (collateralValueNusd, borrowingCapacityNusd, marginCallCapacityNusd, liquidationCapacityNusd, debtNusd, currentLtvBps)`, `maxBorrow`, `maxWithdrawCollateral(account, asset)`, `collateralBalance(account, asset)`, `supplyBalance`, `maxWithdraw`, `debtBalance`, `availableLiquidity`, `totalSupplied`, `totalBorrowed`, `supplyRate` / `borrowRate` / `lenderRate` / `protocolRate` (WAD annual fractions, L630-652), `activated`, `supplyPaused`, `borrowPaused`, `collateralWithdrawalPaused` | 22-145 |
| Contract only | `redeem(uint256 shares, address recipient)` (L349); `liquidate(address account, address collateralAsset, uint256 maximumRepayNusd, uint256 minimumCollateralOut, address recipient) returns (uint256 amountRepaidNusd, uint256 collateralOut)` (L442-448) | none |

Events: `Supplied(address indexed payer, address indexed account, uint256 amountNusd, uint256 sharesMinted)` (L108),
`Withdrawn(address indexed account, address indexed recipient, uint256 amountNusd, uint256 sharesBurned)` (L109),
`CollateralDeposited(address indexed payer, address indexed account, address indexed asset, uint256 amount)` (L110),
`CollateralWithdrawn` (L111-113),
`Borrowed(address indexed account, address indexed recipient, uint256 amountNusd, uint256 debtSharesMinted)` (L114),
`Repaid(address indexed payer, address indexed account, uint256 amountNusd, uint256 debtSharesBurned)` (L115),
`Liquidated` (L116-123).

### Approvals

NUSD → pool for `supply` and `repay`; the collateral token → pool for
`depositCollateral` (`LendingWorkspace.tsx:63`, `BorrowWorkspace.tsx:194-196`).
`withdraw`, `borrow` and `withdrawCollateral` need no approval.

### Steps

- **Supply:** check chain → read `activated`, `supplyPaused`, `totalSupplied`
  against the cap → approve NUSD → simulate `supply(amount, account)` → write →
  receipt.
- **Borrow against zkLTC:** wrap zkLTC with `WzkLTC.deposit()` → approve WzkLTC
  → `depositCollateral(WzkLTC, amount, account)` → read `maxBorrow(account)`
  fresh → `borrow(amount, account)` with `amount <= maxBorrow` → receipt → read
  `healthFactor` again.
- **Repay:** read `debtBalance` → approve NUSD for the debt plus a small buffer
  (interest accrues per second; `repay` takes only the actual debt) → `repay`.
- **Withdraw collateral:** read `maxWithdrawCollateral(account, asset)` → call
  `withdrawCollateral` with an amount at or below it.

### Snippet

```ts
// fi/lending.ts
import { parseAbi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, send } from "../tx";
import { FI } from "./addresses";
import { fiErrorsAbi } from "./errors";

const poolAbi = [
  ...parseAbi([
    "function supply(uint256 amount, address onBehalfOf) returns (uint256 shares)",
    "function withdraw(uint256 amount, address recipient) returns (uint256)",
    "function depositCollateral(address asset, uint256 amount, address onBehalfOf)",
    "function withdrawCollateral(address asset, uint256 amount, address recipient)",
    "function borrow(uint256 amount, address recipient)",
    "function repay(uint256 amount, address onBehalfOf) returns (uint256 repaid)",
    "function activated() view returns (bool)",
    "function supplyPaused() view returns (bool)",
    "function borrowPaused() view returns (bool)",
    "function maxBorrow(address account) view returns (uint256 amountNusd)",
    "function maxWithdraw(address account) view returns (uint256)",
    "function maxWithdrawCollateral(address account, address asset) view returns (uint256 amount)",
    "function healthFactor(address account) view returns (uint256 healthFactorWad)",
    "function debtBalance(address account) view returns (uint256)",
  ]),
  ...fiErrorsAbi,
] as const;
const wzkAbi = parseAbi(["function deposit() payable", "function withdraw(uint256 amount)"]);

async function requireOpen(kind: "supply" | "borrow") {
  const [activated, paused] = await Promise.all([
    publicClient.readContract({ address: FI.lendingPool, abi: poolAbi, functionName: "activated" }),
    publicClient.readContract({ address: FI.lendingPool, abi: poolAbi, functionName: kind === "supply" ? "supplyPaused" : "borrowPaused" }),
  ]);
  if (!activated) throw new Error("Lending market not activated");
  if (paused) throw new Error(`${kind} is paused`);
}

export async function supplyNusd(walletClient: WalletClient, account: Address, amount: bigint) {
  if (amount <= 0n) throw new Error("Amount must be positive");
  await assertChain(walletClient);
  await requireOpen("supply");
  await ensureAllowance(walletClient, account, FI.nusd, FI.lendingPool, amount);
  return send(walletClient, { account, address: FI.lendingPool, abi: poolAbi, functionName: "supply", args: [amount, account] });
}

export async function withdrawNusd(walletClient: WalletClient, account: Address, amount: bigint) {
  await assertChain(walletClient);
  const max = await publicClient.readContract({ address: FI.lendingPool, abi: poolAbi, functionName: "maxWithdraw", args: [account] });
  if (amount <= 0n || amount > max) throw new Error("Exceeds maxWithdraw (supply balance or pool liquidity)");
  return send(walletClient, { account, address: FI.lendingPool, abi: poolAbi, functionName: "withdraw", args: [amount, account] });
}

/** Wrap zkLTC, post it as collateral, then borrow NUSD. Four transactions at most. */
export async function borrowAgainstZkLtc(walletClient: WalletClient, account: Address, zkLtcWei: bigint, borrowNusd: bigint) {
  if (zkLtcWei <= 0n || borrowNusd <= 0n) throw new Error("Amounts must be positive");
  await assertChain(walletClient);
  await requireOpen("borrow");
  await send(walletClient, { account, address: FI.wzkLtc, abi: wzkAbi, functionName: "deposit", args: [], value: zkLtcWei });
  await ensureAllowance(walletClient, account, FI.wzkLtc, FI.lendingPool, zkLtcWei);
  await send(walletClient, {
    account, address: FI.lendingPool, abi: poolAbi, functionName: "depositCollateral", args: [FI.wzkLtc, zkLtcWei, account],
  });
  const max = await publicClient.readContract({ address: FI.lendingPool, abi: poolAbi, functionName: "maxBorrow", args: [account] });
  if (borrowNusd > max) throw new Error(`Exceeds maxBorrow (${max})`);
  const result = await send(walletClient, { account, address: FI.lendingPool, abi: poolAbi, functionName: "borrow", args: [borrowNusd, account] });
  const hf = await publicClient.readContract({ address: FI.lendingPool, abi: poolAbi, functionName: "healthFactor", args: [account] });
  return { ...result, healthFactorWad: hf };
}

export async function repayAll(walletClient: WalletClient, account: Address) {
  await assertChain(walletClient);
  const debt = await publicClient.readContract({ address: FI.lendingPool, abi: poolAbi, functionName: "debtBalance", args: [account] });
  if (debt === 0n) throw new Error("No debt");
  const max = debt + debt / 1000n + 1n; // interest accrues per second; repay pulls only the actual debt
  await ensureAllowance(walletClient, account, FI.nusd, FI.lendingPool, max);
  return send(walletClient, { account, address: FI.lendingPool, abi: poolAbi, functionName: "repay", args: [max, account] });
}

export async function withdrawCollateral(walletClient: WalletClient, account: Address, asset: Address, amount: bigint) {
  await assertChain(walletClient);
  const max = await publicClient.readContract({
    address: FI.lendingPool, abi: poolAbi, functionName: "maxWithdrawCollateral", args: [account, asset],
  });
  if (amount <= 0n || amount > max) throw new Error(`Exceeds maxWithdrawCollateral (${max})`);
  return send(walletClient, { account, address: FI.lendingPool, abi: poolAbi, functionName: "withdrawCollateral", args: [asset, amount, account] });
}
```

The wallet must hold enough NUSD for the actual debt when it calls `repayAll`.
Show the health factor as `formatUnits(hf, 18)`, and "no debt" when it equals
`maxUint256`.

### Errors to handle

| Error | Meaning |
| --- | --- |
| `MarketNotActivated`, `SupplyPaused`, `BorrowPaused` | Market closed for that action |
| `CollateralWithdrawalPaused` | Only applies while the account has debt (L385) |
| `SupplyCapExceeded`, `BorrowCapExceeded`, `CollateralCapExceeded` | Caps reached (L313, L414, L371) |
| `InsufficientLiquidity` | Not enough NUSD in the pool (L340, L407) |
| `InsufficientCollateral` | The action would exceed capacity (L392, L417) |
| `AccountHasBadDebt` | The pool has recorded bad debt for this account (`badDebtNusdByAccount != 0`, L404) |
| `UnsupportedCollateral` | Asset not listed, or listed but disabled, on deposit (L366); not listed, on withdrawal (L379) |
| `StaleOraclePrice`, `OraclePriceOutOfBounds`, `SourceUnusable` | Oracle problem; retry later (`DIAOracleV2Adapter.sol:20-21`) |

---

## Flow: mint and repay synths (nBTC, nETH)

**Purpose.** Lock NUSD and mint nBTC or nETH debt at the oracle price, then
repay and withdraw.

**Contract.** `SyntheticVault` at `nbtcVault` (oracle `btcOracle`) and `nethVault`
(oracle `ethOracle`). Web ABI `apps/web/features/fi/lib/abis/synth.ts`; source
`synth/SyntheticVault.sol`.

### Parameters

| Parameter | Value | Source |
| --- | --- | --- |
| User-sponsored ratio | 10000 bps | `SyntheticVault.sol:53-59` |
| Reserve-sponsored ratio | 5000 bps | same |
| Minimum collateral ratio | 15000 bps | same |
| Liquidation ratio / bonus / close factor | 12500 / 500 / 5000 bps | same |
| Mint fee | 10 bps: `ceil(ceil(amount * price / 1e18) * 10 / 10000)` NUSD, pulled **in addition to** collateral | L819-822, L582-590 |
| Debt ceilings | 0.01 nBTC, 0.25 nETH | `Deploy0xFiV3.s.sol:80-81` |
| Fee recipient | `mintFeeDistributor` = core fee splitter | `SyntheticVault.sol:114`; `Deploy0xFiV3.s.sol:156,166,263-264` |

The 1:1 mode (user 100% + safety reserve 50%) is active only when the reserve
has held at least 100,000 NUSD for 24 hours (exit at 90,000) and
`NUSD.reserveValueNusd() >= totalSupply()` (`synth/SynthSafetyReserve.sol:30-32,157-170`).
Otherwise the user supplies the full 150%. Always ask the vault with
`quoteDepositAndMint`; it returns `oneToOneAvailable`.

### Functions

| Function | Signature |
| --- | --- |
| Quote | `quoteDepositAndMint(address account, uint256 userCollateralAmountNusd) view returns (uint256 syntheticAmount, uint256 reserveRequiredNusd, bool oneToOneAvailable)` (`synth.ts:29-37`) |
| Fee quote | `quoteMintFee(uint256 amountSynthetic) view returns (uint256 feeNusd)` (L39) |
| Mint | `depositAndMint(uint256 collateralAmountNusd, uint256 syntheticAmount, uint256 maximumFeeNusd, address recipient)` (L5). The position is always `msg.sender` (`SyntheticVault.sol:159`). |
| Mint more | `mint(uint256 amountSynthetic, uint256 maximumFeeNusd, address recipient)` (L6) |
| Top up | `depositCollateral(uint256 amountNusd, address onBehalfOf)` (L4) |
| Repay | `repay(uint256 maximumAmountSynthetic, address onBehalfOf) returns (uint256 amountRepaidSynthetic)` (L7) |
| Repay and withdraw | `repayAndWithdraw(uint256 maximumRepaySynthetic, uint256 collateralAmountNusd, address recipient)` (L8) |
| Withdraw | `withdrawCollateral(uint256 amountNusd, address recipient)` (L9) |
| Views | `position(account) returns (userCollateralNusd, reserveCollateralNusd, debtSynthetic, accountHealthFactorWad, maxWithdrawableNusd)` (L10-19), `maxMintableSynthetic`, `maxUserCollateralWithdrawable`, `quoteMintForCollateral`, `quoteCollateralForMint`, `mintPaused`, `withdrawPaused`, `debtCeilingSynthetic`, `totalDebtSynthetic`, `activated` |

Events (`SyntheticVault.sol:85-107`): `CollateralDeposited(address indexed payer, address indexed account, uint256 amountNusd)`,
`SyntheticMinted` (L89-91), `SyntheticRepaid(address indexed payer, address indexed account, uint256 amountSynthetic, uint256 debtAfter)`,
`CollateralWithdrawn(address indexed account, address indexed recipient, uint256 amountNusd)`,
`MintFeePaid(address indexed account, uint256 indexed amountSynthetic, uint256 amountNusd)`, `PositionLiquidated`.

### Approvals

- Mint and top up: NUSD → vault for `collateral + maxFee`
  (`apps/web/features/fi/components/SynthWorkspace.tsx:231-232`).
- Repay: the **synth token** → vault for the repay amount. The vault pulls it,
  then burns it (`SyntheticVault.sol:603-604`; web L234).

### Steps (mint)

As the web app does (`SynthWorkspace.tsx`):

1. `quoteDepositAndMint(account, collateral)` (L120-128).
2. Minimum synth = quote × (1 − 50 bps) (`MINT_OUTPUT_HAIRCUT_BPS`, L29, L131).
3. `quoteMintFee(minimum)` (L134-141); `maxFee` = fee × (1 + 100 bps), rounded up
   (`MINT_FEE_TOLERANCE_BPS`, L30, L41-45, L143).
4. Approve NUSD for `collateral + maxFee`.
5. `depositAndMint(collateral, minimum, maxFee, account)` (L225).

### Snippet

```ts
// fi/synth.ts
import { parseAbi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, send } from "../tx";
import { FI } from "./addresses";
import { fiErrorsAbi } from "./errors";

const vaultAbi = [
  ...parseAbi([
    "function quoteDepositAndMint(address account, uint256 userCollateralAmountNusd) view returns (uint256 syntheticAmount, uint256 reserveRequiredNusd, bool oneToOneAvailable)",
    "function quoteMintFee(uint256 amountSynthetic) view returns (uint256 feeNusd)",
    "function depositAndMint(uint256 collateralAmountNusd, uint256 syntheticAmount, uint256 maximumFeeNusd, address recipient)",
    "function repay(uint256 maximumAmountSynthetic, address onBehalfOf) returns (uint256 amountRepaidSynthetic)",
    "function withdrawCollateral(uint256 amountNusd, address recipient)",
    "function mintPaused() view returns (bool)",
    "function activated() view returns (bool)",
  ]),
  ...fiErrorsAbi,
] as const;

export async function mintSynth(walletClient: WalletClient, account: Address, vault: Address, collateralNusd: bigint) {
  if (collateralNusd <= 0n) throw new Error("Amount must be positive");
  await assertChain(walletClient);
  const [activated, paused] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "activated" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "mintPaused" }),
  ]);
  if (!activated || paused) throw new Error("Minting is not available");

  const [quoted] = await publicClient.readContract({
    address: vault, abi: vaultAbi, functionName: "quoteDepositAndMint", args: [account, collateralNusd],
  });
  const synthAmount = (quoted * 9_950n) / 10_000n;                 // 50 bps haircut for oracle movement
  if (synthAmount === 0n) throw new Error("Amount too small");
  const fee = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "quoteMintFee", args: [synthAmount] });
  const maxFee = (fee * 10_100n + 9_999n) / 10_000n;               // +1% tolerance, rounded up
  await ensureAllowance(walletClient, account, FI.nusd, vault, collateralNusd + maxFee);
  return send(walletClient, {
    account, address: vault, abi: vaultAbi, functionName: "depositAndMint",
    args: [collateralNusd, synthAmount, maxFee, account],
  });
}

export async function repaySynth(walletClient: WalletClient, account: Address, vault: Address, synth: Address, amount: bigint) {
  if (amount <= 0n) throw new Error("Amount must be positive");
  await assertChain(walletClient);
  await ensureAllowance(walletClient, account, synth, vault, amount); // the vault pulls the synth, then burns it
  return send(walletClient, { account, address: vault, abi: vaultAbi, functionName: "repay", args: [amount, account] });
}
```

Use `mintSynth(walletClient, account, FI.nbtcVault, amount)` for nBTC and
`FI.nethVault` for nETH. Pass `FI.nbtc` or `FI.neth` as `synth` to `repaySynth`.

### Errors to handle

`MarketNotActivated`, `MintPaused`, `WithdrawPaused`,
`MintFeeExceeded(feeNusd, maximumFeeNusd)` (re-quote), `DebtCeilingExceeded`,
`InsufficientCollateral`, `AccountHasBadDebt`, `InvalidAmount` (also repaying
with zero debt, L598), `InvalidRecipient`, `ExactTransferRequired`, and oracle
errors (`SyntheticVault.sol:36-49`).

---

## RWA market (not deployed)

No RWA market is deployed or listed on testnet. `shared/rwa/markets.json:2` is
`"markets": []`, and `shared/rwa/markets.ts:3-5` refuses invented deployments.
The interface below is for planning only (`0xFi/contracts/src/rwa/RwaMarket.sol`):

- `quote(bool buySide, uint256 amount) view returns (uint256 gross, uint256 fee, uint256 total)` (L80-98)
- `buy(uint256 amount, uint256 maxCost, uint256 deadline)` (L100) pulls the settlement token `total`
- `sell(uint256 amount, uint256 minProceeds, uint256 deadline)` (L110) pulls the asset
- `availableLiquidity()` (L126-130), `remainingDailySell()` (L132-134)
- `FEE_BPS = 100` (1%, L29); `paused = true` by default (L41)
- Event `Trade(address indexed trader, bool indexed buySide, uint256 assetAmount, uint256 gross, uint256 fee)` (L43)
- Errors `TradingPaused`, `InvalidAmount`, `Expired`, `Slippage`, `InsufficientLiquidity`, `DailyLimit` (L19-27)

When a market is published in `shared/rwa/markets.json`, the web app approves the
settlement token for the limit on a buy (or the asset for the amount on a sell)
(`RwaDashboard.tsx:41`), sets the limit to the quote total ±50 bps
(`shared/rwa/core.ts:55-61`) and the deadline to `block.timestamp + 300`
(`useRwaMarket.ts:33`).

---

## Oracle prices

0xFi contracts read the core `OracleRouter`:
`readPriceWad() returns (uint256 priceWad, uint256 updatedAt, uint80 roundId)`
and `isFresh() returns (bool)` (`contracts/src/oracle/OracleRouter.sol:34-38`;
web ABI `apps/web/features/fi/lib/abis/dia.ts:11-14`). Prices are USD in 1e18.
The adapter's maximum price age is configurable between 5 minutes and 1 day
(`DIAOracleV2Adapter.sol:24-25`).

The raw DIA aggregators (`diaLtcFeed`, `diaBtcFeed`, `diaEthFeed`) expose
`decimals()` and `latestRoundData() returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)`
(`dia.ts:2-6`). Read `decimals()` live.

```ts
import { parseAbi } from "viem";
import { publicClient } from "../chain";
import { FI } from "./addresses";

const oracleAbi = parseAbi([
  "function readPriceWad() view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId)",
  "function isFresh() view returns (bool)",
]);

export async function ltcPrice() {
  const fresh = await publicClient.readContract({ address: FI.ltcOracle, abi: oracleAbi, functionName: "isFresh" });
  if (!fresh) return { fresh, priceWad: undefined }; // debt-increasing actions will revert
  const [priceWad, updatedAt] = await publicClient.readContract({ address: FI.ltcOracle, abi: oracleAbi, functionName: "readPriceWad" });
  return { fresh, priceWad, updatedAt };
}
```

Show the oracle as stale and disable borrow and synth mint buttons when
`isFresh()` is false.

---

## Reading data: RPC or subgraph

| Need | Use |
| --- | --- |
| Quotes, reserves, balances, allowances, LP supply, positions, health factor, caps, pause flags | **RPC** (`readContract`, ideally batched through multicall), right before acting |
| Pool lists, swap history, liquidity events, candles, gauge and lending activity, volumes | **Subgraph** |
| Data newer than the index | `getLogs` over RPC from the last indexed block (the web app tails at most 5,000 blocks); start full scans at block `61141359` (`deploymentBlock`) or later |

Never size a transaction or a minimum output from subgraph data.

### Subgraph

Endpoint (`testnet.generated.json:3`):
`https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxfi-testnet/1.0.0/gn`.
Its data sources start at the v3 contracts' own blocks: factory `61141544`,
gauge factory `61141569`, nBTC vault `61141585`, nETH vault `61141589`,
lending pool `61141614` (`0xFi/subgraph/subgraph.yaml:13,34,55,104,153`;
`subgraph.config.json:10-14`). Schema: `0xFi/subgraph/schema.graphql`.

**NUSD-denominated fields: check before you rely on them.** The mappings in this
repository compare against a hard-coded NUSD address,
`0x5317e21aba902c6c7087a84457bc02ffe99604d1` (`0xFi/subgraph/src/pair.ts:5`,
`src/lending.ts:20`), which is the retired v1 NUSD, not the v3 NUSD
`0x69320A82…`. Built from this source, v3 pools would get `Swap.amountNusd = 0`,
`Pool.volumeNusd`/`Candle.volumeNusd`/`Protocol.totalVolumeNusd` that never grow,
candle prices equal to `price0` whatever side NUSD is on (`pair.ts:82`), and
`LendingAction.asset` set to the v1 address for NUSD actions. Compare a few
values with RPC data before you display them; if they are zero, derive NUSD
volume from `amount0In/1In/0Out/1Out` and the pool's token order yourself.

| Entity | Lines | Notes |
| --- | --- | --- |
| `Protocol` | 1-10 | pairCount, swapCount, mintCount, burnCount, gaugeCount, totalVolumeNusd, updatedAt |
| `Token` | 12-18 | id (address), symbol, name, decimals, createdAt |
| `Pool` | 20-45 | id = pair address; token0, token1, reserve0, reserve1, price0, price1, volumeNusd, counts, protectedBootstrap, bootstrapped; derived swaps, liquidityEvents, candles, gauge. `price0` = token1 per token0, decimal-adjusted (`0xFi/subgraph/src/pair.ts:17-21`) |
| `Swap` | 47-65 | sender (always the router), recipient, amount0In/1In/0Out/1Out, amountNusd (the NUSD side's in+out volume, 0 when neither token matches the mapping's NUSD constant, `pair.ts:87-89`; see the warning above), prices, reserves after, timestamp, blockNumber, txHash, logIndex |
| `LiquidityEvent` | 72-85 | action `MINT` or `BURN`, sender, recipient, amount0, amount1, liquidity, timestamp |
| `Candle` | 87-101 | period 60, 300, 3600, 14400 or 86400 s (`pair.ts:7`); id `<pool>-<period>-<bucket>`, bucket = floor(ts/period)·period (`pair.ts:159-160`); price is `price1` when token0 equals the mapping's NUSD constant, else `price0` (`pair.ts:82`; see the warning above) |
| `Gauge`, `GaugeAction` | 103-115, 124-135 | actions STAKE, WITHDRAW, REWARD, FUND |
| `SyntheticMarket`, `SyntheticAction` | 137-153, 168-181 | |
| `LendingMarket`, `LendingAction` | 183-197, 211-226 | |

Event entity ids are `txHash.concatI32(logIndex)` (`0xFi/subgraph/src/helpers.ts:10`).
`BigInt` and `BigDecimal` fields arrive as strings: convert with `BigInt(s)`.

```graphql
query PoolChart($pool: Bytes!, $since: BigInt!) {
  pool(id: $pool) {
    id reserve0 reserve1 price0 price1 volumeNusd
    token0 { id symbol decimals }
    token1 { id symbol decimals }
  }
  candles(where: { pool: $pool, period: 3600, bucket_gte: $since }, orderBy: bucket, orderDirection: asc, first: 500) {
    bucket open high low close volumeNusd tradeCount
  }
  swaps(where: { pool: $pool }, orderBy: timestamp, orderDirection: desc, first: 25) {
    txHash timestamp recipient amount0In amount1In amount0Out amount1Out amountNusd
  }
  liquidityEvents(where: { pool: $pool }, orderBy: timestamp, orderDirection: desc, first: 25) {
    action recipient amount0 amount1 liquidity txHash timestamp
  }
  _meta { block { number } }
}
```

```ts
import { FI_SUBGRAPH_URL } from "./addresses";

export async function fiQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(FI_SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new Error("Subgraph returned no data");
  return body.data;
}
```

Pass `$pool` as lowercase hex. To list a wallet's own swaps, filter
`swaps(where: { recipient: $wallet })`, because `sender` is always the router.
Compare `_meta.block.number` with `publicClient.getBlockNumber()` and label data
as delayed when the index lags.

---

## Safety checklist

- [ ] Addresses come from a copy of `testnet.generated.json` (or `v3-fi.json`),
      passed through `getAddress`. Nothing from `latest.json` (v1).
- [ ] Wallet and RPC both report chain id 4441 before every write.
- [ ] All amounts are `bigint`; input parsed with `parseUnits(value, decimals)`
      and `decimals()` read live for unknown tokens.
- [ ] Every swap re-quotes with `getAmountsOut` right before sending, uses
      `amountOutMin = minOut(quote, slippageBps)` that is not zero, and a
      deadline of a few minutes.
- [ ] Liquidity adds set `amountAMin`, `amountBMin` and `minimumLiquidity`; new
      pools ask the user to confirm the starting price.
- [ ] ERC-20 inputs are approved to the right spender (router, gauge, lending
      pool, vault) and the code waits for the approval receipt. LP removal
      approves the pair to the router; synth repay approves the synth to the vault.
- [ ] Native zkLTC: `value` is set only on payable calls; lending and synth
      collateral is WzkLTC or NUSD, never native zkLTC.
- [ ] Exact zkLTC ↔ NUSD goes through NUSD `mintAtOracle` / `redeemAtOracle`.
- [ ] `simulateContract` runs with the real `account`, `args` and `value`; a
      revert is decoded and shown, and nothing is sent.
- [ ] The receipt status is `success` before the UI reports success; state is
      re-read afterwards.
- [ ] Borrow amounts are checked against a fresh `maxBorrow`; collateral
      withdrawals against `maxWithdrawCollateral`; the health factor is shown.
- [ ] Oracle staleness (`isFresh()`) disables borrow and synth mint.
- [ ] Pause flags (`swapsPaused`, `supplyPaused`, `borrowPaused`, `mintPaused`,
      `depositsPaused`) disable the matching buttons.
- [ ] Farm APR is labelled as variable and hidden after `periodFinish`.
- [ ] Subgraph data is never used for amounts or minimums.
- [ ] No calls to the web app's `/api/*` or `/0xFi/api/*` routes.
- [ ] No private key, mnemonic or API key in client code, committed files or URLs.
