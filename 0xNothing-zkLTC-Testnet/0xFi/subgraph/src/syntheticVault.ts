import { Address, BigInt, dataSource, ethereum } from "@graphprotocol/graph-ts";
import { ERC20 } from "../generated/NbtcVault/ERC20";
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
  SyntheticVault,
  WithdrawPauseUpdated,
} from "../generated/NbtcVault/SyntheticVault";
import { SyntheticAction, SyntheticMarket } from "../generated/schema";
import { eventId, ZERO_BI } from "./helpers";

const ZERO_ADDRESS = Address.zero();

export function handleInitialize(block: ethereum.Block): void {
  refreshMarket(dataSource.address(), block.timestamp, true);
}

export function handleCollateralDeposited(event: CollateralDeposited): void {
  saveAction(event, "DEPOSIT", event.params.payer, event.params.account, event.params.account, event.params.amountNusd, ZERO_BI);
}

export function handleReserveCollateralAllocated(event: ReserveCollateralAllocated): void {
  saveAction(event, "RESERVE_ALLOCATE", event.transaction.from, event.params.account, ZERO_ADDRESS, event.params.amountNusd, ZERO_BI);
}

export function handleReserveCollateralReleased(event: ReserveCollateralReleased): void {
  saveAction(event, "RESERVE_RELEASE", event.transaction.from, event.params.account, ZERO_ADDRESS, event.params.amountNusd, ZERO_BI);
}

export function handleReserveCollateralLost(event: ReserveCollateralLost): void {
  saveAction(event, "RESERVE_LOSS", event.transaction.from, event.params.account, ZERO_ADDRESS, event.params.amountNusd, ZERO_BI);
}

export function handleSyntheticMinted(event: SyntheticMinted): void {
  saveAction(event, "MINT", event.params.account, event.params.account, event.params.recipient, ZERO_BI, event.params.amountSynthetic);
}

export function handleSyntheticRepaid(event: SyntheticRepaid): void {
  saveAction(event, "REPAY", event.params.payer, event.params.account, event.params.account, ZERO_BI, event.params.amountSynthetic);
}

export function handleCollateralWithdrawn(event: CollateralWithdrawn): void {
  saveAction(event, "WITHDRAW", event.params.account, event.params.account, event.params.recipient, event.params.amountNusd, ZERO_BI);
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
}

export function handleBadDebtRecognized(event: BadDebtRecognized): void {
  saveAction(event, "BAD_DEBT", event.transaction.from, event.params.account, ZERO_ADDRESS, ZERO_BI, event.params.amountSynthetic);
}

export function handleBadDebtCovered(event: BadDebtCovered): void {
  saveAction(event, "COVER_BAD_DEBT", event.params.payer, event.params.account, ZERO_ADDRESS, ZERO_BI, event.params.amountSynthetic);
}

export function handleDebtCeilingUpdated(event: DebtCeilingUpdated): void {
  refreshMarket(event.address, event.block.timestamp, true);
}

export function handleMintPauseUpdated(event: MintPauseUpdated): void {
  refreshMarket(event.address, event.block.timestamp, true);
}

export function handleWithdrawPauseUpdated(event: WithdrawPauseUpdated): void {
  refreshMarket(event.address, event.block.timestamp, true);
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
  refreshMarket(event.address, event.block.timestamp, false);
}

function refreshMarket(address: Address, timestamp: BigInt, includeGovernance: boolean): void {
  const contract = SyntheticVault.bind(address);
  let market = SyntheticMarket.load(address);
  let governance = includeGovernance;
  if (market == null) {
    // syntheticAsset() is immutable, so it doubles as the "is this a real vault" guard
    // on first sight only. Later events reuse the stored asset instead of re-reading it.
    const assetResult = contract.try_syntheticAsset();
    if (assetResult.reverted) return;
    const asset = assetResult.value;
    market = new SyntheticMarket(address);
    market.asset = asset;
    const symbol = ERC20.bind(asset).try_symbol();
    market.symbol = symbol.reverted ? "SYNTH" : symbol.value;
    market.safetyReserve = ZERO_ADDRESS;
    market.totalCollateralNusd = ZERO_BI;
    market.totalUserCollateralNusd = ZERO_BI;
    market.totalReserveCollateralNusd = ZERO_BI;
    market.totalDebtSynthetic = ZERO_BI;
    market.totalBadDebtSynthetic = ZERO_BI;
    market.debtCeilingSynthetic = ZERO_BI;
    market.mintPaused = true;
    market.withdrawPaused = true;
    governance = true;
  }
  // The ceiling and both pause flags only move through DebtCeilingUpdated /
  // MintPauseUpdated / WithdrawPauseUpdated, so user actions skip those three reads.
  // Both pauses still being true is the pessimistic default left by a reverted read,
  // so retry rather than reporting the vault as paused forever. safetyReserve has no
  // event of its own and stays on the per-action refresh.
  if (market.mintPaused && market.withdrawPaused) governance = true;
  const safetyReserve = contract.try_safetyReserve();
  const collateral = contract.try_totalCollateralNusd();
  const userCollateral = contract.try_totalUserCollateralNusd();
  const reserveCollateral = contract.try_totalReserveCollateralNusd();
  const debt = contract.try_totalDebtSynthetic();
  const badDebt = contract.try_totalBadDebtSynthetic();
  if (!safetyReserve.reverted) market.safetyReserve = safetyReserve.value;
  if (!userCollateral.reverted && !reserveCollateral.reverted) {
    market.totalUserCollateralNusd = userCollateral.value;
    market.totalReserveCollateralNusd = reserveCollateral.value;
    market.totalCollateralNusd = userCollateral.value.plus(reserveCollateral.value);
  } else if (!collateral.reverted) {
    // Legacy vaults expose only aggregate collateral, which was entirely user-owned.
    market.totalUserCollateralNusd = collateral.value;
    market.totalReserveCollateralNusd = ZERO_BI;
    market.totalCollateralNusd = collateral.value;
  }
  if (!debt.reverted) market.totalDebtSynthetic = debt.value;
  if (!badDebt.reverted) market.totalBadDebtSynthetic = badDebt.value;
  if (governance) {
    const ceiling = contract.try_debtCeilingSynthetic();
    const mintPaused = contract.try_mintPaused();
    const withdrawPaused = contract.try_withdrawPaused();
    if (!ceiling.reverted) market.debtCeilingSynthetic = ceiling.value;
    if (!mintPaused.reverted) market.mintPaused = mintPaused.value;
    if (!withdrawPaused.reverted) market.withdrawPaused = withdrawPaused.value;
  }
  market.updatedAt = timestamp;
  market.save();
}
