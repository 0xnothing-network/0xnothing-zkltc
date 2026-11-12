# NUSD integration guide

NUSD ("Nothing USD") is a stable token on LitVM LiteForge testnet (chain id
`4441`, gas token zkLTC). It is priced by an LTC/USD oracle and backed by native
zkLTC. One contract, `OracleNUSDv2`, is both the ERC-20 token and the
mint/redeem desk, and the zkLTC reserve sits inside it.

This guide covers what an integrator can build on:

1. **Mint**: send native zkLTC, receive NUSD at the oracle price.
2. **Redeem**: burn NUSD, receive zkLTC at the oracle price or the pro-rata
   share of the reserve, whichever is lower.
3. **Emergency exit**: a price-free, pro-rata exit that opens 7 days after an
   oracle failure is reported.
4. **Earn** (`RewardStaking`): lock NUSD for 30 to 365 days, collect NUSD fee
   rewards and accrue 0xPoints.

You only need the contracts over JSON-RPC. No public subgraph indexes NUSD
mint/redeem or `RewardStaking`, so history comes from `getLogs`. The 0xNothing
web app's own HTTP routes (`/api/*`, `/0xFi/api/*`) and WebSocket plumbing are
internal and are not a public API.

There is **no Vote or governance contract** in the v3 deployment
(`contracts/script/DeployV3Core.s.sol:89-125` deploys none, and the NUSD
navigation has only Mint and Earn: `apps/web/features/nusd/components/NusdHeader.tsx:7-10`).
Do not build a vote flow.

