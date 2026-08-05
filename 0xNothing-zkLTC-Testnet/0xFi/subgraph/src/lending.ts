import { Address, BigInt, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  BadDebtRecognized,
  BadDebtRepaid,
  Borrowed,
  CapsUpdated,
  CollateralDeposited,
  CollateralWithdrawn,
  InterestAccrued,
  LendingPool,
  Liquidated,
  PausesUpdated,
  Repaid,
  Supplied,
  Withdrawn,
} from "../generated/LendingPool/LendingPool";
import { LendingAction, LendingMarket } from "../generated/schema";
import { eventId, ZERO_BI } from "./helpers";

const NUSD = Address.fromString("0x5317e21aba902c6c7087a84457bc02ffe99604d1");
const ZERO_ADDRESS = Address.zero();

export function handleInitialize(block: ethereum.Block): void {
  refreshMarket(dataSource.address(), block.timestamp);
}

export function handleInterestAccrued(event: InterestAccrued): void {
  refreshMarket(event.address, event.block.timestamp);
}

export function handleSupplied(event: Supplied): void {
  saveAction(event, "SUPPLY", event.params.payer, event.params.account, event.params.account, NUSD, event.params.amountNusd, ZERO_BI, event.params.sharesMinted);
}

export function handleWithdrawn(event: Withdrawn): void {
  saveAction(event, "WITHDRAW", event.params.account, event.params.account, event.params.recipient, NUSD, event.params.amountNusd, ZERO_BI, event.params.sharesBurned);
}

export function handleCollateralDeposited(event: CollateralDeposited): void {
  saveAction(event, "COLLATERAL_DEPOSIT", event.params.payer, event.params.account, event.params.account, event.params.asset, ZERO_BI, event.params.amount, ZERO_BI);
}

export function handleCollateralWithdrawn(event: CollateralWithdrawn): void {
  saveAction(event, "COLLATERAL_WITHDRAW", event.params.account, event.params.account, event.params.recipient, event.params.asset, ZERO_BI, event.params.amount, ZERO_BI);
}

export function handleBorrowed(event: Borrowed): void {
  saveAction(event, "BORROW", event.params.account, event.params.account, event.params.recipient, NUSD, event.params.amountNusd, ZERO_BI, event.params.debtSharesMinted);
}

export function handleRepaid(event: Repaid): void {
  saveAction(event, "REPAY", event.params.payer, event.params.account, event.params.account, NUSD, event.params.amountNusd, ZERO_BI, event.params.debtSharesBurned);
}

export function handleLiquidated(event: Liquidated): void {
  saveAction(event, "LIQUIDATE", event.params.liquidator, event.params.account, event.params.recipient, event.params.collateralAsset, event.params.amountRepaidNusd, event.params.collateralOut, ZERO_BI);
}

export function handleBadDebtRecognized(event: BadDebtRecognized): void {
  saveAction(event, "BAD_DEBT", event.transaction.from, event.params.account, ZERO_ADDRESS, NUSD, event.params.amountNusd, ZERO_BI, ZERO_BI);
}

export function handleBadDebtRepaid(event: BadDebtRepaid): void {
  saveAction(event, "REPAY_BAD_DEBT", event.params.payer, event.params.account, ZERO_ADDRESS, NUSD, event.params.amountNusd, ZERO_BI, ZERO_BI);
}

export function handleCapsUpdated(event: CapsUpdated): void {
  refreshMarket(event.address, event.block.timestamp);
}

export function handlePausesUpdated(event: PausesUpdated): void {
  refreshMarket(event.address, event.block.timestamp);
}

function saveAction(
  event: ethereum.Event,
  actionType: string,
  actor: Address,
  account: Address,
  recipient: Address,
  asset: Address,
  amountNusd: BigInt,
  assetAmount: BigInt,
  shares: BigInt,
): void {
  const action = new LendingAction(eventId(event.transaction.hash, event.logIndex));
  action.market = event.address;
  action.action = actionType;
  action.actor = actor;
  action.account = account;
  action.recipient = recipient;
  action.asset = asset;
  action.amountNusd = amountNusd;
  action.assetAmount = assetAmount;
  action.shares = shares;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.txHash = event.transaction.hash;
  action.logIndex = event.logIndex;
  action.save();
  refreshMarket(event.address, event.block.timestamp);
}

function refreshMarket(address: Address, timestamp: BigInt): void {
  const contract = LendingPool.bind(address);
  let market = LendingMarket.load(address);
  if (market == null) {
    market = new LendingMarket(address);
    market.totalSuppliedNusd = ZERO_BI;
    market.totalBorrowedNusd = ZERO_BI;
    market.totalBadDebtNusd = ZERO_BI;
    market.borrowIndexWad = ZERO_BI;
    market.supplyCapNusd = ZERO_BI;
    market.borrowCapNusd = ZERO_BI;
    market.supplyPaused = true;
    market.borrowPaused = true;
    market.collateralWithdrawalPaused = true;
  }
  const supplied = contract.try_totalSupplied();
  const borrowed = contract.try_totalBorrowed();
  const badDebt = contract.try_totalBadDebtNusd();
  const borrowIndex = contract.try_borrowIndexWad();
  const supplyCap = contract.try_supplyCapNusd();
  const borrowCap = contract.try_borrowCapNusd();
  const supplyPaused = contract.try_supplyPaused();
  const borrowPaused = contract.try_borrowPaused();
  const collateralPaused = contract.try_collateralWithdrawalPaused();
  if (!supplied.reverted) market.totalSuppliedNusd = supplied.value;
  if (!borrowed.reverted) market.totalBorrowedNusd = borrowed.value;
  if (!badDebt.reverted) market.totalBadDebtNusd = badDebt.value;
  if (!borrowIndex.reverted) market.borrowIndexWad = borrowIndex.value;
  if (!supplyCap.reverted) market.supplyCapNusd = supplyCap.value;
  if (!borrowCap.reverted) market.borrowCapNusd = borrowCap.value;
  if (!supplyPaused.reverted) market.supplyPaused = supplyPaused.value;
  if (!borrowPaused.reverted) market.borrowPaused = borrowPaused.value;
  if (!collateralPaused.reverted) market.collateralWithdrawalPaused = collateralPaused.value;
  market.updatedAt = timestamp;
  market.save();
}
