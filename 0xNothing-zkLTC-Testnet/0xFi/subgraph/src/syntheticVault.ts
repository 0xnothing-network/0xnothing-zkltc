import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  BadDebtCovered,
  BadDebtRecognized,
  CollateralDeposited,
  CollateralWithdrawn,
  DebtCeilingUpdated,
  MintPauseUpdated,
  PositionLiquidated,
  ReserveCollateralAllocated,
  ReserveCollateralLost,
  ReserveCollateralReleased,
  SyntheticMinted,
  SyntheticRepaid,
  WithdrawPauseUpdated,
} from "../generated/NbtcVault/SyntheticVault";
import { SyntheticAction, SyntheticMarket } from "../generated/schema";
import { eventId, NBTC, NETH, ZERO_BI } from "./helpers";

const ZERO_ADDRESS = Address.zero();
// Constructor facts of the v3 vaults (no eth_call while indexing; see helpers.ts).
const NBTC_VAULT = Address.fromString("0x094343b925941d00424e8440c572231d6b93a751");
const NETH_VAULT = Address.fromString("0xf909924f8bd003673d97667ea150173f87fafa1b");
const SAFETY_RESERVE = Address.fromString("0xa8701a2ed4a085105ede2f68ba2383b98c5d6e6b");
const NBTC_DEBT_CEILING = BigInt.fromString("10000000000000000");
const NETH_DEBT_CEILING = BigInt.fromString("250000000000000000");

// Every total below mirrors the matching line in SyntheticVault.sol, which emits an event
// for each change. The vaults were deployed active, so both pause flags start false.

export function handleCollateralDeposited(event: CollateralDeposited): void {
  saveAction(event, "DEPOSIT", event.params.payer, event.params.account, event.params.account, event.params.amountNusd, ZERO_BI);
  const market = loadMarket(event);
  market.totalUserCollateralNusd = market.totalUserCollateralNusd.plus(event.params.amountNusd);
  saveMarket(market);
}

export function handleReserveCollateralAllocated(event: ReserveCollateralAllocated): void {
  saveAction(event, "RESERVE_ALLOCATE", event.transaction.from, event.params.account, ZERO_ADDRESS, event.params.amountNusd, ZERO_BI);
  const market = loadMarket(event);
  market.totalReserveCollateralNusd = market.totalReserveCollateralNusd.plus(event.params.amountNusd);
  saveMarket(market);
}

export function handleReserveCollateralReleased(event: ReserveCollateralReleased): void {
  saveAction(event, "RESERVE_RELEASE", event.transaction.from, event.params.account, ZERO_ADDRESS, event.params.amountNusd, ZERO_BI);
  const market = loadMarket(event);
  market.totalReserveCollateralNusd = market.totalReserveCollateralNusd.minus(event.params.amountNusd);
  saveMarket(market);
}

export function handleReserveCollateralLost(event: ReserveCollateralLost): void {
  saveAction(event, "RESERVE_LOSS", event.transaction.from, event.params.account, ZERO_ADDRESS, event.params.amountNusd, ZERO_BI);
  const market = loadMarket(event);
  market.totalReserveCollateralNusd = market.totalReserveCollateralNusd.minus(event.params.amountNusd);
  // Only liquidation emits this, before PositionLiquidated takes the whole seized amount
  // from user collateral; adding the reserve share back leaves the user loss exact.
  market.totalUserCollateralNusd = market.totalUserCollateralNusd.plus(event.params.amountNusd);
  saveMarket(market);
}

export function handleSyntheticMinted(event: SyntheticMinted): void {
  saveAction(event, "MINT", event.params.account, event.params.account, event.params.recipient, ZERO_BI, event.params.amountSynthetic);
  const market = loadMarket(event);
  market.totalDebtSynthetic = market.totalDebtSynthetic.plus(event.params.amountSynthetic);
  saveMarket(market);
}

export function handleSyntheticRepaid(event: SyntheticRepaid): void {
  saveAction(event, "REPAY", event.params.payer, event.params.account, event.params.account, ZERO_BI, event.params.amountSynthetic);
  const market = loadMarket(event);
  market.totalDebtSynthetic = market.totalDebtSynthetic.minus(event.params.amountSynthetic);
  saveMarket(market);
}

