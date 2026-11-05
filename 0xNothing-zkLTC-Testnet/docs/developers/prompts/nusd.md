# NUSD prompts for AI coding agents

Ready-to-paste prompts for Claude Code, Cursor, Codex and similar agents. Each
prompt is self-contained: paste one, fill in the `<placeholders>`, and give the
agent read access to this repository (or copy the files the prompt names into
your project). The full reference is [../nusd.md](../nusd.md).

| Prompt | Builds |
| --- | --- |
| [1. Mint and redeem panel](#1-mint-and-redeem-panel) | zkLTC -> NUSD mint and NUSD -> zkLTC redeem at the oracle price |
| [2. Emergency exit panel](#2-emergency-exit-panel) | Report an oracle failure and the price-free pro-rata exit |
| [3. Earn panel](#3-earn-panel) | Stake NUSD in `RewardStaking`, claim or restake rewards, withdraw matured positions |
| [4. NUSD stats and history](#4-nusd-stats-and-history) | Read-only backing, price, supply and event history |

Review what the agent produces with the checklist in
[../README.md](../README.md#using-an-ai-coding-agent) before you use real funds.

## 1. Mint and redeem panel

```text
You are adding an NUSD mint and redeem panel to my app.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. <my wallet connector, e.g. RainbowKit / ConnectKit / injected>.
- All token amounts are bigint in base units (18 decimals). Never use Number, parseFloat, toFixed or `* 10 **` on amounts. Parse with parseUnits/parseEther, format with formatUnits.

CHAIN
- LitVM LiteForge testnet: id 4441, native currency zkLTC (18 decimals).
- RPC HTTP: https://liteforge.rpc.caldera.xyz/infra-partner-http, fallback https://liteforge.rpc.caldera.xyz/http.
- RPC WS: wss://liteforge.rpc.caldera.xyz/infra-partner-ws, fallback wss://liteforge.rpc.caldera.xyz/ws.
- Source: 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6-12. Define the chain with viem defineChain and a fallback() transport.

ADDRESSES (load, do not hard-code)
- Read 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json at build time (copy it into the project as a JSON module). Assert chainId === 4441. Use keys:
  - nusd       -> NUSD token and mint/redeem contract (OracleNUSDv2)
  - ltcOracle  -> LTC/USD OracleRouter
- On load, read nusd.oracle() and fail closed if it differs from ltcOracle.

ABI (copy these fragments; they match apps/web/features/pump/abis.ts:68-96 and the Solidity in contracts/src/nusd/OracleNUSDv2.sol and contracts/src/nusd/DIAOracleAdapter.sol)
NUSD:
  function balanceOf(address account) view returns (uint256)
  function totalSupply() view returns (uint256)
  function oracle() view returns (address)
  function mintPaused() view returns (bool)
  function backingRatioWad() view returns (uint256)
  function supplyCeilingNusd() view returns (uint256)
  function quoteMint(uint256 collateralWei) view returns (uint256 amountNusd)
  function mintAtOracle(uint256 minNusdOut, address recipient) payable returns (uint256 amountNusd)
  function quoteRedeem(uint256 amountNusd) view returns (uint256 collateralOutWei)
  function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256 collateralOutWei)
  event MintedAtOracle(address indexed payer, address indexed recipient, uint256 collateralInWei, uint256 amountNusd)
  event RedeemedAtOracle(address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei)
  error MintPaused()
  error InvalidAmount()
  error InvalidRecipient()
  error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount)
  error SupplyCeilingExceeded(uint256 requestedAmountNusd, uint256 availableAmountNusd)
  error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount)
  error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp)
  error InvalidOracleAnswer()
  error IncompleteOracleRound()
  error FutureOracleTimestamp()
OracleRouter:
  function readPriceWad() view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId)
  function isFresh() view returns (bool)

FACTS YOU MUST RESPECT
- Mint pays native zkLTC as `value` to mintAtOracle. No ERC-20 approval. NEVER send a plain zkLTC transfer to the NUSD address: receive() books it as a reserve donation and mints nothing.
- Redeem needs NO approval: redeemAtOracle burns from msg.sender.
- Redeem pays min(oracle price, pro-rata share of the reserve). Backing can be below 1 (it was ~0.91 on 2026-11-05 and moves with the LTC price), so show the quoted zkLTC, never "1 NUSD = 1 USD guaranteed".
- Admins cannot pause redeem, but quoteRedeem and redeemAtOracle REVERT while the DIA price is stale (older than 90 minutes). Catch that revert (StaleOraclePrice or the other oracle errors) and show "Price feed is stale - use the emergency exit" with a link to the emergency panel.
- Mint can be paused (mintPaused()). Mint also reverts on a stale price and above the supply ceiling.
- Prices are WAD (1e18 = 1 USD). Fees are 0 today but read them from the quote, do not assume.

FLOW: MINT
1. Require a connected account. If chainId !== 4441, show a "Switch to LiteForge" button (switchChain, then addChain if unknown) and disable the action.
2. Read mintPaused(), oracle(), router.isFresh(), the account's zkLTC balance. Block with a clear message if paused or not fresh, or if amount > balance (leave gas).
3. Debounce input (~300 ms), then read quoteMint(amountWei). Re-read the quote right before sending.
4. minNusdOut = quote * (10000n - slippageBps) / 10000n, slippageBps default 50n (0.5%), user-editable 1..500. Never 0.
5. simulateContract({ account, address: nusd, abi, functionName: "mintAtOracle", args: [minNusdOut, account], value: amountWei }).
6. Check the chain id again, writeContract(request), then waitForTransactionReceipt({ hash }). Treat anything but receipt.status === "success" as failure.
7. Decode MintedAtOracle from the receipt, show the minted amount, refresh balances.

FLOW: REDEEM
1. Same chain guard. Read NUSD balanceOf(account); block if amount > balance.
2. Read quoteRedeem(amountNusd). If it reverts with an oracle error, switch to the stale-price state. If it returns 0, show "amount too small".
3. minCollateralOutWei = quote * (10000n - slippageBps) / 10000n.
4. simulateContract redeemAtOracle(amountNusd, minCollateralOutWei, account) with the exact account. No value, no approval.
5. writeContract, waitForTransactionReceipt, require status "success", decode RedeemedAtOracle, refresh.

UI STATES
not connected | wrong network | loading quote | quote ready (show rate, min received, slippage, backing ratio) | mint paused | price stale | insufficient balance | above supply ceiling (show available from SupplyCeilingExceeded) | awaiting signature | pending (link https://liteforge.explorer.caldera.xyz/tx/<hash>) | success | reverted / error with the decoded error name. Disable the button while a transaction is in flight (no double submit).

DO NOT
- Do not call any /api/* or /0xFi/api/* route of the 0xNothing web app.
- Do not use a subgraph to size a transaction.
- Do not add a private key, mnemonic or API key anywhere.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Addresses come from v3-core.json; chainId and nusd.oracle() === ltcOracle are asserted.
[ ] Every write is preceded by a chain-id 4441 check, a fresh quote, a non-zero min-out, and simulateContract with the same account/args/value.
[ ] Mint uses mintAtOracle with value; there is no plain zkLTC transfer anywhere.
[ ] Redeem has no approve call.
[ ] Stale-oracle revert on redeem is caught and routed to the emergency exit.
[ ] receipt.status === "success" is required before showing success.
[ ] All amounts are bigint; a grep for Number(, parseFloat, toFixed on amounts finds nothing.
[ ] Errors show the decoded custom error name.
[ ] A unit test covers minOut math (including 0 and 10000 bps bounds) and the stale-oracle branch with a mocked revert.
Cite the source file and line for every address, function signature and decimals value you used.
```

## 2. Emergency exit panel

```text
You are adding the NUSD emergency exit panel to my app. It is only used when the NUSD price oracle has stopped working.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. bigint for every amount (18 decimals).

CHAIN
- LitVM LiteForge testnet, id 4441, native zkLTC (18 decimals).
- RPC: https://liteforge.rpc.caldera.xyz/infra-partner-http, fallback https://liteforge.rpc.caldera.xyz/http (0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6-8).

ADDRESSES
- Load 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json, assert chainId 4441, use `nusd` and `ltcOracle`. Do not hard-code.

ABI (copy; matches apps/web/features/pump/components/NusdEmergencyPanel.tsx:13-23 and contracts/src/nusd/OracleNUSDv2.sol:225-265)
NUSD:
  function balanceOf(address account) view returns (uint256)
  function totalSupply() view returns (uint256)
  function totalCollateralWei() view returns (uint256)
  function oracleFailureReportedAt() view returns (uint256)
  function ORACLE_FAILURE_GRACE() view returns (uint256)
  function reportOracleFailure()
  function clearOracleFailure()
  function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256)
  event OracleFailureReported(address indexed reporter, uint256 reportedAt)
  event EmergencyRedeemed(address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei)
  error OracleHealthy()
  error OracleUnavailable()
  error OracleFailureNotReported()
  error OracleFailureGracePending(uint256 availableAt)
  error InvalidAmount()
  error InvalidRecipient()
  error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount)
OracleRouter:
  function isFresh() view returns (bool)

RULES (from the contract)
- The oracle is unusable when the router's readPriceWad() reverts or returns 0 (for example a DIA price older than 90 minutes, or an invalid round). router.isFresh() returns exactly this check as a bool.
- reportOracleFailure() is permissionless; reverts OracleHealthy() while the price works; no-op if already reported.
- clearOracleFailure() is permissionless; reverts OracleUnavailable() while the price is still broken.
- emergencyRedeem opens at oracleFailureReportedAt() + ORACLE_FAILURE_GRACE() (7 days) and only while the oracle is still unusable. It pays amountNusd * totalCollateralWei / totalSupply, no fee, no price, no approval.

FLOW
1. Chain guard (4441) as in every write. Read reportedAt, grace, router.isFresh(), latest block timestamp (use block time, not Date.now()).
2. isFresh() === true -> show "Oracle healthy, use normal redeem" and, if reportedAt > 0, a "Clear failure report" button (simulate + write clearOracleFailure()).
3. isFresh() === false and reportedAt === 0 -> "Report oracle failure" button: simulateContract reportOracleFailure() with the account, writeContract, wait for receipt, require status "success". Then show opensAt = reportedAt + grace as a date and a countdown.
4. Reported and block.timestamp < opensAt -> countdown state.
5. Reported, grace passed, still not fresh -> amount input. Read balance, totalSupply, totalCollateralWei fresh. quote = amount * reserve / supply. minOut = quote * (10000n - slippageBps) / 10000n (default 50n). simulateContract emergencyRedeem(amount, minOut, account), writeContract, waitForTransactionReceipt, require "success", decode EmergencyRedeemed.

UI STATES
not connected | wrong network | oracle healthy | failure not reported | reported, waiting (countdown to opensAt) | exit open (amount, quote, min received) | awaiting signature | pending (explorer link https://liteforge.explorer.caldera.xyz/tx/<hash>) | success | error with decoded name (show availableAt from OracleFailureGracePending as a date).

DO NOT
- No /api/* routes of the 0xNothing web app, no subgraph data for amounts, no secrets.

ACCEPTANCE CHECKLIST
[ ] Addresses loaded from v3-core.json with chainId asserted.
[ ] Each of the three writes: chain check, simulateContract with the exact account/args, writeContract, receipt status check.
[ ] Exit amount uses a fresh pro-rata quote and a non-zero min-out.
[ ] No approve call anywhere in this panel.
[ ] Time checks use the latest block timestamp.
[ ] bigint everywhere; unit tests cover the quote/min-out math and each state transition.
Cite file:line for every signature and constant you used.
```

## 3. Earn panel

```text
You are adding the NUSD Earn panel (RewardStaking) to my app: stake NUSD with a lock, accrue 0xPoints, claim or restake NUSD rewards, withdraw matured positions.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. bigint for every amount (NUSD has 18 decimals).

CHAIN
- LitVM LiteForge testnet, id 4441, native zkLTC (18 decimals).
- RPC: https://liteforge.rpc.caldera.xyz/infra-partner-http, fallback https://liteforge.rpc.caldera.xyz/http (0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6-8).

ADDRESSES
- Load 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json, assert chainId 4441, use keys `nusd` and `rewardStaking`. Do not hard-code. Do NOT use `nusdPointsStaking` from 0xFi/contracts/deployments/latest.json: that is the retired v1 xPoints module.
- On load, read rewardStaking.nusd() and fail closed if it differs from `nusd`.

ABI (copy; matches apps/web/features/fi/lib/abis/tokenomics.ts:7-31 and contracts/src/rewards/RewardStaking.sol)
NUSD (ERC-20):
  function balanceOf(address account) view returns (uint256)
  function allowance(address owner, address spender) view returns (uint256)
  function approve(address spender, uint256 amount) returns (bool)
  error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount)
  error ERC20InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requiredAmount)
RewardStaking:
  function nusd() view returns (address)
  function accountState(address user) view returns (uint256 weight, uint256 points, uint256 claimable)
  function positionIdsOf(address user) view returns (uint256[])
  function getPosition(uint256 positionId) view returns ((address account, uint64 unlockTime, uint32 lockDuration, bool withdrawn, uint256 amount, uint256 weight))
  function totalWeight() view returns (uint256)
  function rewardRate() view returns (uint256)
  function periodFinish() view returns (uint64)
  function stake(uint256 amount, uint32 lockDuration) returns (uint256 positionId)
  function withdraw(uint256 positionId)
  function claim(address recipient) returns (uint256 amount)
  function claimAndStake(uint32 lockDuration) returns (uint256 positionId)
  event Staked(uint256 indexed positionId, address indexed account, uint256 amount, uint256 weight, uint32 lockDuration, uint64 unlockTime)
  event Withdrawn(uint256 indexed positionId, address indexed account, uint256 amount)
  event RewardClaimed(address indexed account, address indexed recipient, uint256 amount)
  event RewardRestaked(address indexed account, uint256 indexed positionId, uint256 amount)
  error InvalidAmount()
  error InvalidLockDuration()
  error UnknownPosition()
  error NotPositionOwner()
  error AlreadyWithdrawn()
  error PositionLocked(uint256 unlockTime)
  error NothingToClaim()
  error InvalidRecipient()
  error NonExactTransfer()

FACTS YOU MUST RESPECT
- lockDuration must be EXACTLY one of: 2592000 (30 d, x1, multiplierBps 10000), 7776000 (90 d, x1.2, 12000), 15552000 (180 d, x1.5, 15000), 31536000 (365 d, x3, 30000). Anything else reverts InvalidLockDuration(). Offer only these four.
- weight = amount * multiplierBps / 10000. 0xPoints accrue every second as weight x seconds; they are lifetime and never spent or redeemed. Display accountState(user).points / 86400n formatted with 18 decimals ("0xPoints" = 1 NUSD of weighted stake for one day). 100 NUSD on a 30-day lock earns 100 0xPoints per day.
- Rewards are NUSD streamed over 7 days pro rata to weight. claimable comes from accountState. There is no point redemption and no voucher.
- RewardStaking has no admin and no pause. withdraw works any time after unlockTime.
- stake/claim/claimAndStake run a fee harvest internally: let viem/wallet estimate gas, never set a low manual gas limit.

FLOW: STAKE
1. Chain guard (4441). Validate amount > 0, amount <= NUSD balance, lock in the list.
2. Read allowance(account, rewardStaking). If allowance < amount: simulate + write approve(rewardStaking, amount) for the EXACT amount (never max uint), wait for the receipt, require "success", then re-read the allowance.
3. simulateContract stake(amount, lockDuration) with the account, writeContract, waitForTransactionReceipt, require "success".
4. Decode Staked for positionId and unlockTime; refresh positions and accountState.

FLOW: CLAIM / RESTAKE
1. Chain guard. Read accountState(account). If claimable === 0n, disable the buttons ("Nothing to claim yet").
2. Claim: simulate + write claim(account). Restake: simulate + write claimAndStake(lockDuration) with a valid lock.
3. Wait for the receipt, require "success", refresh.

FLOW: WITHDRAW
1. Chain guard. List positionIdsOf(account), then getPosition(id) for each (batch with multicall).
2. A position is withdrawable when account matches, !withdrawn, and the LATEST BLOCK timestamp >= unlockTime.
3. simulate + write withdraw(positionId), wait, require "success", refresh.

UI STATES
not connected | wrong network | loading | no positions | position list (amount, lock, multiplier, unlock date in UTC, Locked/Matured/Withdrawn) | needs approval -> approving (pending) -> approved | staking pending | claim available / nothing to claim | awaiting signature | pending (explorer link https://liteforge.explorer.caldera.xyz/tx/<hash>) | success | error with decoded name (show PositionLocked unlockTime as a date). Disable buttons while any transaction is in flight.

DO NOT
- No /api/* or /0xFi/api/* routes of the 0xNothing web app. No subgraph (none indexes RewardStaking). No secrets.

ACCEPTANCE CHECKLIST
[ ] Addresses loaded from v3-core.json; chainId and rewardStaking.nusd() === nusd asserted; the v1 xPoints contract is not referenced.
[ ] Approval is exact-amount, only when allowance < amount, and its receipt is confirmed before stake is simulated.
[ ] Every write: chain check, simulateContract with exact account/args, writeContract, receipt status === "success".
[ ] Only the four lock durations can be sent.
[ ] 0xPoints display = points / 86400n at 18 decimals; no floating point.
[ ] Withdraw eligibility uses block time.
[ ] No hard-coded gas limit.
[ ] Unit tests cover lock validation, weight math, the allowance branch, and withdraw eligibility.
Cite file:line for every address, signature and constant you used.
```

## 4. NUSD stats and history

```text
You are adding a read-only NUSD stats and history view to my app. It sends no transactions.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2. bigint for every amount; format with formatUnits(value, 18).

CHAIN
- LitVM LiteForge testnet, id 4441. RPC https://liteforge.rpc.caldera.xyz/infra-partner-http with fallback https://liteforge.rpc.caldera.xyz/http; WS wss://liteforge.rpc.caldera.xyz/infra-partner-ws then wss://liteforge.rpc.caldera.xyz/ws (0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6-12).

ADDRESSES
- Load 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json (assert chainId 4441): `nusd`, `ltcOracle`, `rewardStaking`, `scriptBlock` (first block for log scans, 61141328).
- Load 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json: `wzkLtcNusdPair`, `goldskyEndpoint`.

ABI (copy from 0xNothing-zkLTC-Testnet/docs/developers/nusd.md "Shared setup")
NUSD views: totalSupply, totalCollateralWei, reserveValueNusd, backingRatioWad, supplyCeilingNusd, mintPaused, oracleFailureReportedAt, quoteMint, quoteRedeem; events MintedAtOracle, RedeemedAtOracle, EmergencyRedeemed, OracleFailureReported.
OracleRouter: readPriceWad() returns (uint256 priceWad, uint256 updatedAt, uint80 roundId), isFresh().
RewardStaking: totalWeight, totalPrincipal, rewardRate, periodFinish (uint64), queuedRewards; events Staked, Withdrawn, RewardClaimed, RewardsQueued.

WHAT TO SHOW
- LTC/USD price (priceWad / 1e18) with its age (now - updatedAt; flag stale when isFresh() is false or age > 90 min). Wrap readPriceWad in try/catch: it reverts when the price is stale.
- Supply, reserve (zkLTC), reserve value (NUSD), backing ratio (backingRatioWad / 1e18; it is max uint256 while supply is 0 - show "n/a"), supply ceiling and % used, mint paused flag, oracle-failure reported flag.
- Earn: total principal, total weight, reward rate per day (rewardRate * 86400n), stream end (periodFinish).
- History: MintedAtOracle / RedeemedAtOracle / EmergencyRedeemed via getContractEvents from scriptBlock, paged in block chunks (start with 50,000; halve on a range error). Optionally keep it live with watchContractEvent over the WS client, then RE-READ state from RPC after each event (never use the event payload as state). Keep a ~10 s polling fallback when the socket is down.
- Market: WzkLTC/NUSD pool from the 0xFi subgraph (POST GraphQL to goldskyEndpoint). Pool id is the lower-case pair address; token0 is NUSD. Query pool { reserve0 reserve1 price0 price1 } and swaps { amount0In amount1In amount0Out amount1Out timestamp txHash }.
- KNOWN SUBGRAPH LIMITATION: Swap.amountNusd, Pool.volumeNusd, Candle.volumeNusd and Protocol.totalVolumeNusd read 0 for v3 pools, and the candle price for this pool is WzkLTC per NUSD. Compute NUSD volume from amount0In/amount0Out instead and label the subgraph as delayed history.

UI STATES
loading | live | stale price (warning banner) | RPC error with retry | subgraph unavailable (hide market panel, keep RPC stats).

DO NOT
- No /api/* or /0xFi/api/* routes of the 0xNothing web app. No secrets. No writes.

ACCEPTANCE CHECKLIST
[ ] All addresses and the start block come from the manifests.
[ ] Price reads survive a revert and show the stale state.
[ ] Log scans are chunked and start at scriptBlock.
[ ] State is re-read from RPC after every live event.
[ ] The known-bad subgraph fields are not displayed.
[ ] bigint math only; formatting at the edge.
Cite file:line for every address and signature you used.
```
