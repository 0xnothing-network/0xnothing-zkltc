# 0xFi prompts for AI coding agents

Ready-to-paste prompts for Claude Code, Cursor, Codex and similar agents. Each
prompt is self-contained: paste one, fill in the `<placeholders>`, and give the
agent read access to this repository (or copy the files the prompt names into
your project). The full reference is [../0xfi.md](../0xfi.md).

| Prompt | Builds |
| --- | --- |
| [1. Swap widget](#1-swap-widget) | Best-route swap between ERC-20s and native zkLTC through `ZeroXFiRouterV2` |
| [2. Liquidity panel](#2-liquidity-panel) | Add and remove liquidity (ERC-20/ERC-20 and ERC-20/native), create a pool |
| [3. Farm panel](#3-farm-panel) | Stake LP tokens in a `LiquidityGauge`, claim NUSD rewards, withdraw |
| [4. Lending and borrowing panel](#4-lending-and-borrowing-panel) | Supply and withdraw NUSD; deposit collateral, borrow and repay NUSD |
| [5. Synth panel](#5-synth-panel) | Mint and repay nBTC or nETH against NUSD collateral |
| [6. Pool analytics](#6-pool-analytics) | Read-only charts and history from the public 0xFi subgraph |

Every prompt shares the same chain, address and safety rules, so you can paste
several into one project. Exact zkLTC to NUSD conversion is an NUSD flow; use
[nusd.md](./nusd.md#1-mint-and-redeem-panel) for it.

Review what the agent produces with the checklist in
[../README.md](../README.md#using-an-ai-coding-agent) before you use real funds.

## 1. Swap widget

```text
You are adding a 0xFi swap widget to my app.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. <my wallet connector, e.g. RainbowKit / ConnectKit / injected>.
- All token amounts are bigint in base units. Never use Number, parseFloat, toFixed or `* 10 **` on amounts. Parse with parseUnits, format with formatUnits, and read decimals() live for any token that is not NUSD/WzkLTC (both 18).

CHAIN
- LitVM LiteForge testnet: id 4441, native currency zkLTC (18 decimals).
- RPC HTTP: https://rpc.testnet.liteforge.zeeve.net.
- RPC WS: wss://rpc.testnet.liteforge.zeeve.net/ws.
- Explorer: https://explorer.testnet.liteforge.zeeve.net.
- Source: 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6-9. Define the chain with viem defineChain and a fallback() transport.

ADDRESSES (load, do not hard-code)
- Copy 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json into the project as a JSON module and pass every address through getAddress(). Keys used here:
  - dexRouter  -> ZeroXFiRouterV2
  - dexFactory -> ZeroXFiFactoryV2
  - nusd       -> NUSD (base asset, 18 decimals)
  - wzkltc     -> WzkLTC (base asset, 18 decimals; wrapped native zkLTC)
- Do NOT use 0xFi/contracts/deployments/latest.json: it is the retired v1 suite.
- On load, assert publicClient.getChainId() === 4441.

ABI (copy these fragments; they match apps/web/features/fi/lib/abis/dex.ts:13-92 and 0xFi/contracts/src/amm/ZeroXFiRouterV2.sol)
Router:
  function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)
  function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)
  function swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)
  function swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)
  function LP_FEE_BPS() view returns (uint256)
  function DIRECT_FEE_BPS() view returns (uint256)
  function CROSS_FEE_BPS() view returns (uint256)
  error DeadlineExpired()
  error FeeOnTransferUnsupported()
  error InsufficientAmount()
  error InsufficientLiquidity()
  error InsufficientOutputAmount()
  error InvalidPath()
  error InvalidRecipient()
  error PairNotFound()
  error UnauthorizedNativeSender()
Factory:
  function swapsPaused() view returns (bool)
  error SwapsPaused()
  error Forbidden()
ERC-20:
  function decimals() view returns (uint8)
  function symbol() view returns (string)
  function balanceOf(address) view returns (uint256)
  function allowance(address owner, address spender) view returns (uint256)
  function approve(address spender, uint256 amount) returns (bool)

FACTS YOU MUST RESPECT
- Every pool contains NUSD or WzkLTC. A path has 2 to 4 entries (max 3 hops), no zero address, no duplicates; each hop's pair must exist.
- getAmountsOut(...)[last] is the amount delivered AFTER all fees. Fees: 50 bps LP per hop, plus ONE router fee per route: 10 bps if path[0] or path[last] is NUSD or WzkLTC, otherwise 30 bps. No other surcharge. (ZeroXFiRouterV2.sol:45-48,337,359-365)
- Native zkLTC in: swapExactNativeForTokens with value = amountIn, path[0] must be WzkLTC, no approval.
- Native zkLTC out: swapExactTokensForNative, path[last] must be WzkLTC, approve the ERC-20 input to the router.
- ERC-20 in: approve the ROUTER for exactly amountIn. Fee-on-transfer tokens are rejected (FeeOnTransferUnsupported).
- Never send zkLTC to the router directly (UnauthorizedNativeSender).
- WzkLTC <-> native zkLTC is wrap/unwrap (WzkLTC.deposit() payable / withdraw(uint256)), not a swap.
- Exact zkLTC <-> NUSD is NOT an AMM trade: route it to NUSD mintAtOracle / redeemAtOracle (see docs/developers/nusd.md). You may leave it out of this widget and link to the NUSD panel.

FLOW
1. Require a connected account. If the wallet chain id !== 4441, show "Switch to LiteForge" (switchChain, addChain if unknown) and disable the action.
2. Read factory.swapsPaused(); if true, show "Swaps paused" and disable.
3. Map "native" to WzkLTC for path building. Build candidates: [in, out]; [in, NUSD, out] if neither end is NUSD; [in, WzkLTC, out] if neither end is WzkLTC.
4. Debounce input (~300 ms). Quote each candidate with getAmountsOut; a revert (PairNotFound, InvalidPath, InsufficientLiquidity) just drops that candidate. Pick the largest last amount. If none: "No route".
5. minOut = quoted * (10000n - slippageBps) / 10000n. slippageBps default 50n, user-editable 1..500. Reject minOut === 0n.
6. deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60).
7. If the input is an ERC-20: read allowance(account, router). If < amountIn, simulate approve(router, amountIn), write it, wait for the receipt, require status "success", then continue.
8. Re-quote the chosen path right before sending and recompute minOut.
9. simulateContract with the exact account, args and value (value only for the native-in function). Show the decoded error name on revert and send nothing.
10. Check chain id 4441 again, writeContract(request), waitForTransactionReceipt({ hash }). Anything but receipt.status === "success" is a failure.
11. Refresh balances and the quote.

UI STATES
not connected | wrong network | swaps paused | loading quote | no route | quote ready (show route, expected out, minimum received, fee breakdown: LP 0.5% per hop + router 0.1% or 0.3%, slippage) | insufficient balance (leave gas when paying native) | needs approval | approving | awaiting signature | pending (link https://explorer.testnet.liteforge.zeeve.net/tx/<hash>) | success | reverted / error with the decoded error name. Disable the button while a transaction is in flight (no double submit).

DO NOT
- Do not call any /api/* or /0xFi/api/* route of the 0xNothing web app.
- Do not use the subgraph to size a transaction or compute minOut.
- Do not use an unlimited approval.
- Do not add a private key, mnemonic or API key anywhere.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Addresses come from the copied testnet.generated.json through getAddress; nothing is hard-coded; publicClient chain id 4441 is asserted.
[ ] Candidates include [in,out], [in,NUSD,out] and [in,WzkLTC,out]; failed quotes are skipped, not fatal.
[ ] Every write: chain check, fresh quote, non-zero minOut, deadline, allowance branch with receipt wait, simulateContract with the same account/args/value, writeContract, receipt status check.
[ ] Native in uses value and no approval; native out ends the path in WzkLTC.
[ ] All amounts are bigint; a grep for Number(, parseFloat, toFixed on amounts finds nothing.
[ ] Errors show the decoded custom error name.
[ ] A unit test covers minOut math (0 and 10000 bps bounds), best-route selection with a rejected candidate, and the native/ERC-20 function choice.
Cite the source file and line for every address, function signature and fee value you used.
```

## 2. Liquidity panel

```text
You are adding a 0xFi liquidity panel (add liquidity, remove liquidity, create pool) to my app.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. bigint for every amount; read decimals() live for each token (LP tokens are 18).

CHAIN
- LitVM LiteForge testnet, id 4441, native zkLTC (18 decimals).
- RPC: https://rpc.testnet.liteforge.zeeve.net (0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6). Explorer https://explorer.testnet.liteforge.zeeve.net.

ADDRESSES (load, do not hard-code)
- Copy 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json, getAddress() every value, assert publicClient.getChainId() === 4441. Keys: dexRouter, dexFactory, nusd, wzkltc.

ABI (copy; matches apps/web/features/fi/lib/abis/dex.ts:13-91, 0xFi/contracts/src/amm/ZeroXFiRouterV2.sol:62-101,151-245, ZeroXFiPair.sol, ZeroXFiFactoryV2.sol)
Router:
  struct AddLiquidityParams { address tokenA; address tokenB; uint256 amountADesired; uint256 amountBDesired; uint256 amountAMin; uint256 amountBMin; uint256 minimumLiquidity; address to; uint256 deadline; }
  struct AddLiquidityNativeParams { address token; uint256 amountTokenDesired; uint256 amountTokenMin; uint256 amountNativeMin; uint256 minimumLiquidity; address to; uint256 deadline; }
  struct RemoveLiquidityParams { address tokenA; address tokenB; uint256 liquidity; uint256 amountAMin; uint256 amountBMin; address to; uint256 deadline; }
  struct RemoveLiquidityNativeParams { address token; uint256 liquidity; uint256 amountTokenMin; uint256 amountNativeMin; address to; uint256 deadline; }
  function addLiquidity(AddLiquidityParams params) returns (uint256 amountA, uint256 amountB, uint256 liquidity)
  function addLiquidityNative(AddLiquidityNativeParams params) payable returns (uint256 amountToken, uint256 amountNative, uint256 liquidity)
  function removeLiquidity(RemoveLiquidityParams params) returns (uint256 amountA, uint256 amountB)
  function removeLiquidityNative(RemoveLiquidityNativeParams params) returns (uint256 amountToken, uint256 amountNative)
  function getReserves(address tokenA, address tokenB) view returns (uint256 reserveA, uint256 reserveB)
  error DeadlineExpired()
  error InsufficientAmount()
  error ExcessiveInputAmount()
  error InsufficientLiquidityMinted()
  error FeeOnTransferUnsupported()
Factory:
  function getPair(address tokenA, address tokenB) view returns (address pair)
  function createPair(address tokenA, address tokenB) returns (address pair)
  function isBaseToken(address token) view returns (bool)
  error BaseAssetRequired()
  error ProtectedPumpPair()
  error PairExists()
  error InvalidContract()
  error IdenticalTokens()
Pair (the LP token):
  function token0() view returns (address)
  function token1() view returns (address)
  function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
  function totalSupply() view returns (uint256)
  function balanceOf(address) view returns (uint256)
ERC-20: decimals, symbol, balanceOf, allowance, approve (standard signatures).

FACTS YOU MUST RESPECT
- Every pair must contain NUSD or WzkLTC (BaseAssetRequired). 0xPump tokens that are still in their bonding lifecycle cannot be paired with NUSD (ProtectedPumpPair).
- addLiquidity* creates the pair if it is missing. The FIRST deposit sets the price: show the implied price and require an explicit confirm. It must give sqrt(a*b) > 1000 (MINIMUM_LIQUIDITY 1000 is locked).
- For an existing pool, the second amount follows the reserves: amountB = amountA * reserveB / reserveA (router getReserves(tokenA, tokenB) returns reserves in the order you pass).
- expectedLiquidity = min(amountA * totalSupply / reserveA, amountB * totalSupply / reserveB). minimumLiquidity = expectedLiquidity * (10000n - slippageBps) / 10000n; on the first deposit pass 0n for minimumLiquidity only if you cannot compute it.
- Native side: use addLiquidityNative with value = native desired amount (unused part is refunded); removeLiquidityNative pays native zkLTC. The pair is token/WzkLTC.
- Approvals: each non-native token -> ROUTER for its desired amount. Removal: approve the PAIR (LP token) -> ROUTER for `liquidity`.
- Removal minimums: amountMin = (liquidity * reserve / totalSupply) * (10000n - slippageBps) / 10000n for each side.
- Default slippage 50 bps; deadline now + 20 minutes.

FLOW: ADD
1. Chain guard (wallet and public client on 4441). Validate both tokens and read decimals.
2. getPair; if it exists read getReserves + totalSupply; compute the paired amount and expectedLiquidity. If it does not exist, switch to the "new pool" state.
3. For each non-native token: allowance branch (approve exact amount, wait receipt, require success).
4. Re-read reserves right before sending and recompute amounts and minimums.
5. simulateContract addLiquidity / addLiquidityNative with the exact account, struct and value; writeContract; waitForTransactionReceipt; require status "success"; refresh.

FLOW: REMOVE
1. Chain guard. Read the user's LP balance, reserves and totalSupply. Let the user pick a percentage; liquidity = balance * pct / 100n.
2. Allowance branch on the pair address with spender = router.
3. Compute both minimums from fresh reserves, simulate removeLiquidity / removeLiquidityNative, write, wait, require success.

FLOW: CREATE POOL (optional explicit step)
- simulate + write factory.createPair(token, NUSD) (or WzkLTC), wait for the receipt, then continue with ADD. PairExists means skip to ADD.

UI STATES
not connected | wrong network | loading pool | new pool (price-setting warning + confirm) | existing pool (reserves, share of pool, expected LP, minimums) | insufficient balance | needs approval (per token) | approving | awaiting signature | pending (explorer link) | success | reverted / error with the decoded error name. No double submit.

DO NOT
- No /api/* or /0xFi/api/* calls, no subgraph-based amounts, no unlimited approvals, no secrets.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Addresses from the copied testnet.generated.json; chain id 4441 asserted on wallet and public client.
[ ] Ratio, expectedLiquidity and all minimums use bigint math from fresh reserves read right before simulate.
[ ] First-deposit path warns about price setting and needs confirmation.
[ ] Allowance branch per non-native token to the router; removal approves the pair to the router; each approval waits for a successful receipt.
[ ] Native variants use value only on addLiquidityNative.
[ ] Every write has deadline, simulateContract with the same account/args/value, and a receipt status check.
[ ] Unit tests cover paired-amount math, expectedLiquidity, minimums at 0/50/500 bps, and the native/ERC-20 function choice.
Cite the source file and line for every address, signature and constant you used.
```

## 3. Farm panel

```text
You are adding a 0xFi farm panel (stake LP tokens, claim NUSD rewards, withdraw) to my app.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. bigint everywhere (LP and NUSD are 18 decimals).

CHAIN
- LitVM LiteForge testnet, id 4441, native zkLTC. RPC https://rpc.testnet.liteforge.zeeve.net (apps/web/lib/publicConfig.ts:6).

ADDRESSES (load, do not hard-code)
- Copy 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json, getAddress() every value, assert chain id 4441. Keys: farmFactory (GaugeFactory), dexFactory, nusd, and the known pairs/gauges wzkLtcNusdPair/wzkLtcNusdGauge, nbtcNusdPair/nbtcNusdGauge, nethNusdPair/nethNusdGauge.
- For any other pair, resolve the gauge with GaugeFactory.gaugeForPair(pair); the zero address means "no farm".

ABI (copy; matches apps/web/features/fi/lib/abis/farm.ts:1-117, 0xFi/contracts/src/farming/GaugeFactory.sol, LiquidityGauge.sol)
GaugeFactory:
  function gaugeForPair(address lpToken) view returns (address gauge)
  function allGauges(uint256) view returns (address)
  function allGaugesLength() view returns (uint256)
LiquidityGauge:
  function stakingToken() view returns (address)
  function rewardRate() view returns (uint256)
  function periodFinish() view returns (uint256)
  function totalSupply() view returns (uint256)
  function balanceOf(address account) view returns (uint256)
  function earned(address account) view returns (uint256)
  function depositsPaused() view returns (bool)
  function stake(uint256 amount)
  function withdraw(uint256 amount)
  function getReward() returns (uint256 reward)
  event Staked(address indexed account, uint256 amount)
  event Withdrawn(address indexed account, uint256 amount)
  event RewardPaid(address indexed account, uint256 reward)
  error DepositsPaused()
  error InvalidAmount()
  error FeeOnTransferUnsupported()
ERC-20 (the pair is the LP token): balanceOf, allowance, approve.

FACTS YOU MUST RESPECT
- The staking token is the pair's LP token; the reward token is NUSD.
- rewardRate is NUSD wei per second. Rewards exist only while block.timestamp < periodFinish and only when governance has funded the gauge. Show APR as variable, and hide it when the period has ended or totalSupply is 0.
- Stake needs LP -> GAUGE approval for the amount. Withdraw and getReward need no approval. Withdraw more than the balance reverts InvalidAmount.
- Check stakingToken() equals the pair you expect before staking.

FLOW
1. Chain guard. Resolve the gauge; read stakingToken, depositsPaused, balanceOf, earned, rewardRate, periodFinish, totalSupply and the user's LP balance.
2. Stake: block if depositsPaused or amount is 0 or > LP balance. Allowance branch (pair -> gauge, exact amount, wait for a successful receipt). simulateContract stake(amount) with the account, writeContract, waitForTransactionReceipt, require status "success".
3. Claim: simulate getReward, write, wait, require success, show the RewardPaid amount from the receipt.
4. Withdraw: amount <= staked balance; simulate, write, wait, require success.
5. Refresh earned every new block or every ~10 s while visible.

UI STATES
not connected | wrong network | no farm for this pool | deposits paused | rewards ended | loading | ready (staked, earned, APR when valid) | needs approval | approving | awaiting signature | pending (explorer link) | success | error with the decoded error name. No double submit.

DO NOT
- No /api/* or /0xFi/api/* calls, no unlimited approvals, no secrets.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Gauge comes from the manifest or gaugeForPair; zero address handled; stakingToken checked.
[ ] Every write: chain check, fresh reads, allowance branch for stake only, simulateContract with the exact account, receipt status check.
[ ] APR shown only while periodFinish is in the future and totalSupply > 0, labelled variable.
[ ] bigint only; unit test for the APR guard and the stake amount bounds.
Cite the source file and line for every address and signature you used.
```

## 4. Lending and borrowing panel

```text
You are adding a 0xFi lending and borrowing panel to my app: supply/withdraw NUSD, deposit/withdraw collateral, borrow/repay NUSD.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. bigint for every amount (NUSD, WzkLTC, nBTC, nETH are 18 decimals; read decimals() live anyway).

CHAIN
- LitVM LiteForge testnet, id 4441, native zkLTC. RPC https://rpc.testnet.liteforge.zeeve.net (apps/web/lib/publicConfig.ts:6). Explorer https://explorer.testnet.liteforge.zeeve.net.

ADDRESSES (load, do not hard-code)
- Copy 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json, getAddress() every value, assert chain id 4441. Keys: lendingPool (PooledNUSDLendingPoolV2), nusd, wzkltc, nbtc, neth, ltcOracle, btcOracle, ethOracle.
- The live pool is 0x6Cc96c044321b3205Ac108107Fc6d2d47e0B3E44. 0x7CB638F8e10f1bd200A3c5C3fD014C3FD97BA914 is the retired v1 pool: never use it.

ABI (copy; matches apps/web/features/fi/lib/abis/lending.ts:5-199 and 0xFi/contracts/src/lending/PooledNUSDLendingPoolV2.sol)
Pool:
  function supply(uint256 amount, address onBehalfOf) returns (uint256 shares)
  function withdraw(uint256 amount, address recipient) returns (uint256)
  function depositCollateral(address asset, uint256 amount, address onBehalfOf)
  function withdrawCollateral(address asset, uint256 amount, address recipient)
  function borrow(uint256 amount, address recipient)
  function repay(uint256 amount, address onBehalfOf) returns (uint256 repaid)
  function healthFactor(address account) view returns (uint256)
  function accountRisk(address account) view returns (uint256 collateralValueNusd, uint256 borrowingCapacityNusd, uint256 marginCallCapacityNusd, uint256 liquidationCapacityNusd, uint256 debtNusd, uint256 currentLtvBps)
  function maxBorrow(address account) view returns (uint256)
  function maxWithdrawCollateral(address account, address asset) view returns (uint256)
  function collateralBalance(address account, address asset) view returns (uint256)
  function supplyBalance(address account) view returns (uint256)
  function maxWithdraw(address account) view returns (uint256)
  function debtBalance(address account) view returns (uint256)
  function availableLiquidity() view returns (uint256)
  function supplyRate() view returns (uint256)
  function borrowRate() view returns (uint256)
  function activated() view returns (bool)
  function supplyPaused() view returns (bool)
  function borrowPaused() view returns (bool)
  function collateralWithdrawalPaused() view returns (bool)
  error MarketNotActivated()
  error SupplyPaused()
  error BorrowPaused()
  error CollateralWithdrawalPaused()
  error SupplyCapExceeded()
  error BorrowCapExceeded()
  error CollateralCapExceeded()
  error InsufficientLiquidity()
  error InsufficientCollateral()
  error AccountHasBadDebt()
  error UnsupportedCollateral()
  error InvalidAmount()
  error InvalidRecipient()
  error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp)
WzkLTC:
  function deposit() payable
  function withdraw(uint256 amount)
OracleRouter (ltcOracle / btcOracle / ethOracle):
  function readPriceWad() view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId)
  function isFresh() view returns (bool)
ERC-20: decimals, symbol, balanceOf, allowance, approve.

FACTS YOU MUST RESPECT
- Fixed rates: borrow APR 4.5%, lender APR 4% on the utilized share, protocol 0.5% (PooledNUSDLendingPoolV2.sol:49-51). supplyRate/borrowRate are WAD-scaled annual fractions (1e18 = 100%).
- Caps: supply 5,000 NUSD, borrow 2,500 NUSD (0xFi/contracts/script/Deploy0xFiV3.s.sol:82-83). Collateral: WzkLTC (cap 50), nBTC (cap 0.01), nETH (cap 0.25); each LTV 80%, margin call 85%, liquidation 90%, bonus 5% (Deploy0xFiV3.s.sol:180-187).
- Risk is POOLED across all of an account's collateral assets: one borrowing capacity, one health factor. Do not present it as isolated per asset.
- healthFactor = liquidationCapacity * 1e18 / debt; type(uint256).max when there is no debt; at or below 1e18 (debt >= liquidationCapacity) is liquidatable (PooledNUSDLendingPoolV2.sol:547-552,666-671). Show "No debt" for max.
- Collateral is ERC-20 WzkLTC, NOT native zkLTC. Offer a separate "Wrap zkLTC" step: WzkLTC.deposit() with value. Unwrap with withdraw(amount).
- Approvals: NUSD -> pool for supply and repay; collateral token -> pool for depositCollateral. withdraw, borrow, withdrawCollateral need none.
- Repay: debt grows every second. To repay all, use cap = debt + debt / 1000n + 1n, approve the cap, and call repay(cap, account); the pool takes only the actual debt.
- A stale oracle makes debt-increasing and collateral-withdrawing actions revert; check isFresh() on the relevant oracle and disable those buttons.

FLOWS (each: chain guard, fresh reads, allowance branch when needed, simulateContract with the exact account/args/value, writeContract, waitForTransactionReceipt, require status "success", refresh)
- Supply NUSD: block if !activated, supplyPaused, amount > balance, or above the remaining supply cap. Approve NUSD -> pool. supply(amount, account).
- Withdraw NUSD: amount <= maxWithdraw(account) (also bounded by availableLiquidity). withdraw(amount, account).
- Deposit collateral: optional wrap step for WzkLTC; approve asset -> pool; depositCollateral(asset, amount, account).
- Withdraw collateral: amount <= maxWithdrawCollateral(account, asset); blocked by collateralWithdrawalPaused only while the account has debt. withdrawCollateral(asset, amount, account).
- Borrow: re-read maxBorrow(account) right before simulate; block if amount > maxBorrow, borrowPaused, oracle stale. borrow(amount, account). Show the projected health factor.
- Repay: read debtBalance; partial or "repay all" cap as above; approve NUSD -> pool; repay(amount, account).

UI STATES
not connected | wrong network | market not activated | paused (per action) | oracle stale | loading | ready (supplied, rates, collateral per asset, borrowing capacity, debt, health factor, current LTV) | cap reached | insufficient balance | needs wrap | needs approval | approving | awaiting signature | pending (explorer link) | success | error with the decoded error name. Show a warning when health factor < 1.1e18. No double submit.

DO NOT
- No /api/* or /0xFi/api/* calls, no subgraph data for amounts, no unlimited approvals, no secrets.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Pool address from the copied manifest (the v3 pool), chain id 4441 asserted.
[ ] Collateral uses WzkLTC with an explicit wrap step; no native value is sent to the pool.
[ ] Borrow is bounded by a fresh maxBorrow; collateral withdrawal by a fresh maxWithdrawCollateral; NUSD withdraw by maxWithdraw.
[ ] Each write: chain check, allowance branch with receipt wait where needed, simulateContract with the exact account, receipt status check.
[ ] Health factor handles type(uint256).max; risk is described as pooled across assets.
[ ] Oracle staleness and pause flags disable the matching buttons.
[ ] bigint only; unit tests for repay-all cap, health-factor formatting and max-borrow guard.
Cite the source file and line for every address, signature, rate and cap you used.
```

## 5. Synth panel

```text
You are adding a 0xFi synth panel to my app: mint nBTC or nETH against NUSD collateral, top up, repay and withdraw.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. bigint for every amount (NUSD 18 decimals; read nBTC/nETH decimals() live).

CHAIN
- LitVM LiteForge testnet, id 4441, native zkLTC. RPC https://rpc.testnet.liteforge.zeeve.net (apps/web/lib/publicConfig.ts:6).

ADDRESSES (load, do not hard-code)
- Copy 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json, getAddress() every value, assert chain id 4441. Keys: nbtcVault + nbtc + btcOracle, nethVault + neth + ethOracle, nusd, synthSafetyReserve.

ABI (copy; matches apps/web/features/fi/lib/abis/synth.ts:4-40 and 0xFi/contracts/src/synth/SyntheticVault.sol)
Vault:
  function depositCollateral(uint256 amountNusd, address onBehalfOf)
  function depositAndMint(uint256 collateralAmountNusd, uint256 syntheticAmount, uint256 maximumFeeNusd, address recipient)
  function mint(uint256 amountSynthetic, uint256 maximumFeeNusd, address recipient)
  function repay(uint256 maximumAmountSynthetic, address onBehalfOf) returns (uint256 amountRepaidSynthetic)
  function repayAndWithdraw(uint256 maximumRepaySynthetic, uint256 collateralAmountNusd, address recipient)
  function withdrawCollateral(uint256 amountNusd, address recipient)
  function position(address account) view returns (uint256 userCollateralNusd, uint256 reserveCollateralNusd, uint256 debtSynthetic, uint256 accountHealthFactorWad, uint256 maxWithdrawableNusd)
  function maxMintableSynthetic(address account) view returns (uint256)
  function quoteDepositAndMint(address account, uint256 userCollateralAmountNusd) view returns (uint256 syntheticAmount, uint256 reserveRequiredNusd, bool oneToOneAvailable)
  function quoteMintFee(uint256 amountSynthetic) view returns (uint256 feeNusd)
  function mintPaused() view returns (bool)
  function withdrawPaused() view returns (bool)
  function debtCeilingSynthetic() view returns (uint256)
  function totalDebtSynthetic() view returns (uint256)
  function activated() view returns (bool)
  error MarketNotActivated()
  error MintPaused()
  error WithdrawPaused()
  error MintFeeExceeded(uint256 feeNusd, uint256 maximumFeeNusd)
  error DebtCeilingExceeded()
  error InsufficientCollateral()
  error AccountHasBadDebt()
  error InvalidAmount()
  error InvalidRecipient()
  error ExactTransferRequired()
  error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp)
OracleRouter: readPriceWad(), isFresh() as in the lending prompt.
ERC-20: decimals, symbol, balanceOf, allowance, approve.

FACTS YOU MUST RESPECT
- The position is always msg.sender. Minimum collateral ratio 150%, liquidation 125% (SyntheticVault.sol:53-59).
- Mint fee: 10 bps of the minted value in NUSD, pulled from the wallet IN ADDITION to the collateral. It goes to the protocol fee splitter, not to a gauge.
- Debt ceilings: 0.01 nBTC and 0.25 nETH (Deploy0xFiV3.s.sol:80-81). Check totalDebtSynthetic + amount <= debtCeilingSynthetic.
- Safety-reserve sponsorship (oneToOneAvailable) is conditional; show the quoted amount, not a fixed ratio.
- Approvals: mint/top-up approve NUSD -> VAULT for collateral + maxFee. Repay approves the SYNTH token -> VAULT for the repay amount (the vault pulls, then burns).

FLOW: MINT (as the web app does, apps/web/features/fi/components/SynthWorkspace.tsx:120-232)
1. Chain guard; read activated, mintPaused, oracle isFresh, NUSD balance, position.
2. quoted = quoteDepositAndMint(account, collateralNusd).syntheticAmount. synthAmount = quoted * 9950n / 10000n (50 bps haircut). Reject 0n.
3. fee = quoteMintFee(synthAmount); maxFee = (fee * 10100n + 9999n) / 10000n (1% tolerance, rounded up).
4. Allowance branch: NUSD -> vault for collateralNusd + maxFee; wait for a successful receipt.
5. Re-quote right before sending. simulateContract depositAndMint(collateralNusd, synthAmount, maxFee, account) with the exact account; writeContract; waitForTransactionReceipt; require status "success".

FLOW: REPAY / WITHDRAW
- Repay: block when debt is 0 (InvalidAmount). Approve synth -> vault; simulate repay(amount, account); write; wait; require success.
- Withdraw: amount <= position.maxWithdrawableNusd; blocked when withdrawPaused; simulate withdrawCollateral(amount, account); write; wait; require success.
- Top up: approve NUSD -> vault; depositCollateral(amount, account).

UI STATES
not connected | wrong network | market not activated | mint paused | withdraw paused | oracle stale | debt ceiling reached | loading quote | quote ready (synth out, fee, max fee, collateral ratio, health factor) | insufficient NUSD (collateral + fee) | needs approval | approving | awaiting signature | pending (explorer link) | success | error with the decoded error name (MintFeeExceeded shows both values). No double submit.

DO NOT
- No /api/* or /0xFi/api/* calls, no unlimited approvals, no secrets.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Vault, synth and oracle addresses from the copied manifest; chain id 4441 asserted.
[ ] Haircut, fee tolerance and allowance totals are bigint and match the formulas above; unit-tested.
[ ] Mint approves NUSD for collateral + maxFee; repay approves the synth token.
[ ] Every write: chain check, fresh quote, simulateContract with the exact account, receipt status check.
[ ] Pause flags, oracle staleness and the debt ceiling disable the matching actions.
Cite the source file and line for every address, signature and constant you used.
```

## 6. Pool analytics

```text
You are adding read-only 0xFi pool analytics (price chart, recent swaps, liquidity events) to my app.

STACK
- Next.js (App Router) + TypeScript (strict). Fetch with plain fetch POST (or graphql-request). Treat every BigInt/BigDecimal field as a string and convert with BigInt() or a decimal library; never Number() on raw token amounts.

DATA SOURCE
- Public Goldsky subgraph: https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxfi-testnet/1.0.0/gn
- Load it from the `goldskyEndpoint` key of a copy of 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json. Its data sources start at blocks 61141544 (factory) to 61141614 (lending pool) (0xFi/subgraph/subgraph.yaml:13,34,55,104,153); nothing 0xFi v3 exists before `deploymentBlock` 61141359.
- Schema: 0xNothing-zkLTC-Testnet/0xFi/subgraph/schema.graphql (entities Pool, Swap, LiquidityEvent, Candle, Gauge, LendingMarket, SyntheticMarket).

FACTS YOU MUST RESPECT
- Pool.id is the pair address in lowercase hex. price0 = token1 per token0, decimal-adjusted.
- Candle periods are 60, 300, 3600, 14400, 86400 seconds; bucket = floor(timestamp / period) * period (0xFi/subgraph/src/pair.ts:6,159-160). Candle price is price1 when token0 equals the mapping's NUSD constant, else price0 (pair.ts:82).
- Swap.sender is always the router; filter a wallet's swaps by `recipient`.
- WARNING: the mapping source hard-codes the retired v1 NUSD 0x5317e21aba902c6c7087a84457bc02ffe99604d1 (pair.ts:5, lending.ts:20), not the v3 NUSD in the manifest. Built from this source, v3 pools report Swap.amountNusd = 0, volumeNusd fields that never grow, and candle price = price0 regardless of which side NUSD is on. Verify against RPC before showing NUSD volume; if it is zero, compute NUSD volume from amount0In/1In/0Out/1Out and the pool's token0/token1 against the manifest's nusd, and orient the price yourself.
- The subgraph lags the chain. Use it for history and charts only, never for quotes, minimums or balances that size a transaction.

QUERY
query PoolChart($pool: Bytes!, $since: BigInt!) {
  pool(id: $pool) {
    id reserve0 reserve1 price0 price1 volumeNusd
    token0 { id symbol decimals } token1 { id symbol decimals }
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
}

UI STATES
loading | empty (no pool or no candles yet) | ready (chart with period selector, swaps table with explorer links https://explorer.testnet.liteforge.zeeve.net/tx/<hash>, liquidity events) | subgraph error (show a retry; do not block the rest of the page) | stale (show the latest indexed timestamp).

DO NOT
- No /api/* or /0xFi/api/* calls of the 0xNothing web app, no API keys (the endpoint is public), no subgraph values passed into contract writes.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Endpoint comes from the copied manifest; pool ids are lowercased.
[ ] Amounts are formatted with each token's decimals from the query, as bigint/decimal strings.
[ ] Wallet filters use recipient, not sender.
[ ] Errors and empty states render without breaking the page.
[ ] A unit test covers candle bucket math and amount formatting.
Cite the schema.graphql line for every field you used.
```