export function handleCollateralWithdrawn(event: CollateralWithdrawn): void {
  saveAction(event, "WITHDRAW", event.params.account, event.params.account, event.params.recipient, event.params.amountNusd, ZERO_BI);
  const market = loadMarket(event);
  market.totalUserCollateralNusd = market.totalUserCollateralNusd.minus(event.params.amountNusd);
  saveMarket(market);
}

export function handlePositionLiquidated(event: PositionLiquidated): void {
  saveAction(
    event,
    "LIQUIDATE",
    event.params.liquidator,
    event.params.account,
    event.params.recipient,
    event.params.seizedNusd,
    event.params.repaidSynthetic,
  );
  const market = loadMarket(event);
  market.totalDebtSynthetic = market.totalDebtSynthetic.minus(event.params.repaidSynthetic);
  market.totalUserCollateralNusd = market.totalUserCollateralNusd.minus(event.params.seizedNusd);
  saveMarket(market);
}

export function handleBadDebtRecognized(event: BadDebtRecognized): void {
  saveAction(event, "BAD_DEBT", event.transaction.from, event.params.account, ZERO_ADDRESS, ZERO_BI, event.params.amountSynthetic);
  const market = loadMarket(event);
  market.totalDebtSynthetic = market.totalDebtSynthetic.minus(event.params.amountSynthetic);
  market.totalBadDebtSynthetic = market.totalBadDebtSynthetic.plus(event.params.amountSynthetic);
  saveMarket(market);
}

export function handleBadDebtCovered(event: BadDebtCovered): void {
  saveAction(event, "COVER_BAD_DEBT", event.params.payer, event.params.account, ZERO_ADDRESS, ZERO_BI, event.params.amountSynthetic);
  const market = loadMarket(event);
  market.totalBadDebtSynthetic = market.totalBadDebtSynthetic.minus(event.params.amountSynthetic);
  saveMarket(market);
}

export function handleDebtCeilingUpdated(event: DebtCeilingUpdated): void {
  const market = loadMarket(event);
  market.debtCeilingSynthetic = event.params.newCeilingSynthetic;
  saveMarket(market);
}

export function handleMintPauseUpdated(event: MintPauseUpdated): void {
  const market = loadMarket(event);
  market.mintPaused = event.params.paused;
  saveMarket(market);
}

export function handleWithdrawPauseUpdated(event: WithdrawPauseUpdated): void {
  const market = loadMarket(event);
  market.withdrawPaused = event.params.paused;
  saveMarket(market);
}

function saveAction(
  event: ethereum.Event,
  actionType: string,
  actor: Address,
  account: Address,
  recipient: Address,
  collateralNusd: BigInt,
  syntheticAmount: BigInt,
): void {
  const action = new SyntheticAction(eventId(event.transaction.hash, event.logIndex));
  action.market = event.address;
  action.action = actionType;
  action.actor = actor;
  action.account = account;
  action.recipient = recipient;
  action.collateralNusd = collateralNusd;
  action.syntheticAmount = syntheticAmount;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.txHash = event.transaction.hash;
  action.logIndex = event.logIndex;
  action.save();
}

function loadMarket(event: ethereum.Event): SyntheticMarket {
  let market = SyntheticMarket.load(event.address);
  if (market == null) {
    const isBtc = event.address.equals(NBTC_VAULT);
    if (!isBtc && !event.address.equals(NETH_VAULT)) throw new Error("Unknown synthetic vault " + event.address.toHexString());
    market = new SyntheticMarket(event.address);
    market.asset = isBtc ? NBTC : NETH;
    market.symbol = isBtc ? "nBTC" : "nETH";
    market.safetyReserve = SAFETY_RESERVE;
    market.totalCollateralNusd = ZERO_BI;
    market.totalUserCollateralNusd = ZERO_BI;
    market.totalReserveCollateralNusd = ZERO_BI;
    market.totalDebtSynthetic = ZERO_BI;
    market.totalBadDebtSynthetic = ZERO_BI;
    market.debtCeilingSynthetic = isBtc ? NBTC_DEBT_CEILING : NETH_DEBT_CEILING;
    market.mintPaused = false;
    market.withdrawPaused = false;
    market.governanceReady = true;
  }
  market.updatedAt = event.block.timestamp;
  return market;
}

function saveMarket(market: SyntheticMarket): void {
  market.totalCollateralNusd = market.totalUserCollateralNusd.plus(market.totalReserveCollateralNusd);
  market.save();
}
