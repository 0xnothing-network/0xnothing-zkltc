import { Address, BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import { Transfer } from "../generated/templates/PumpToken/PumpToken";
import { Market, TokenBalance } from "../generated/schema";

const ZERO_BI = BigInt.fromI32(0);
const ONE_BI = BigInt.fromI32(1);
const ZERO_ADDRESS = Address.fromString(
  "0x0000000000000000000000000000000000000000",
);

function tokenBalanceId(token: Address, holder: Address): Bytes {
  return token.concat(holder);
}

function isActiveHolder(market: Market, holder: Address): boolean {
  return !holder.equals(ZERO_ADDRESS) && !holder.equals(market.factory);
}

function decrementHolderCount(market: Market): void {
  if (market.holderCount.equals(ZERO_BI)) {
    log.critical("Active holder count underflow for market {}", [
      market.id.toHexString(),
    ]);
    return;
  }
  market.holderCount = market.holderCount.minus(ONE_BI);
}

function credit(
  market: Market,
  token: Address,
  holder: Address,
  amount: BigInt,
  event: Transfer,
): void {
  const id = tokenBalanceId(token, holder);
  let position = TokenBalance.load(id);
  if (position === null) {
    position = new TokenBalance(id);
    position.market = market.id;
    position.token = token;
    position.holder = holder;
    position.balance = ZERO_BI;
    position.isCreator = holder.equals(market.creator);
    position.isFactory = holder.equals(market.factory);
    position.createdAt = event.block.timestamp;
  }

  const wasActive = position.balance.gt(ZERO_BI);
  position.balance = position.balance.plus(amount);
  position.updatedAt = event.block.timestamp;
  position.updatedBlock = event.block.number;
  position.save();

  if (!wasActive && isActiveHolder(market, holder)) {
    market.holderCount = market.holderCount.plus(ONE_BI);
  }
}

function debit(
  market: Market,
  token: Address,
  holder: Address,
  amount: BigInt,
  event: Transfer,
): boolean {
  const id = tokenBalanceId(token, holder);
  const position = TokenBalance.load(id);
  if (position === null || position.balance.lt(amount)) {
    log.critical("Token balance underflow for market {} and holder {}", [
      market.id.toHexString(),
      holder.toHexString(),
    ]);
    return false;
  }

  position.balance = position.balance.minus(amount);
  position.updatedAt = event.block.timestamp;
  position.updatedBlock = event.block.number;
  position.save();

  if (position.balance.equals(ZERO_BI) && isActiveHolder(market, holder)) {
    decrementHolderCount(market);
  }
  return true;
}

export function handleTransfer(event: Transfer): void {
  const market = Market.load(event.address);
  if (market === null) {
    log.critical("Transfer references unknown 0xPump market {}", [
      event.address.toHexString(),
    ]);
    return;
  }

  if (event.params.value.equals(ZERO_BI) || event.params.from.equals(event.params.to)) {
    return;
  }

  const isMint = event.params.from.equals(ZERO_ADDRESS);
  const isBurn = event.params.to.equals(ZERO_ADDRESS);
  const isSeededInitialMint =
    isMint &&
    event.params.to.equals(market.factory) &&
    event.block.number.equals(market.createdBlock) &&
    event.transaction.hash.equals(market.createdTx);

  if (isSeededInitialMint) {
    if (!event.params.value.equals(market.curveTokenSupply)) {
      log.critical("Initial mint does not match seeded curve supply for market {}", [
        market.id.toHexString(),
      ]);
    }
    return;
  }

  if (
    !isMint &&
    !debit(market, event.address, event.params.from, event.params.value, event)
  ) {
    return;
  }
  if (!isBurn) {
    credit(market, event.address, event.params.to, event.params.value, event);
  }

  if (isMint) {
    market.totalSupply = market.totalSupply.plus(event.params.value);
  } else if (isBurn) {
    if (market.totalSupply.lt(event.params.value)) {
      log.critical("Token supply underflow for market {}", [market.id.toHexString()]);
      return;
    }
    market.totalSupply = market.totalSupply.minus(event.params.value);
  }

  market.save();
}
