import { parseAbi } from "viem";

/**
 * contracts/src/rewards/RewardStaking.sol: NUSD staking for 0xPoints. Every NUSD that reaches the
 * contract is streamed to stakers over the following 7 days, pro rata to lock-weighted stake.
 */
export const rewardStakingAbi = parseAbi([
  "function STREAM_DURATION() view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function totalPointsNow() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function periodFinish() view returns (uint64)",
  "function queuedRewards() view returns (uint256)",
  "function rewardFunded() view returns (uint256)",
  "function rewardPaid() view returns (uint256)",
  "function earned(address user) view returns (uint256)",
  "function accountState(address user) view returns (uint256 weight, uint256 points, uint256 claimable)",
  "function positionIdsOf(address user) view returns (uint256[])",
  "function getPosition(uint256 positionId) view returns ((address account, uint64 unlockTime, uint32 lockDuration, bool withdrawn, uint256 amount, uint256 weight))",
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
]);

/** Lock options mirror `RewardStaking.lockMultiplierBps`. */
export const rewardLockOptions = [
  { duration: 30 * 86_400, days: 30, multiplier: "1x", multiplierBps: 10_000 },
  { duration: 90 * 86_400, days: 90, multiplier: "1.2x", multiplierBps: 12_000 },
  { duration: 180 * 86_400, days: 180, multiplier: "1.5x", multiplierBps: 15_000 },
  { duration: 365 * 86_400, days: 365, multiplier: "3x", multiplierBps: 30_000 },
] as const;

/** contracts/src/treasury/FeeSplitter.sol: the one inbox for every protocol fee. */
export const feeSplitterAbi = parseAbi([
  "function harvest() returns (uint256 sourcesSucceeded)",
  "function distribute() returns (uint256 amountNusd)",
  "function sourceCount() view returns (uint256)",
  "function stakerBps() view returns (uint256)",
  "function burnBps() view returns (uint256)",
  "function treasuryBps() view returns (uint256)",
  "function reserveBps() view returns (uint256)",
  "function nativeTreasuryBps() view returns (uint256)",
  "event Distributed(uint256 toStakersNusd, uint256 burnedNusd, uint256 toTreasuryNusd, uint256 toReserveWei, uint256 toTreasuryWei)",
  "event Harvested(address indexed caller, uint256 sourcesSucceeded)",
]);

/** Fee sources the splitter harvests; read here only to show what is waiting. */
export const pumpRevenueAbi = parseAbi([
  "function accruedProtocolFeesNusd() view returns (uint256)",
]);

export const routerRevenueAbi = parseAbi([
  "function accruedRouterFees(address token) view returns (uint256)",
]);

export const lendingRevenueAbi = parseAbi([
  "function protocolInterestNusd() view returns (uint256)",
]);
