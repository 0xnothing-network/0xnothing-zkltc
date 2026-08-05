import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  DepositsPauseUpdated,
  RewardAdded,
  RewardPaid,
  Staked,
  Withdrawn,
} from "../generated/templates/LiquidityGauge/LiquidityGauge";
import { Gauge, GaugeAction } from "../generated/schema";
import { eventId, ZERO_BI } from "./helpers";

const ZERO_ADDRESS = Address.zero();

export function handleStaked(event: Staked): void {
  const gauge = Gauge.load(event.address);
  if (gauge == null) return;
  gauge.totalStaked = gauge.totalStaked.plus(event.params.amount);
  gauge.updatedAt = event.block.timestamp;
  gauge.save();
  saveAction(event.address, event.params.account, "STAKE", event.params.amount, ZERO_BI, event);
}

export function handleWithdrawn(event: Withdrawn): void {
  const gauge = Gauge.load(event.address);
  if (gauge == null) return;
  gauge.totalStaked = gauge.totalStaked.minus(event.params.amount);
  gauge.updatedAt = event.block.timestamp;
  gauge.save();
  saveAction(event.address, event.params.account, "WITHDRAW", event.params.amount, ZERO_BI, event);
}

export function handleRewardPaid(event: RewardPaid): void {
  const gauge = Gauge.load(event.address);
  if (gauge == null) return;
  gauge.totalPaid = gauge.totalPaid.plus(event.params.reward);
  gauge.updatedAt = event.block.timestamp;
  gauge.save();
  saveAction(event.address, event.params.account, "REWARD", event.params.reward, ZERO_BI, event);
}

export function handleRewardAdded(event: RewardAdded): void {
  const gauge = Gauge.load(event.address);
  if (gauge == null) return;
  gauge.totalFunded = gauge.totalFunded.plus(event.params.amount);
  gauge.rewardRate = event.params.rewardRate;
  gauge.periodFinish = event.params.periodFinish;
  gauge.updatedAt = event.block.timestamp;
  gauge.save();
}

export function handleDepositsPauseUpdated(event: DepositsPauseUpdated): void {
  const gauge = Gauge.load(event.address);
  if (gauge == null) return;
  gauge.depositsPaused = event.params.paused;
  gauge.updatedAt = event.block.timestamp;
  gauge.save();
}

function saveAction(
  gaugeAddress: Address,
  account: Address,
  actionType: string,
  amount: BigInt,
  duration: BigInt,
  event: ethereum.Event,
): void {
  const action = new GaugeAction(eventId(event.transaction.hash, event.logIndex));
  action.gauge = gaugeAddress;
  action.account = account;
  action.action = actionType;
  action.amount = amount;
  action.duration = duration;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.txHash = event.transaction.hash;
  action.logIndex = event.logIndex;
  action.save();
}
