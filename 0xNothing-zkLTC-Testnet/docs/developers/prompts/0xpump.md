# 0xPump prompts for AI coding agents

Ready-to-paste prompts for Claude Code, Cursor, Codex and similar agents. Each
prompt is self-contained. Paste one into the agent in your own project, with
this repository (or at least the files each prompt names) available to read.

The facts in these prompts come from [../0xpump.md](../0xpump.md). Read that
guide before you review the agent's output, and follow the review list in
[../README.md](../README.md#using-an-ai-coding-agent).

| Prompt | Builds |
| --- | --- |
| [1. Market explorer](#1-market-explorer-read-only) | Market list, market page with price, progress, trades and candles |
| [2. Buy and sell widget](#2-buy-and-sell-widget) | Curve trade panel with quotes, slippage, approval and receipts |
| [3. Token launch form](#3-token-launch-form) | Two-step create flow (reserve, then create) with recovery |
| [4. Graduation button](#4-graduation-button) | Permissionless graduation of a READY market into 0xFi |

Paths in the prompts are relative to `0xNothing-zkLTC-Testnet/`. Adjust them if
you copied the files elsewhere.

## 1. Market explorer (read-only)

```text
You are adding a read-only 0xPump market explorer to a Next.js (App Router) + TypeScript app that uses viem and wagmi. 0xPump is a NUSD bonding-curve launchpad on the LitVM LiteForge testnet.

Network (define it with viem defineChain):
- id 4441, name "LitVM LiteForge", native currency zkLTC (18 decimals).
- HTTP RPC: https://rpc.testnet.liteforge.zeeve.net (from apps/web/lib/publicConfig.ts:6). Use viem fallback().
- Explorer: https://explorer.testnet.liteforge.zeeve.net. Multicall3: 0xca11bde05977b3631167028862be2a173976ca11 (set contracts.multicall3 on the chain).

Addresses: copy apps/web/features/fi/config/testnet.generated.json into the project and read keys `pump` (ZeroXPumpV2), `nusd`, `pumpGoldskyEndpoint` and `deploymentBlock` from it. Pass addresses through getAddress. Do not hard-code addresses anywhere else.

ABI: copy these fragments from docs/developers/0xpump.md section "ABI" (they match apps/web/features/pump/abis.ts, with createFee/tradeFeeBps as view, createFee returning uint128, marketParams added, and the custom errors included): markets, marketParams, status, spotPriceNusdWad, curveProgressBps, getAllTokens, totalMarkets, paused, and the PumpToken name/symbol/decimals/totalSupply/imageURI/metadataURI. Build them with parseAbi so types are inferred.

Data rules:
- Lists, trade history and candles come from the public Goldsky subgraph at manifest key pumpGoldskyEndpoint (GraphQL POST). Schema: subgraphs/0xpump/schema.graphql. MarketStatus values are CURVE, READY, GRADUATED; CURVE is the contract's TRADING.
- The market page header (status, price, progress, reserves, fee, target) is read over RPC: first markets(token) alone (it never reverts), then, only if lifecycle !== 0, one multicall of marketParams(token), spotPriceNusdWad(token), curveProgressBps(token), token totalSupply(). spotPriceNusdWad and curveProgressBps revert MarketNotFound() for an unknown token (contracts/src/pump/ZeroXPumpV2.sol:473-481, 672-675).
- markets(token) returns lifecycle at index 7: 0 NONE (not a market, show "not found"), 1 TRADING, 2 READY, 3 GRADUATED. When GRADUATED, show a link to the 0xFi pool at markets(token).pool.
- Price is WAD: NUSD per whole token scaled 1e18. Market cap = spotPriceNusdWad * totalSupply / 1e18. Show fee as marketParams(token).tradeFeeBps / 100 percent, and progress as curveProgressBps / 100 percent. Per-market terms come from marketParams, never from tradeFeeBps() or constants.
- All amounts are bigint; format with formatUnits(x, 18). Subgraph BigInt fields arrive as strings: use BigInt(s). Never use Number or parseFloat on amounts.
- Show subgraph freshness with _meta { block { number } } and compare it to the RPC block number; label data as delayed when it lags by more than ~100 blocks.
- Only render a token logo when imageURI starts with ipfs:// and the CID is valid (see normalizePumpIpfsPath in apps/web/features/pump/config.ts); resolve through a public IPFS gateway.
- Do not call any /api/* or /0xFi/api/* route of the 0xNothing web app; they are internal.

Build:
1. lib/pump/chain.ts, lib/pump/addresses.ts, lib/pump/abi.ts, lib/pump/subgraph.ts (typed fetch helper that throws on HTTP errors and GraphQL errors).
2. /pump page: protocol totals (protocol(id:"global")), a paged table of markets (first/skip, orderBy createdAt desc), filter by status (CURVE/READY/GRADUATED), search by name or symbol.
3. /pump/[token] page: RPC header as above, a candle chart from candles (period 1/15/60/240/1440 minutes, bucket in seconds, ordered by bucket asc), and the last 50 trades (side, trader, tokenAmount, userNusdAmount, feeNusd, timestamp, link txHash to the explorer).
4. Refresh the RPC header every ~10 s and after the user returns to the tab.

UI states: loading skeletons, empty list, market not found (lifecycle 0 or invalid address), subgraph unavailable (show RPC header anyway, hide history with a message), RPC error with retry, delayed-index badge.

Acceptance checklist (verify each item and report file:line for it):
- [ ] Chain id 4441 and both RPC URLs come from the chain definition; no other RPC URL is used.
- [ ] Every address is read from the copied manifest via getAddress.
- [ ] marketParams is used for fee and targets.
- [ ] No floating-point math on amounts; all formatting via formatUnits.
- [ ] Status mapping 0/1/2/3 and CURVE=TRADING is implemented in one place.
- [ ] Subgraph failure does not break the RPC header.
- [ ] No /api/* calls, no secrets, no API keys.
- [ ] npm run build and the TypeScript check pass.
```

## 2. Buy and sell widget

```text
You are building a 0xPump buy/sell panel in a Next.js + TypeScript app with viem and wagmi. 0xPump (ZeroXPumpV2) sells a token along a NUSD bonding curve on the LitVM LiteForge testnet.

Network: viem defineChain with id 4441, name "LitVM LiteForge", native currency zkLTC (18 decimals), HTTP RPC https://rpc.testnet.liteforge.zeeve.net (apps/web/lib/publicConfig.ts:6), explorer https://explorer.testnet.liteforge.zeeve.net.

Addresses: copy apps/web/features/fi/config/testnet.generated.json and read `pump` (the launchpad and the ERC-20 spender) and `nusd` (NUSD, 18 decimals). Use getAddress. No other hard-coded addresses.

ABI: copy from docs/developers/0xpump.md section "ABI": markets, marketParams, paused, quoteBuy, quoteSell, buy, sell, the TokenTraded/TokenReadyForGraduation/TokenCurveReopened events, all ZeroXPumpV2 custom errors (ContractPaused, DeadlineExpired, MarketNotFound, MarketNotTrading, InvalidAmount, SlippageExceeded, AssetTransferMismatch, ...), and pumpTokenAbi (balanceOf, allowance, approve, decimals, plus ERC20InsufficientBalance/ERC20InsufficientAllowance/ERC20InvalidAddress). For NUSD use viem's erc20Abi. Exact signatures:
- quoteBuy(address token,uint256 maxNusdIn) view returns (uint256 tokenOut,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,bool readyAfter)
- quoteSell(address token,uint256 tokenIn) view returns (uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd)
- buy(address token,uint256 maxNusdIn,uint256 minTokenOut,uint256 deadline) returns (uint256 tokenOut,uint256 userNusdAmount)
- sell(address token,uint256 tokenIn,uint256 minNusdOut,uint256 deadline) returns (uint256 userNusdAmount)
Neither function is payable.

Rules for BUY (NUSD -> token):
1. Require the wallet chain id to be 4441; offer switchChain (and addChain if unknown) otherwise. Re-check right before every write.
2. Read markets(token) (lifecycle at index 7) and paused(). Buy only when lifecycle === 1 (TRADING) and not paused.
3. Parse the input with parseUnits(input, 18). Read quoteBuy(token, amount) fresh (debounce ~300 ms while typing, and again right before sending). Reject tokenOut == 0.
4. Show: tokens out (tokenOut), NUSD actually spent (userNusdAmount, which can be less than the input near the graduation target: say so), fee (feeNusd), and a "this buy completes the curve" note when readyAfter is true.
5. minTokenOut = tokenOut * (10000 - slippageBps) / 10000 with bigint math. Slippage choices 50 / 100 / 200 bps, default 100.
6. Check NUSD balanceOf >= userNusdAmount. If NUSD allowance(account, pump) < userNusdAmount: simulate and send approve(pump, userNusdAmount) (exact amount, not unlimited), wait for the receipt, require status "success".
7. deadline = BigInt(Math.floor(Date.now()/1000)) + 1200n (20 minutes).
8. simulateContract buy(token, userNusdAmount, minTokenOut, deadline) with the connected account, then writeContract(request), then waitForTransactionReceipt and require status "success".
Rules for SELL (token -> NUSD):
1. Same chain check. Sell when lifecycle is 1 (TRADING) or 2 (READY). Selling works while paused. A sell from READY reopens the curve: tell the user.
2. quoteSell(token, tokenIn) fresh; output = userNusdAmount, fee = feeNusd; reject userNusdAmount == 0.
3. minNusdOut from userNusdAmount with the same slippage math.
4. Check token balanceOf >= tokenIn; if token allowance(account, pump) < tokenIn approve exactly tokenIn to pump and wait for a successful receipt.
5. simulate sell(token, tokenIn, minNusdOut, deadline), write, wait, check status.
After any confirmed trade: re-read market, balances and allowance over RPC. Never use subgraph data or event payloads to size a trade.
Per-market fee: read marketParams(token).tradeFeeBps; do not hard-code 10 bps.
Errors: decode viem ContractFunctionRevertedError and map names to messages: ContractPaused, DeadlineExpired (re-quote), MarketNotTrading (refresh status; market became READY or GRADUATED), InvalidAmount, SlippageExceeded (re-quote, show the new price), AssetTransferMismatch, ERC-20 balance/allowance errors, user rejection (UserRejectedRequestError: return to idle, no error banner).

UI states: disconnected, wrong network, market not tradable (READY: only sell; GRADUATED: link to 0xFi pool markets(token).pool), quoting, insufficient balance, needs approval, approving (pending hash with explorer link), ready to submit, simulating, awaiting signature, pending, confirmed (hash + amounts), failed (decoded reason). Disable the submit button while any step is in flight; block double submits.

Acceptance checklist (report file:line for each):
- [ ] Chain id 4441 checked before approve and before buy/sell.
- [ ] Addresses only from the copied manifest via getAddress.
- [ ] Quote is re-read right before sending; minimum output is never 0.
- [ ] Buy passes the quoted userNusdAmount as maxNusdIn and approves exactly that.
- [ ] Deadline argument present on both buy and sell.
- [ ] Approval receipt awaited before the dependent call.
- [ ] simulateContract uses the same account and args as writeContract.
- [ ] Receipt status checked; failures show the decoded error name.
- [ ] All amounts bigint; no Number/parseFloat/toFixed on amounts.
- [ ] No /api/* calls, no secrets.
- [ ] Unit test for the minOut function (0, 50, 100, 200, 10000 bps) and a build that passes.
```

## 3. Token launch form

```text
You are building a "launch a token" form for 0xPump (ZeroXPumpV2) in a Next.js + TypeScript app with viem and wagmi, on the LitVM LiteForge testnet.

Network: defineChain id 4441, "LitVM LiteForge", zkLTC native (18 decimals), RPC https://rpc.testnet.liteforge.zeeve.net (apps/web/lib/publicConfig.ts:6).

Addresses: copy apps/web/features/fi/config/testnet.generated.json and read `pump` and `nusd` with getAddress. Nothing else hard-coded.

ABI (copy from docs/developers/0xpump.md section "ABI"):
- reserveMarket(bytes32 contentHash)
- creationReservations(address owner,bytes32 contentHash) view returns (bool)
- createdTokenByContentHash(address owner,bytes32 contentHash) view returns (address token)
- createMarket(string name,string symbol,string metadataURI,string imageURI,bytes32 contentHash) returns (address token)
- createFee() view returns (uint128)   (declare view, not pure; the contract's public variable is uint128, ZeroXPumpV2.sol:93)
- paused() view returns (bool)
- events TokenCreated(...) and CreationFeePaid(address indexed owner,bytes32 indexed contentHash,uint256 creationFeeNusd), errors ContractPaused, InvalidCommitment, InvalidReservation, InvalidMetadata.
NUSD uses viem erc20Abi. No call is payable.

Contract rules (contracts/src/pump/ZeroXPumpV2.sol:200-272, 651-670):
- name 1-64 bytes, symbol 1-16 bytes (trim name; trim and upper-case symbol), metadataURI and imageURI 8-200 bytes each and must start with the literal "ipfs://". Count bytes with TextEncoder, not string length.
- contentHash must be non-zero. Reservations are per wallet address: the same account must reserve and create.
- reserveMarket pulls exactly createFee() NUSD (non-refundable). createMarket charges nothing more.

Content hash: implement the same scheme as apps/web/features/pump/contentHash.ts:52-72 (read that file): keccak256(encodeAbiParameters(...)) over "0xPump Market Content", version 1, chainId, pump address, owner, trimmed name, upper-cased symbol, trimmed description/website/twitter, lower-cased mime type, file byte length, keccak256(file bytes), after normalising line endings to \n. The project pins files to IPFS itself (put the pinning call behind an interface with a TODO; never embed a pinning API key in client code; use a server route of THIS project with its own secret if needed). Do not use the 0xNothing web app's /api/* upload routes.

Flow:
1. Validate inputs locally; compute the content hash.
2. Chain check (4441). Read createdTokenByContentHash(account, hash): if non-zero, the token exists: go straight to success with that address.
3. Read creationReservations(account, hash). If false: read paused() (block if true), createFee(), NUSD balance; if allowance(account, pump) < fee, simulate+send approve(pump, fee), wait, require success; then simulateContract reserveMarket(hash), writeContract, waitForTransactionReceipt, require success.
4. Pin metadata and image (skip if already pinned for this hash). Re-check createdTokenByContentHash before creating.
5. simulateContract createMarket(name, symbol, metadataURI, imageURI, hash), write, wait, require success. Decode TokenCreated from receipt logs whose address equals pump; show the token address and link to /pump/[token].
6. Persist {hash, name, symbol, uris, step} in localStorage after each step so a reload resumes at the right step. On resume always re-run steps 2-3 checks; never reserve twice.

UI states: disconnected, wrong network, invalid field (inline per field with byte counts), paused, insufficient NUSD for the fee (show the fee from createFee()), needs approval, approving, reserving, reserved (fee paid, ready to upload), uploading, creating, created, recovered (existing token found), failed with decoded error (InvalidReservation means: re-check the recovery views; InvalidMetadata means: show the field rules).

Acceptance checklist (report file:line for each):
- [ ] Chain id 4441 checked before approve, reserve and create.
- [ ] createdTokenByContentHash and creationReservations are read before paying and before creating.
- [ ] Fee read from createFee(), approval for exactly that amount, receipt awaited.
- [ ] Every write is simulate -> write -> receipt status check.
- [ ] Byte-length and ipfs:// validation matches the contract.
- [ ] Content hash implementation matches contentHash.ts (add a unit test with a fixed input).
- [ ] Reload mid-flow resumes without a second fee payment.
- [ ] No secrets or pinning keys in client code; no 0xNothing /api/* calls.
```

## 4. Graduation button

```text
You are adding a "Graduate to 0xFi" button to a 0xPump market page in a Next.js + TypeScript app with viem and wagmi, LitVM LiteForge testnet.

Network: defineChain id 4441, "LitVM LiteForge", zkLTC native (18 decimals), RPC https://rpc.testnet.liteforge.zeeve.net.

Addresses: copy apps/web/features/fi/config/testnet.generated.json; read `pump`, `pumpGraduationController`, `pumpGraduationRouter`, `pumpGraduationAdapter` with getAddress.

ABI (copy from docs/developers/0xpump.md section "ABI"):
- pump: markets(address) (lifecycle at index 7; dex, dexPairId, pool at 8-10), graduationRouter() view returns (address)
- controller: pump(), router(), adapter(), graduationsPaused() view; previewGraduation(address token) view returns ((bool ready,address pool,uint256 tokenAmount,uint256 nusdAmount,uint256 expectedLp,uint256 minimumLp)); graduateReady(address token) returns (address dex,bytes32 pairId,address pool,address lpToken,uint256 lpAmount); errors GraduationsPaused, RouterUnavailable, MarketNotReady, InvalidGraduationPreview, InvalidGraduationResult.
- router: admin(), enabled(), isAdapterAllowed(address) view.
graduateReady is permissionless, not payable, needs no approval. Do not call ZeroXPumpV2.graduate directly (it is admin-only).

Show the button only when, read over RPC in one multicall right before rendering and again right before sending:
- markets(token).lifecycle === 2 (READY)
- controller.pump() == pump, pump.graduationRouter() == router, controller.router() == router, controller.adapter() == adapter, router.admin() == controller (same gating as apps/web/features/pump/components/TokenDetail.tsx:130-138)
- graduationsPaused() is false, router enabled() is true, isAdapterAllowed(adapter) is true.
Before sending, show previewGraduation(token): NUSD and token amounts going into the pool (formatUnits 18), expected LP, pool address. LP goes to the protocol locker, not the caller: say so.

Flow: chain check 4441 -> fresh gating reads -> simulateContract graduateReady(token) with the connected account -> writeContract -> waitForTransactionReceipt -> require status "success" -> re-read markets(token) and show a link to the 0xFi pool (markets(token).pool) on the explorer and in your 0xFi trading UI.

Race handling: another user can sell (reopening the curve) or graduate first. On MarketNotReady or a GRADUATED status after a failure, refresh and show the current state; never retry blindly.

UI states: hidden (not READY), unavailable (paused/disabled/wiring mismatch, with the reason), preview loading, ready, simulating, awaiting signature, pending, graduated (pool link), failed (decoded error).

Acceptance checklist (report file:line for each):
- [ ] All five wiring checks and three availability checks are implemented.
- [ ] Gating is re-read right before simulate.
- [ ] simulate -> write -> receipt status check.
- [ ] Addresses only from the manifest via getAddress.
- [ ] Decoded errors shown; no blind retry.
- [ ] No /api/* calls, no secrets.
```
