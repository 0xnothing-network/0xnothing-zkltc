import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  BadDebtRecognized,
  BadDebtRepaid,
  Borrowed,
  CapsUpdated,
  CollateralDeposited,
  CollateralWithdrawn,
  InterestAccrued,
  Liquidated,
  PausesUpdated,
  Repaid,
  Supplied,
  Withdrawn,
} from "../generated/LendingPool/LendingPool";
import { LendingAction, LendingMarket } from "../generated/schema";
import { eventId, NUSD, ZERO_BI } from "./helpers";

const ZERO_ADDRESS = Address.zero();
// Constructor facts of the v3 pool (no eth_call while indexing; see helpers.ts). It was
// deployed active, so the pause flags start false and the borrow index starts at WAD.
const SUPPLY_CAP = BigInt.fromString("5000000000000000000000");
const BORROW_CAP = BigInt.fromString("2500000000000000000000");
const WAD = BigInt.fromString("1000000000000000000");

export function handleInterestAccrued(event: InterestAccrued): void {
  const market = loadMarket(event);
  market.borrowIndexWad = event.params.newBorrowIndexWad;
  market.save();
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
  const market = loadMarket(event);
  market.totalBadDebtNusd = market.totalBadDebtNusd.plus(event.params.amountNusd);
  market.save();
}

export function handleBadDebtRepaid(event: BadDebtRepaid): void {
  saveAction(event, "REPAY_BAD_DEBT", event.params.payer, event.params.account, ZERO_ADDRESS, NUSD, event.params.amountNusd, ZERO_BI, ZERO_BI);
  const market = loadMarket(event);
  market.totalBadDebtNusd = market.totalBadDebtNusd.minus(event.params.amountNusd);
  market.save();
}

export function handleCapsUpdated(event: CapsUpdated): void {
  const market = loadMarket(event);
  market.supplyCapNusd = event.params.supplyCapNusd;
  market.borrowCapNusd = event.params.borrowCapNusd;
  market.save();
}

export function handlePausesUpdated(event: PausesUpdated): void {
  const market = loadMarket(event);
  market.supplyPaused = event.params.supplyPaused;
  market.borrowPaused = event.params.borrowPaused;
  market.collateralWithdrawalPaused = event.params.collateralWithdrawalPaused;
  market.save();
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
  loadMarket(event).save();
}

function loadMarket(event: ethereum.Event): LendingMarket {
  let market = LendingMarket.load(event.address);
  if (market == null) {
    market = new LendingMarket(event.address);
    market.totalBadDebtNusd = ZERO_BI;
    market.borrowIndexWad = WAD;
    market.supplyCapNusd = SUPPLY_CAP;
    market.borrowCapNusd = BORROW_CAP;
    market.supplyPaused = false;
    market.borrowPaused = false;
    market.collateralWithdrawalPaused = false;
    market.governanceReady = true;
  }
  market.updatedAt = event.block.timestamp;
  return market;
}
