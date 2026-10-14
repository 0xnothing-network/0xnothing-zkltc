import { parseAbi } from "viem";

/** contracts/src/rewards/RewardStaking.sol: NUSD staking for 0xPoints and 10,000 NUSD reward rounds. */
export const rewardStakingAbi = parseAbi([
  "function ROUND_REWARD() view returns (uint256)",
  "function MIN_ROUND_DURATION() view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function currentRound() view returns (uint32)",
  "function roundStart(uint256 round) view returns (uint64)",
  "function roundTotalPoints(uint256 round) view returns (uint256)",
  "function availableRewards() view returns (uint256)",
  "function nextTriggerTime() view returns (uint256)",
  "function openRoundPoints() view returns (uint256)",
  "function accountState(address user) view returns (uint256 weight, uint256 openPoints, uint256 claimable)",
  "function positionIdsOf(address user) view returns (uint256[])",
  "function getPosition(uint256 positionId) view returns ((address account, uint64 unlockTime, uint32 lockDuration, bool withdrawn, uint256 amount, uint256 weight))",
  "function stake(uint256 amount, uint32 lockDuration) returns (uint256 positionId)",
  "function withdraw(uint256 positionId)",
  "function trigger()",
  "function claim(address recipient) returns (uint256 amount)",
  "event RoundClosed(uint256 indexed round, address indexed caller, uint256 totalPoints, uint256 reward, uint64 start, uint64 end)",
]);

/** Lock options mirror `RewardStaking.lockMultiplierBps`. */
export const rewardLockOptions = [
  { duration: 30 * 86_400, days: 30, multiplier: "1x", multiplierBps: 10_000 },
  { duration: 90 * 86_400, days: 90, multiplier: "1.2x", multiplierBps: 12_000 },
  { duration: 180 * 86_400, days: 180, multiplier: "1.5x", multiplierBps: 15_000 },
  { duration: 365 * 86_400, days: 365, multiplier: "3x", multiplierBps: 30_000 },
] as const;

/** contracts/src/governance/SurplusMintGovernor.sol. */
export const surplusMintGovernorAbi = parseAbi([
  "function VOTE_LOCK() view returns (uint256)",
  "function VOTING_PERIOD() view returns (uint256)",
  "function MIN_VOTERS() view returns (uint256)",
  "function INCENTIVE_BUDGET() view returns (uint256)",
  "function proposalCount() view returns (uint256)",
  "function incentiveFunded() view returns (uint256)",
  "function incentiveAvailable() view returns (uint256)",
  "function getProposal(uint256 proposalId) view returns ((address proposer, uint64 start, uint64 end, uint32 yesVotes, uint32 noVotes, bool settled, bool executed, uint256 mintedNusd))",
  "function getBallot(uint256 proposalId, address voter) view returns ((bool cast, bool support, bool withdrawn, uint256 incentive))",
  "function fundIncentives(uint256 amount)",
  "function propose() returns (uint256 proposalId)",
  "function vote(bool support)",
  "function settle(uint256 proposalId)",
  "function withdraw(uint256 proposalId)",
]);

/** NUSD v2 surplus and emergency surface (contracts/src/nusd/OracleNUSDv2.sol). */
export const nusdV2Abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function totalCollateralWei() view returns (uint256)",
  "function reserveValueNusd() view returns (uint256)",
  "function supplyCeilingNusd() view returns (uint256)",
  "function surplusMintCapacity() view returns (uint256 amountNusd, bool triggerReached)",
  "function oracleFailureReportedAt() view returns (uint256)",
  "function ORACLE_FAILURE_GRACE() view returns (uint256)",
  "function reportOracleFailure()",
  "function clearOracleFailure()",
  "function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256)",
]);

/** contracts/src/treasury/FeeSplitter.sol. */
export const feeSplitterAbi = parseAbi([
  "function distribute() returns (uint256 amountNusd)",
  "function sweepNative() returns (uint256 amount)",
]);

/** Revenue sources that anyone can push into the splitter or treasury. */
export const pumpRevenueAbi = parseAbi([
  "function accruedProtocolFeesNusd() view returns (uint256)",
  "function distributeFees() returns (uint256)",
]);

export const routerRevenueAbi = parseAbi([
  "function accruedRouterFees(address token) view returns (uint256)",
  "function distributeFees(address token) returns (uint256)",
]);

export const lendingRevenueAbi = parseAbi([
  "function protocolInterestNusd() view returns (uint256)",
  "function sweepProtocolInterest() returns (uint256)",
]);