All examples use [viem](https://viem.sh) with TypeScript and `bigint` amounts.
They build on `chain.ts` and `tx.ts` from the [developer guide](./README.md#shared-viem-setup).
Paths are relative to the `0xNothing-zkLTC-Testnet/` folder.

## Contents

- [Network](#network)
- [Contracts and addresses](#contracts-and-addresses)
- [Token facts](#token-facts)
- [Shared setup](#shared-setup)
- [Flow 1: mint NUSD with zkLTC](#flow-1-mint-nusd-with-zkltc)
- [Flow 2: redeem NUSD for zkLTC](#flow-2-redeem-nusd-for-zkltc)
- [Flow 3: oracle failure and emergency exit](#flow-3-oracle-failure-and-emergency-exit)
- [Earn model](#earn-model)
- [Flow 4: stake NUSD](#flow-4-stake-nusd)
- [Flow 5: claim or restake rewards](#flow-5-claim-or-restake-rewards)
- [Flow 6: withdraw a matured position](#flow-6-withdraw-a-matured-position)
- [Fees, caps and surplus](#fees-caps-and-surplus)
- [Reading data: RPC or subgraph](#reading-data-rpc-or-subgraph)
- [Error reference](#error-reference)
- [Safety checklist](#safety-checklist)

## Network

| Item | Value | Source |
| --- | --- | --- |
| Chain id | `4441` | `contracts/deployments/v3-core.json:3`; `apps/web/features/pump/config.ts:26` |
| Native currency | zkLTC, 18 decimals (gas, and NUSD collateral) | |
| RPC (HTTP) | `https://rpc.testnet.liteforge.zeeve.net` | `apps/web/lib/publicConfig.ts:6` |
| RPC (WebSocket) | `wss://rpc.testnet.liteforge.zeeve.net/ws` | `apps/web/lib/publicConfig.ts:8` |

## Contracts and addresses

Load addresses from the deployment manifest when your app builds or starts. Do
not hard-code them by hand: a redeploy changes the manifest, and a hard-coded
address then points at a retired contract. The values below are the v3 set
(live since 2026-10-15) and show what the manifests contain today.

| Contract | Address | Manifest key |
| --- | --- | --- |
| NUSD (`OracleNUSDv2`): token, mint, redeem, reserve | `0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19` | `nusd` in `contracts/deployments/v3-core.json:9`; `nusd` in `apps/web/features/fi/config/testnet.generated.json:5` |
| `RewardStaking` (Earn, 0xPoints) | `0x59589d9a5840D2CEF7A6e4A8cB55C258cc73E483` | `rewardStaking` in `contracts/deployments/v3-core.json:17`; `testnet.generated.json:37` |
| LTC/USD `OracleRouter` (NUSD price) | `0xf9CCF611b7c4e642852D3d1a7A6C3883985A2962` | `ltcOracle` in `contracts/deployments/v3-core.json:8`; `testnet.generated.json:18` |
| `FeeSplitter` (fee inbox, feeds Earn) | `0xAea1Ef82Dbe800BB3683009630813457D990a9B0` | `feeSplitter` in `contracts/deployments/v3-core.json:6`; `testnet.generated.json:36` |
| `OwnerTreasury` | `0xC5353F677E69c3386c752ab3b3FD7CA2c9372052` | `treasury` in `contracts/deployments/v3-core.json:19` |
| WzkLTC/NUSD 0xFi pair | `0x7a9295742b237802571E80148C2CEc629C5D6E67` | `wzkLtcNusdPair` in `testnet.generated.json:24` |

Other values:

| Item | Value | Source |
| --- | --- | --- |
| First v3 block (start `getLogs` here) | `61141328` | `scriptBlock`, `contracts/deployments/v3-core.json:18` |
| Supply ceiling at deploy | `1000000000000000000000000` (1,000,000 NUSD) | `nusdSupplyCeiling`, `contracts/deployments/v3-core.json:11`; `contracts/script/DeployV3Core.s.sol:93` |
| Oracle source at deploy | DIA adapter `0x54361dB5F9DF455B448E882Ce65612D5e418f3Ee` on the DIA LTC/USD feed `0x45dDa5d881BD2C917976CCfde74fFd6f6412da29`, maximum price age 90 minutes | `contracts/script/DeployV3Core.s.sol:47-48,51,130-134` |

The router is a fixed address. Its owner can swap the source behind it
(`contracts/src/oracle/OracleRouter.sol:49-65`, with a 25% deviation guard while
the old source still works), so always call the router, never the adapter.

Check on-chain before you sign: `nusd.oracle()` must equal the `ltcOracle`
manifest value, and `rewardStaking.nusd()` is the NUSD you approve.

`0xFi/contracts/deployments/latest.json` holds the older v1 set. Its
`nusdPointsStaking` (`0xDf009d9c2Bc0C2f8ee55A047074edB166C1D3282`,
`latest.json:446`) is the retired xPoints module. The web app does not use it;
v3 Earn is `RewardStaking` (`apps/web/features/fi/config/deployment.ts:112`).

## Token facts

From `contracts/src/nusd/OracleNUSDv2.sol`:

- Name `Nothing USD`, symbol `NUSD`, 18 decimals (`:45-47`). Prices are WAD
  (`1e18` = 1 USD).
- Standard ERC-20 `approve` / `transfer` / `transferFrom` (`:139-155`), with
  custom errors `ERC20InvalidAddress()`,
  `ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount)`
  and `ERC20InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requiredAmount)` (`:41-43`).
- `vault()` returns the NUSD address itself (`:133-135`). The zkLTC reserve is
  `totalCollateralWei()`.
- **Do not send plain zkLTC to the NUSD address.** `receive()` (`:129-131`) and
  `coverReserve()` (`:287-289`) book it as a donation to the reserve
  (`ReserveCovered`). It mints nothing. To mint, call `mintAtOracle`.
- `burn(uint256)` (`:281-285`) destroys NUSD and leaves the collateral in the
  reserve, which raises the backing of every other holder.

## Shared setup

Put the addresses and ABI fragments in one module. The function fragments
match the web app's ABIs (`apps/web/features/pump/abis.ts:68-96`,
`apps/web/features/pump/components/NusdEmergencyPanel.tsx:13-23`,
`apps/web/features/fi/lib/abis/tokenomics.ts:7-31`). The `error` fragments come
from the Solidity sources and let viem decode reverts.

```ts
// nusd.ts
import { getAddress, parseAbi, type Address } from "viem";
// Copy the manifest into your project (or read it at start-up). Needs "resolveJsonModule".
import core from "./manifests/v3-core.json"; // contracts/deployments/v3-core.json

if (core.chainId !== 4441) throw new Error("Manifest is not for LiteForge 4441");
export const NUSD: Address = getAddress(core.nusd);
export const REWARD_STAKING: Address = getAddress(core.rewardStaking);
export const LTC_ORACLE: Address = getAddress(core.ltcOracle);
export const FROM_BLOCK = BigInt(core.scriptBlock);

const oracleErrors = [
  // contracts/src/nusd/DIAOracleAdapter.sol: bubbled through the router into NUSD calls
  "error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp)",
  "error InvalidOracleAnswer()",
  "error IncompleteOracleRound()",
  "error FutureOracleTimestamp()",
] as const;

export const nusdAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function oracle() view returns (address)",
  "function supplyCeilingNusd() view returns (uint256)",
  "function totalCollateralWei() view returns (uint256)",
  "function reserveValueNusd() view returns (uint256)",
  "function backingRatioWad() view returns (uint256)",
  "function mintPaused() view returns (bool)",
  "function quoteMint(uint256 collateralWei) view returns (uint256 amountNusd)",
  "function mintAtOracle(uint256 minNusdOut, address recipient) payable returns (uint256 amountNusd)",
  "function quoteRedeem(uint256 amountNusd) view returns (uint256 collateralOutWei)",
  "function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256 collateralOutWei)",
  "function oracleFailureReportedAt() view returns (uint256)",
  "function ORACLE_FAILURE_GRACE() view returns (uint256)",
  "function reportOracleFailure()",
  "function clearOracleFailure()",
  "function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256)",
  "event MintedAtOracle(address indexed payer, address indexed recipient, uint256 collateralInWei, uint256 amountNusd)",
  "event RedeemedAtOracle(address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei)",
  "event OracleFailureReported(address indexed reporter, uint256 reportedAt)",
  "event EmergencyRedeemed(address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei)",
  "error MintPaused()",
  "error InvalidAmount()",
  "error InvalidRecipient()",
  "error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount)",
  "error SupplyCeilingExceeded(uint256 requestedAmountNusd, uint256 availableAmountNusd)",
  "error OracleHealthy()",
  "error OracleUnavailable()",
  "error OracleFailureNotReported()",
  "error OracleFailureGracePending(uint256 availableAt)",
  "error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount)",
  "error ERC20InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requiredAmount)",
  ...oracleErrors,
]);

export const oracleRouterAbi = parseAbi([
  "function readPriceWad() view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId)",
  "function isFresh() view returns (bool)",
  ...oracleErrors,
]);

export const rewardStakingAbi = parseAbi([
  "function nusd() view returns (address)", // RewardStaking.sol:64
  "function earned(address user) view returns (uint256)",
  "function accountState(address user) view returns (uint256 weight, uint256 points, uint256 claimable)",
  "function positionIdsOf(address user) view returns (uint256[])",
  "function getPosition(uint256 positionId) view returns ((address account, uint64 unlockTime, uint32 lockDuration, bool withdrawn, uint256 amount, uint256 weight))",
  "function totalWeight() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function periodFinish() view returns (uint64)",
  "function queuedRewards() view returns (uint256)",
  "function stake(uint256 amount, uint32 lockDuration) returns (uint256 positionId)",
  "function withdraw(uint256 positionId)",
  "function claim(address recipient) returns (uint256 amount)",
  "function claimAndStake(uint32 lockDuration) returns (uint256 positionId)",
  "function sync()",
  "event Staked(uint256 indexed positionId, address indexed account, uint256 amount, uint256 weight, uint32 lockDuration, uint64 unlockTime)",
  "event Withdrawn(uint256 indexed positionId, address indexed account, uint256 amount)",
  "event RewardClaimed(address indexed account, address indexed recipient, uint256 amount)",
  "event RewardRestaked(address indexed account, uint256 indexed positionId, uint256 amount)",
  "event RewardsQueued(uint256 income, uint256 rewardRatePerSecond, uint256 periodFinish)",
  "error InvalidAmount()",
  "error InvalidLockDuration()",
  "error UnknownPosition()",
  "error NotPositionOwner()",
  "error AlreadyWithdrawn()",
  "error PositionLocked(uint256 unlockTime)",
  "error NothingToClaim()",
  "error InvalidRecipient()",
  "error NonExactTransfer()",
]);

/** The only accepted lock durations, in seconds (RewardStaking.sol:41-44,188-194). */
export const LOCKS = [
  { seconds: 2_592_000, days: 30, multiplierBps: 10_000n },
  { seconds: 7_776_000, days: 90, multiplierBps: 12_000n },
  { seconds: 15_552_000, days: 180, multiplierBps: 15_000n },
  { seconds: 31_536_000, days: 365, multiplierBps: 30_000n },
] as const;
```

The flows below import `publicClient` from `chain.ts` and `minOut`,
`assertChain`, `confirm` and `ensureAllowance` from `tx.ts` (see the
[developer guide](./README.md#the-write-pattern)).

## Flow 1: mint NUSD with zkLTC

**Purpose.** Turn native zkLTC into NUSD at the oracle price.

**Math** (`OracleNUSDv2.sol:160-163,404-407`):
`gross = collateralWei * priceWad / 1e18`, then
`amountNusd = gross - gross * mintFeeBps / 10000`. The whole `msg.value` joins
the reserve (`:184-185`). The mint fee is `0` today.

**Preconditions.**

- Wallet on chain `4441`.
- `mintPaused()` is `false`. Only `PAUSER_ROLE` can pause, and only mint
  (`:333-336`).
- The oracle price is usable (`router.isFresh()`), because a stale price makes
  the mint revert.
- `collateralWei > 0`, and the wallet holds that much zkLTC plus gas.
- The mint fits under `supplyCeilingNusd()`. The ceiling doubles inside a mint
  when the supply after it reaches 80% of the ceiling and 7 days have passed
  since the last raise (`:386-401`), so let the simulation decide.
- No approval: you pay with `value`.

**Steps** (the web app's order, `apps/web/features/pump/components/NusdOraclePanel.tsx:134-172,264-330`):

1. Check the chain id.
2. Read `mintPaused()`, `oracle()` and `router.isFresh()`.
3. Read `quoteMint(collateralWei)`.
4. `minNusdOut = quote * (10000 - slippageBps) / 10000`. The web app uses
   `50` bps (`NusdOraclePanel.tsx:35,50-52`).
5. `simulateContract` `mintAtOracle(minNusdOut, recipient)` with
   `value: collateralWei` and the real `account`.
6. `writeContract(request)`, wait for the receipt, require `status === "success"`.

```ts
import type { Address, WalletClient } from "viem";
import { publicClient } from "./chain";
import { assertChain, confirm, minOut } from "./tx";
import { NUSD, nusdAbi, oracleRouterAbi } from "./nusd";

export async function mintNusd(
  walletClient: WalletClient,
  account: Address,
  collateralWei: bigint,     // parseEther("1") for 1 zkLTC
  slippageBps = 50n,
) {
  if (collateralWei <= 0n) throw new Error("Amount must be greater than 0");
  await assertChain(walletClient);

  const [paused, oracle, balance] = await Promise.all([
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "mintPaused" }),
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "oracle" }),
    publicClient.getBalance({ address: account }),
  ]);
  if (paused) throw new Error("Minting is paused");
  if (balance < collateralWei) throw new Error("Not enough zkLTC (keep some for gas)");
  const fresh = await publicClient.readContract({ address: oracle, abi: oracleRouterAbi, functionName: "isFresh" });
  if (!fresh) throw new Error("Oracle price is stale; minting is unavailable");

  const quote = await publicClient.readContract({
    address: NUSD, abi: nusdAbi, functionName: "quoteMint", args: [collateralWei],
  });
  if (quote === 0n) throw new Error("Amount too small");
  const minNusdOut = minOut(quote, slippageBps);

  const { request, result } = await publicClient.simulateContract({
    account, address: NUSD, abi: nusdAbi, functionName: "mintAtOracle",
    args: [minNusdOut, account], value: collateralWei,
  });
  await assertChain(walletClient);
  const hash = await walletClient.writeContract(request);
  const receipt = await confirm(hash); // throws unless status === "success"
  return { hash, receipt, expectedNusd: result };
}
```

**Errors to handle.** `MintPaused()`; `InvalidAmount()` (value 0 or quote 0);
`InvalidRecipient()`; `SlippageExceeded(minimumAmount, actualAmount)` (price
moved: re-quote); `SupplyCeilingExceeded(requestedAmountNusd, availableAmountNusd)`
(show the available amount); oracle errors `StaleOraclePrice(updatedAt, currentTimestamp)`,
`InvalidOracleAnswer()`, `IncompleteOracleRound()`, `FutureOracleTimestamp()`
(`contracts/src/nusd/DIAOracleAdapter.sol:39-44,55`).

## Flow 2: redeem NUSD for zkLTC

**Purpose.** Burn NUSD and receive native zkLTC.

**Math** (`OracleNUSDv2.sol:193-201`):

```
atOracle = amountNusd * 1e18 / priceWad
proRata  = amountNusd * totalCollateralWei / totalSupply
gross    = min(atOracle, proRata)
out      = gross - gross * redeemFeeBps / 10000
```

When the reserve covers the supply, a holder gets 1 USD of zkLTC per NUSD.
When it does not, every holder gets the same pro-rata share, so there is no
race to exit first. On 2026-11-05 `backingRatioWad()` read about `0.91e18`
(it moves with the LTC price), so redemptions paid the pro-rata share, under
1 USD. Show users the
quote, not a fixed 1 USD.

`quoteRedeem` returns `0` for `amountNusd == 0` or `amountNusd > totalSupply`.

**Admins cannot pause redemption** (`redeemAtOracle` has no pause check,
`:203-220`). But `quoteRedeem` and `redeemAtOracle` read the oracle without a
try/catch, so **both revert while the DIA price is stale** (older than 90
minutes, `DIAOracleAdapter.sol:42-44`). In that case the only exit is
[Flow 3](#flow-3-oracle-failure-and-emergency-exit). Handle that revert and
point users to it.

**Preconditions.** Wallet on chain `4441`; NUSD balance `>= amountNusd`;
usable oracle. **No approval**: the contract burns from `msg.sender` (`:215`).

**Steps** (`NusdOraclePanel.tsx:307-325`):

1. Check the chain id and the NUSD balance.
2. Read `quoteRedeem(amountNusd)`. If it reverts with an oracle error, offer
   Flow 3.
3. `minCollateralOutWei = quote * (10000 - slippageBps) / 10000`.
4. Simulate `redeemAtOracle(amountNusd, minCollateralOutWei, recipient)`.
5. Write, wait for the receipt, require success.

```ts
import { BaseError, ContractFunctionRevertedError, type Address, type WalletClient } from "viem";
import { publicClient } from "./chain";
import { assertChain, confirm, minOut } from "./tx";
import { NUSD, nusdAbi } from "./nusd";

const ORACLE_DOWN = new Set(["StaleOraclePrice", "InvalidOracleAnswer", "IncompleteOracleRound", "FutureOracleTimestamp"]);

export function isOracleDown(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError && ORACLE_DOWN.has(revert.data?.errorName ?? "");
}

export async function redeemNusd(
  walletClient: WalletClient,
  account: Address,
  amountNusd: bigint,        // parseUnits("10", 18)
  slippageBps = 50n,
) {
  if (amountNusd <= 0n) throw new Error("Amount must be greater than 0");
  await assertChain(walletClient);

  const balance = await publicClient.readContract({
    address: NUSD, abi: nusdAbi, functionName: "balanceOf", args: [account],
  });
  if (balance < amountNusd) throw new Error("Not enough NUSD");

  let quote: bigint;
  try {
    quote = await publicClient.readContract({
      address: NUSD, abi: nusdAbi, functionName: "quoteRedeem", args: [amountNusd],
    });
  } catch (error) {
    if (isOracleDown(error)) throw new Error("Oracle price is stale. Use the emergency exit (Flow 3).");
    throw error;
  }
  if (quote === 0n) throw new Error("Nothing to redeem");

  // No approval: redeemAtOracle burns from msg.sender.
  const { request, result } = await publicClient.simulateContract({
    account, address: NUSD, abi: nusdAbi, functionName: "redeemAtOracle",
    args: [amountNusd, minOut(quote, slippageBps), account],
  });
  await assertChain(walletClient);
  const hash = await walletClient.writeContract(request);
  const receipt = await confirm(hash);
  return { hash, receipt, expectedZkLtcWei: result };
}
```

**Errors to handle.** `InvalidAmount()`; `InvalidRecipient()`;
`SlippageExceeded(minimumAmount, actualAmount)`;
`ERC20InsufficientBalance(account, balance, requiredAmount)`; the oracle errors
listed in Flow 1 (route the user to Flow 3).

## Flow 3: oracle failure and emergency exit

**Purpose.** Let holders leave when the oracle stays broken, without any price.

**Rules** (`OracleNUSDv2.sol:225-265,409-415`):

- The oracle is usable when `router.readPriceWad()` does not revert and returns
  a non-zero price. The DIA adapter reverts when the price is older than 90
  minutes.
- `reportOracleFailure()` is permissionless. It reverts `OracleHealthy()` while
  the price works, does nothing if a failure is already reported, and emits
  `OracleFailureReported(reporter, reportedAt)`.
- `clearOracleFailure()` is permissionless. It reverts `OracleUnavailable()`
  while the price is still broken, and emits `OracleFailureCleared(caller)`.
- `emergencyRedeem(amountNusd, minCollateralOutWei, recipient)` opens at
  `oracleFailureReportedAt() + ORACLE_FAILURE_GRACE()` (7 days, `:52`) and
  only while the oracle is still unusable. It pays
  `amountNusd * totalCollateralWei / totalSupply` (`:258`), with no fee and no
  price. No approval is needed.

**Steps** (the web app's checks, `apps/web/features/pump/components/NusdEmergencyPanel.tsx:95-126`):

1. Check the chain id. Read `oracleFailureReportedAt()`, `ORACLE_FAILURE_GRACE()`,
   the latest block timestamp and `router.isFresh()`.
2. If `reportedAt == 0` and the price is broken, simulate and send
   `reportOracleFailure()`. Tell the user the exit opens 7 days later.
3. If reported, the grace has passed and `isFresh()` is still `false`, compute
   the quote, apply slippage (the web app uses 0.5%: `quote * 995 / 1000`,
   `:97`), simulate and send `emergencyRedeem`.
4. If the price works again, use Flow 2. Anyone may call `clearOracleFailure()`.

```ts
import type { Address, WalletClient } from "viem";
import { publicClient } from "./chain";
import { assertChain, confirm, minOut } from "./tx";
import { LTC_ORACLE, NUSD, nusdAbi, oracleRouterAbi } from "./nusd";

export async function emergencyExit(
  walletClient: WalletClient,
  account: Address,
  amountNusd: bigint,
  slippageBps = 50n,
) {
  await assertChain(walletClient);
  const [reportedAt, grace, fresh, block] = await Promise.all([
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "oracleFailureReportedAt" }),
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "ORACLE_FAILURE_GRACE" }),
    publicClient.readContract({ address: LTC_ORACLE, abi: oracleRouterAbi, functionName: "isFresh" }),
    publicClient.getBlock(),
  ]);
  if (fresh) throw new Error("Oracle is healthy: use redeemAtOracle (Flow 2)");

  if (reportedAt === 0n) {
    const { request } = await publicClient.simulateContract({
      account, address: NUSD, abi: nusdAbi, functionName: "reportOracleFailure",
    });
    await assertChain(walletClient);
    const receipt = await confirm(await walletClient.writeContract(request));
    return { stage: "reported" as const, receipt, opensAt: block.timestamp + grace };
  }

  const opensAt = reportedAt + grace;
  if (block.timestamp < opensAt) return { stage: "waiting" as const, opensAt };

  if (amountNusd <= 0n) throw new Error("Amount must be greater than 0");
  const [balance, supply, reserve] = await Promise.all([
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "totalSupply" }),
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "totalCollateralWei" }),
  ]);
  if (balance < amountNusd) throw new Error("Not enough NUSD");
  const quote = (amountNusd * reserve) / supply; // OracleNUSDv2.sol:258
  if (quote === 0n) throw new Error("Amount too small");

  const { request } = await publicClient.simulateContract({
    account, address: NUSD, abi: nusdAbi, functionName: "emergencyRedeem",
    args: [amountNusd, minOut(quote, slippageBps), account],
  });
  await assertChain(walletClient);
  const receipt = await confirm(await walletClient.writeContract(request));
  return { stage: "redeemed" as const, receipt };
}
```

**Errors to handle.** `OracleHealthy()`; `OracleFailureNotReported()`;
`OracleFailureGracePending(availableAt)` (show the time); `OracleUnavailable()`
(from `clearOracleFailure`); `InvalidAmount()`; `InvalidRecipient()`;
`SlippageExceeded(minimumAmount, actualAmount)`.

## Earn model

`RewardStaking` (`contracts/src/rewards/RewardStaking.sol`) has **no admin and
no pause** (`:18-19`).

- **Positions.** `stake(amount, lockDuration)` opens a position. `lockDuration`
  must be exactly one of these values, or the call reverts `InvalidLockDuration()`
  (`:41-44,188-194`; web options `apps/web/features/fi/lib/abis/tokenomics.ts:34-39`):

  | Lock | `lockDuration` (s) | `multiplierBps` | 0xPoints per day for 100 NUSD |
  | --- | ---: | ---: | ---: |
  | 30 days | `2592000` | `10000` (x1) | 100 |
  | 90 days | `7776000` | `12000` (x1.2) | 120 |
  | 180 days | `15552000` | `15000` (x1.5) | 150 |
  | 365 days | `31536000` | `30000` (x3) | 300 |

- **Weight** = `amount * multiplierBps / 10000` (`:254`).
- **0xPoints** accrue every second: raw points = weight (wei) x seconds
  (`:59-60,204-207`). They are lifetime and never spent. Read them with
  `accountState(user).points`. The web app shows `points / 86400` formatted at
  18 decimals, so one 0xPoint is 1 NUSD of lock-weighted stake held for one day
  (`apps/web/features/fi/components/RewardsDashboard.tsx:18,37-39`).
- **Rewards** are NUSD. Any NUSD the contract holds above principal and owed
  rewards is streamed over 7 days (`STREAM_DURATION`, `:37`), pro rata to weight
  (`:286-325`). The stream holds while nobody is staked. Income comes from the
  `FeeSplitter` (70% of NUSD fees), 80% of each NUSD surplus release, and
  donations.
- **Claim** with `claim(recipient)` or restake with `claimAndStake(lockDuration)`.
  There is no point redemption and no voucher signer.
- **Withdraw** with `withdraw(positionId)` any time after `unlockTime`. It
  never runs the fee harvest.
- `stake`, `claim`, `claimAndStake` and `sync` call `FeeSplitter.harvest()` with
  3,000,000 gas (`HARVEST_GAS`) inside a try/catch (`:39,266-270`). Let simulation and the
  wallet estimate gas; do not set a low gas limit.

## Flow 4: stake NUSD

**Preconditions.** Chain `4441`; `amount > 0`; NUSD balance `>= amount`; a
valid `lockDuration`; NUSD allowance for `RewardStaking` `>= amount`.

**Steps** (`RewardsDashboard.tsx:179-215`; approval in
`apps/web/features/fi/lib/hooks/useProtocolTransaction.ts:166-212`):

1. Check the chain, balance and lock value.
2. If `allowance(account, REWARD_STAKING) < amount`, approve **exactly**
   `amount` (the web app never approves unlimited), wait for the approval
   receipt.
3. Simulate `stake(amount, lockDuration)`, write, wait, require success.
4. Decode `Staked` from the receipt for the `positionId` and `unlockTime`.

```ts
import { parseEventLogs, type Address, type WalletClient } from "viem";
import { publicClient } from "./chain";
import { assertChain, confirm, ensureAllowance } from "./tx";
import { LOCKS, NUSD, REWARD_STAKING, nusdAbi, rewardStakingAbi } from "./nusd";

export async function stakeNusd(
  walletClient: WalletClient,
  account: Address,
  amount: bigint,
  lockDuration: (typeof LOCKS)[number]["seconds"],
) {
  if (amount <= 0n) throw new Error("Amount must be greater than 0");
  if (!LOCKS.some((l) => l.seconds === lockDuration)) throw new Error("Invalid lock duration");
  await assertChain(walletClient);

  const balance = await publicClient.readContract({
    address: NUSD, abi: nusdAbi, functionName: "balanceOf", args: [account],
  });
  if (balance < amount) throw new Error("Not enough NUSD");

  // Exact-amount approval, waits for its receipt (tx.ts).
  await ensureAllowance(walletClient, account, NUSD, REWARD_STAKING, amount);

  const { request } = await publicClient.simulateContract({
    account, address: REWARD_STAKING, abi: rewardStakingAbi, functionName: "stake",
    args: [amount, lockDuration],
  });
  await assertChain(walletClient);
  const hash = await walletClient.writeContract(request);
  const receipt = await confirm(hash);
  const [staked] = parseEventLogs({ abi: rewardStakingAbi, eventName: "Staked", logs: receipt.logs });
  return { hash, receipt, positionId: staked?.args.positionId, unlockTime: staked?.args.unlockTime };
}
```

**Errors to handle.** `InvalidAmount()`; `InvalidLockDuration()`;
`NonExactTransfer()`; `ERC20InsufficientAllowance(...)` (approval missing or not
mined yet); `ERC20InsufficientBalance(...)`.

## Flow 5: claim or restake rewards

**Steps.**

1. Check the chain. Read `accountState(account)`; `claimable` is the reward
   earned so far.
2. If `claimable == 0`, show "nothing to claim yet" (the call would revert
   `NothingToClaim()`).
3. Simulate `claim(recipient)` (recipient non-zero) or
   `claimAndStake(lockDuration)`, write, wait, require success.

```ts
import type { Address, WalletClient } from "viem";
import { publicClient } from "./chain";
import { assertChain, confirm } from "./tx";
import { LOCKS, REWARD_STAKING, rewardStakingAbi } from "./nusd";

export async function claimRewards(
  walletClient: WalletClient,
  account: Address,
  restakeLock?: (typeof LOCKS)[number]["seconds"],   // set to restake instead of claiming to the wallet
) {
  await assertChain(walletClient);
  const [, , claimable] = await publicClient.readContract({
    address: REWARD_STAKING, abi: rewardStakingAbi, functionName: "accountState", args: [account],
  });
  if (claimable === 0n) throw new Error("Nothing to claim yet");

  // Two separate branches keep each request's type exact for writeContract.
  if (restakeLock === undefined) {
    const { request, result } = await publicClient.simulateContract({
      account, address: REWARD_STAKING, abi: rewardStakingAbi, functionName: "claim", args: [account],
    });
    await assertChain(walletClient);
    const hash = await walletClient.writeContract(request);
    return { hash, receipt: await confirm(hash), claimedNusd: result };
  }
  const { request, result } = await publicClient.simulateContract({
    account, address: REWARD_STAKING, abi: rewardStakingAbi, functionName: "claimAndStake", args: [restakeLock],
  });
  await assertChain(walletClient);
  const hash = await walletClient.writeContract(request);
  return { hash, receipt: await confirm(hash), newPositionId: result };
}
```

**Errors to handle.** `NothingToClaim()`; `InvalidRecipient()`;
`InvalidLockDuration()`.

## Flow 6: withdraw a matured position

**Steps.**

1. Check the chain. List `positionIdsOf(account)`, then `getPosition(id)` for each.
2. Withdrawable when `position.account == account`, `!withdrawn`, and the
   latest block timestamp `>= unlockTime`. Use the block time, not the
   device clock.
3. Simulate `withdraw(positionId)`, write, wait, require success.

```ts
import { isAddressEqual, type Address, type WalletClient } from "viem";
import { publicClient } from "./chain";
import { assertChain, confirm } from "./tx";
import { REWARD_STAKING, rewardStakingAbi } from "./nusd";

export async function withdrawMatured(walletClient: WalletClient, account: Address, positionId: bigint) {
  await assertChain(walletClient);
  const [position, block] = await Promise.all([
    publicClient.readContract({
      address: REWARD_STAKING, abi: rewardStakingAbi, functionName: "getPosition", args: [positionId],
    }),
    publicClient.getBlock(),
  ]);
  if (!isAddressEqual(position.account, account)) throw new Error("Not your position");
  if (position.withdrawn) throw new Error("Already withdrawn");
  if (block.timestamp < position.unlockTime) throw new Error(`Locked until ${position.unlockTime}`);

  const { request } = await publicClient.simulateContract({
    account, address: REWARD_STAKING, abi: rewardStakingAbi, functionName: "withdraw", args: [positionId],
  });
  await assertChain(walletClient);
  const hash = await walletClient.writeContract(request);
  return { hash, receipt: await confirm(hash) };
}
```

**Errors to handle.** `UnknownPosition()`; `NotPositionOwner()`;
`AlreadyWithdrawn()`; `PositionLocked(unlockTime)`.

## Fees, caps and surplus

Read these values live; the contract owner can change some within hard caps.

| Item | Value at deploy / live 2026-11-05 | Cap or rule | Source |
| --- | --- | --- | --- |
| `mintFeeBps`, `redeemFeeBps` (uint16) | `0` | max `MAX_FEE_BPS = 50` (0.5%); `setFees` emits `FeesUpdated` | `OracleNUSDv2.sol:53,79-80,338-345`; `DeployV3Core.s.sol:147` |
| Supply ceiling | 1,000,000 NUSD | auto x2 at 80% usage, at most once per 7 days; owner can set it, never below supply, max uint96 | `OracleNUSDv2.sol:348-355,386-401` |
| Surplus trigger | `surplusTriggerBps = 33000` (3.3x) | `>= floor + 1000` | `OracleNUSDv2.sol:59-63,80-86,357-381` |
| Surplus floor | `surplusFloorBps = 30000` (3.0x) | `>= 15000` | same |
| Surplus treasury share | `surplusTreasuryBps = 2000` (20%), rest to `RewardStaking` | `<= 2000` | same |
| FeeSplitter NUSD split | 7000 stakers / 2000 burn / 1000 treasury | treasury `<= 2000` | `DeployV3Core.s.sol:158-162`; `contracts/src/treasury/FeeSplitter.sol:34` |
| FeeSplitter zkLTC split | 9000 to NUSD reserve / 1000 treasury | treasury `<= 2000` | `DeployV3Core.s.sol:158-162`; `FeeSplitter.sol:146-150` |

**Surplus** (`OracleNUSDv2.sol:293-330`). When the reserve value reaches the
trigger (3.3x supply), anyone can call `releaseSurplus()`, at most once per 7
days. It mints NUSD toward the floor (3.0x), **capped by the remaining
supply-ceiling headroom** (`:299-301`), and needs both recipients set.
`FeeSplitter.harvest()` also attempts it automatically (`FeeSplitter.sol:97`).
Event: `SurplusReleased(caller, toStakingNusd, toTreasuryNusd, reserveValueNusd, supplyAfterNusd)`.
`surplusMintCapacity()` returns `(uint256 amountNusd, bool ready)` and reverts
while the oracle is unusable.

Views for a dashboard: `totalSupply()`, `totalCollateralWei()`,
`reserveValueNusd()`, `backingRatioWad()` (returns max uint256 while supply is
0, `:273-278`), `supplyCeilingNusd()`, `mintPaused()`, and on the router
`readPriceWad()` / `isFresh()`.

## Reading data: RPC or subgraph

**No public subgraph indexes NUSD mint/redeem, the oracle-failure path, or
`RewardStaking`.** Read state over RPC, and build history with `getLogs` from
block `61141328` (`scriptBlock`). Page the range in chunks; public RPC
endpoints limit the block span of one request.

```ts
import { publicClient } from "./chain";
import { FROM_BLOCK, NUSD, nusdAbi } from "./nusd";

export async function mintHistory(recipient: `0x${string}`, chunk = 50_000n) {
  const latest = await publicClient.getBlockNumber();
  const out = [];
  for (let from = FROM_BLOCK; from <= latest; from += chunk) {
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    out.push(...(await publicClient.getContractEvents({
      address: NUSD, abi: nusdAbi, eventName: "MintedAtOracle",
      args: { recipient }, fromBlock: from, toBlock: to,
    })));
  }
  return out;
}
```

Use the same pattern for `RedeemedAtOracle`, `EmergencyRedeemed`,
`OracleFailureReported`, and the `RewardStaking` events (`Staked`, `Withdrawn`,
`RewardClaimed`, `RewardRestaked`, `RewardsQueued`).

**NUSD market data** (the WzkLTC/NUSD pool) is in the public 0xFi subgraph:
`https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxfi-testnet/1.0.0/gn`
(`goldskyEndpoint`, `testnet.generated.json:3`; schema `0xFi/subgraph/schema.graphql`,
`Pool` `:20-45`, `Swap` `:47-65`, `Candle` `:87-101`). `Pool.id` is the
lower-case pair address (`0xFi/subgraph/src/factory.ts:10`). In this pool
`token0` is NUSD.

```graphql
{
  pool(id: "0x7a9295742b237802571e80148c2cec629c5d6e67") {
    id
    token0 { symbol }
    token1 { symbol }
    reserve0
    reserve1
    price0
    price1
  }
  swaps(first: 20, orderBy: timestamp, orderDirection: desc,
        where: { pool: "0x7a9295742b237802571e80148c2cec629c5d6e67" }) {
    id sender recipient amount0In amount1In amount0Out amount1Out timestamp txHash
  }
}
```

**Do not rely on these fields for v3 pools:** `Swap.amountNusd`,
`Pool.volumeNusd`, `Candle.volumeNusd` and `Protocol.totalVolumeNusd` read `0`,
and the candle price for the WzkLTC/NUSD pool is WzkLTC per NUSD. The mappings
(`0xFi/subgraph/src/pair.ts:6,82`, `src/lending.ts:20`) still use the legacy
NUSD address. Compute NUSD volume from `amount0In`/`amount0Out` yourself.

Subgraph data is history only. Never size a mint, redeem or stake from it.

## Error reference

| Error | Contract | Meaning | What to do |
| --- | --- | --- | --- |
| `MintPaused()` | NUSD | Mint paused by `PAUSER_ROLE` | Disable mint; redeem still works |
| `InvalidAmount()` | NUSD, RewardStaking | Zero amount, or a quote of 0 | Ask for a larger amount |
| `InvalidRecipient()` | NUSD, RewardStaking | Recipient is the zero address | Use the connected account |
| `SlippageExceeded(minimumAmount, actualAmount)` | NUSD | Price or reserve moved past the minimum | Re-quote and retry with consent |
| `SupplyCeilingExceeded(requestedAmountNusd, availableAmountNusd)` | NUSD | Mint above the ceiling | Offer `availableAmountNusd` |
| `StaleOraclePrice(updatedAt, currentTimestamp)` and other adapter errors | NUSD via router | Price older than 90 min or invalid | Disable mint/redeem; offer the emergency path |
| `OracleHealthy()` | NUSD | Price works; emergency path closed | Use mint/redeem |
| `OracleUnavailable()` | NUSD | `clearOracleFailure` while still broken | Wait |
| `OracleFailureNotReported()` | NUSD | Emergency redeem before a report | Call `reportOracleFailure()` |
| `OracleFailureGracePending(availableAt)` | NUSD | 7-day grace not over | Show `availableAt` |
| `ERC20InsufficientBalance(account, balance, requiredAmount)` | NUSD | Not enough NUSD | Lower the amount |
| `ERC20InsufficientAllowance(owner, spender, allowance, requiredAmount)` | NUSD | Approval missing for `RewardStaking` | Approve and wait for the receipt |
| `InvalidLockDuration()` | RewardStaking | Lock not in the four values | Use `LOCKS` |
| `PositionLocked(unlockTime)` | RewardStaking | Withdraw before maturity | Show `unlockTime` |
| `UnknownPosition()`, `NotPositionOwner()`, `AlreadyWithdrawn()` | RewardStaking | Wrong position id | Refresh the position list |
| `NothingToClaim()` | RewardStaking | No reward earned yet | Hide the claim button |
| `NonExactTransfer()` | RewardStaking | Received amount differs from `amount` | Report; do not retry blindly |

## Safety checklist

- [ ] Addresses load from `contracts/deployments/v3-core.json` (or
      `testnet.generated.json`); `nusd.oracle()` matches `ltcOracle`.
- [ ] The wallet reports chain `4441` before every write.
- [ ] All amounts are `bigint` with 18 decimals (`parseUnits` / `formatUnits`);
      no `Number`, `parseFloat` or `toFixed` on amounts.
- [ ] Mint is never a plain zkLTC transfer to the NUSD address (that is a
      donation). It is `mintAtOracle` with `value`.
- [ ] Every mint, redeem and emergency redeem uses a fresh on-chain quote and a
      non-zero minimum from integer basis-point slippage.
- [ ] Mint checks `mintPaused()` and `isFresh()` first. Redeem handles the
      stale-oracle revert and points to the emergency path.
- [ ] Redeem shows the quoted zkLTC, not a fixed 1 USD; backing can be under 1.
- [ ] No approval for mint, redeem or emergency redeem. Exactly `amount`
      approved to `RewardStaking` before `stake`, and the approval receipt is
      confirmed first.
- [ ] `lockDuration` is one of `2592000`, `7776000`, `15552000`, `31536000`.
- [ ] Withdraw eligibility uses block time, not the device clock.
- [ ] `simulateContract` runs with the exact `account`, `args` and `value`;
      the receipt must have `status === "success"`.
- [ ] No gas limit is hard-coded below what simulation estimates (Earn calls
      run the fee harvest).
- [ ] History comes from `getLogs`, not from the web app's `/api/*` routes;
      subgraph data never sizes a transaction.
- [ ] No private key, mnemonic or API key in client code or URLs.
