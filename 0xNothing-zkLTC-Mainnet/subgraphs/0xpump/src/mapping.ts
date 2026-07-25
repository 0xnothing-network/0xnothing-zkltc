import { BigDecimal, BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  CreationFeePaid,
  ProtocolFeesWithdrawn,
  TokenCurveReopened,
  TokenCreated,
  TokenGraduated,
  TokenReadyForGraduation,
  TokenTraded,
} from "../generated/ZeroXPump/ZeroXPump";
import { PumpToken as PumpTokenTemplate } from "../generated/templates";
import {
  Account,
  Candle,
  CreationFeePayment,
  CurveReopening,
  FeeWithdrawal,
  Graduation,
  GraduationReadiness,
  Market,
  Protocol,
  TokenBalance,
  Trade,
} from "../generated/schema";

const PROTOCOL_ID = "global";
const ZERO_BI = BigInt.fromI32(0);
const ONE_BI = BigInt.fromI32(1);
const MAX_BPS_BI = BigInt.fromI32(10_000);
const WAD_BI = BigInt.fromString("1000000000000000000");
const WAD_BD = WAD_BI.toBigDecimal();
const CANDLE_PERIODS: i32[] = [1, 15, 60, 240, 1440];

function eventId(txHash: Bytes, logIndex: BigInt): Bytes {
  return txHash.concatI32(logIndex.toI32());
}

function tokenBalanceId(token: Bytes, holder: Bytes): Bytes {
  return token.concat(holder);
}

function getProtocol(timestamp: BigInt): Protocol {
  let protocol = Protocol.load(PROTOCOL_ID);
  if (protocol === null) {
    protocol = new Protocol(PROTOCOL_ID);
    protocol.tokenCount = ZERO_BI;
    protocol.activeTokenCount = ZERO_BI;
    protocol.readyTokenCount = ZERO_BI;
    protocol.graduatedTokenCount = ZERO_BI;
    protocol.tradeCount = ZERO_BI;
    protocol.buyCount = ZERO_BI;
    protocol.sellCount = ZERO_BI;
    protocol.totalVolumeNusd = ZERO_BI;
    protocol.totalTradeFeesNusd = ZERO_BI;
    protocol.totalCreationFeesNusd = ZERO_BI;
    protocol.totalFeesNusd = ZERO_BI;
    protocol.totalFeesWithdrawnNusd = ZERO_BI;
  }
  protocol.updatedAt = timestamp;
  return protocol;
}

function getAccount(address: Bytes, timestamp: BigInt): Account {
  let account = Account.load(address);
  if (account === null) {
    account = new Account(address);
    account.createdTokenCount = ZERO_BI;
    account.tradeCount = ZERO_BI;
    account.buyCount = ZERO_BI;
    account.sellCount = ZERO_BI;
    account.buyVolumeNusd = ZERO_BI;
    account.sellVolumeNusd = ZERO_BI;
    account.feesPaidNusd = ZERO_BI;
    account.createdAt = timestamp;
  }
  account.updatedAt = timestamp;
  return account;
}

function guardedDecrement(value: BigInt): BigInt {
  return value.gt(ZERO_BI) ? value.minus(ONE_BI) : ZERO_BI;
}

function progressBps(value: BigInt): i32 {
  return value.ge(MAX_BPS_BI) ? 10_000 : value.toI32();
}

function priceFromWad(value: BigInt): BigDecimal {
  return value.toBigDecimal().div(WAD_BD);
}

function initialPriceWad(virtualNusd: BigInt, virtualToken: BigInt): BigInt {
  if (virtualToken.equals(ZERO_BI)) return ZERO_BI;
  return virtualNusd.times(WAD_BI).div(virtualToken);
}

function marketCapNusd(priceNusdWad: BigInt, totalSupply: BigInt): BigInt {
  return priceNusdWad.times(totalSupply).div(WAD_BI);
}

function updateCandle(
  market: Market,
  period: i32,
  timestamp: BigInt,
  previousPrice: BigDecimal,
  price: BigDecimal,
  nusdAmount: BigInt,
  tokenAmount: BigInt,
  isBuy: boolean,
): void {
  const periodSeconds = BigInt.fromI32(period * 60);
  const bucket = timestamp.div(periodSeconds).times(periodSeconds);
  const id =
    market.id.toHexString() + "-" + period.toString() + "-" + bucket.toString();
  let candle = Candle.load(id);

  if (candle === null) {
    candle = new Candle(id);
    candle.market = market.id;
    candle.period = period;
    candle.bucket = bucket;
    candle.timestamp = bucket;
    candle.open = previousPrice;
    candle.high = previousPrice.gt(price) ? previousPrice : price;
    candle.low = previousPrice.lt(price) ? previousPrice : price;
    candle.close = price;
    candle.volumeNusd = ZERO_BI;
    candle.volumeToken = ZERO_BI;
    candle.buyCount = ZERO_BI;
    candle.sellCount = ZERO_BI;
    candle.tradeCount = ZERO_BI;
  } else {
    if (price.gt(candle.high)) candle.high = price;
    if (price.lt(candle.low)) candle.low = price;
    candle.close = price;
  }

  candle.volumeNusd = candle.volumeNusd.plus(nusdAmount);
  candle.volumeToken = candle.volumeToken.plus(tokenAmount);
  candle.tradeCount = candle.tradeCount.plus(ONE_BI);
  if (isBuy) {
    candle.buyCount = candle.buyCount.plus(ONE_BI);
  } else {
    candle.sellCount = candle.sellCount.plus(ONE_BI);
  }
  candle.save();
}

export function handleTokenCreated(event: TokenCreated): void {
  if (Market.load(event.params.token) !== null) {
    log.warning("Ignoring duplicate TokenCreated for {}", [event.params.token.toHexString()]);
    return;
  }

  const creator = getAccount(event.params.creator, event.block.timestamp);
  creator.createdTokenCount = creator.createdTokenCount.plus(ONE_BI);
  creator.save();

  const priceNusdWad = initialPriceWad(
    event.params.virtualNusdReserve,
    event.params.virtualTokenReserve,
  );
  const market = new Market(event.params.token);
  market.token = event.params.token;
  market.factory = event.address;
  market.creator = event.params.creator;
  market.creatorAccount = creator.id;
  market.contentHash = event.params.contentHash;
  market.name = event.params.name;
  market.symbol = event.params.symbol;
  market.decimals = 18;
  market.metadataURI = event.params.metadataURI;
  market.imageURI = event.params.imageURI;
  market.status = "CURVE";
  market.holderCount = ZERO_BI;
  market.totalSupply = event.params.totalSupply;
  market.curveTokenSupply = event.params.curveTokenSupply;
  market.reserveNusd = ZERO_BI;
  market.reserveToken = event.params.curveTokenSupply;
  market.virtualNusd = event.params.virtualNusdReserve;
  market.virtualToken = event.params.virtualTokenReserve;
  market.circulatingSupply = event.params.totalSupply.ge(event.params.curveTokenSupply)
    ? event.params.totalSupply.minus(event.params.curveTokenSupply)
    : ZERO_BI;
  market.priceNusdWad = priceNusdWad;
  market.priceNusd = priceFromWad(priceNusdWad);
  market.marketCapNusd = marketCapNusd(priceNusdWad, event.params.totalSupply);
  market.graduationThresholdNusd = event.params.graduationThresholdNusd;
  market.graduationReserveThresholdNusd = event.params.graduationReserveThresholdNusd;
  market.progressBps = 0;
  market.creationFeeNusd = event.params.creationFeeNusd;
  market.tradeCount = ZERO_BI;
  market.buyCount = ZERO_BI;
  market.sellCount = ZERO_BI;
  market.volumeNusd = ZERO_BI;
  market.feesNusd = ZERO_BI;
  market.createdAt = event.block.timestamp;
  market.createdBlock = event.block.number;
  market.createdTx = event.transaction.hash;
  market.lastTradeAt = event.block.timestamp;
  market.updatedAt = event.block.timestamp;
  market.save();

  // initialize() emits the initial mint before TokenCreated, so a dynamic
  // template cannot observe it. Seed the curve inventory authoritatively here.
  const factoryBalance = new TokenBalance(
    tokenBalanceId(event.params.token, event.address),
  );
  factoryBalance.market = market.id;
  factoryBalance.token = event.params.token;
  factoryBalance.holder = event.address;
  factoryBalance.balance = event.params.curveTokenSupply;
  factoryBalance.isCreator = event.address.equals(event.params.creator);
  factoryBalance.isFactory = true;
  factoryBalance.createdAt = event.block.timestamp;
  factoryBalance.updatedAt = event.block.timestamp;
  factoryBalance.updatedBlock = event.block.number;
  factoryBalance.save();

  PumpTokenTemplate.create(event.params.token);

  const protocol = getProtocol(event.block.timestamp);
  protocol.tokenCount = protocol.tokenCount.plus(ONE_BI);
  protocol.activeTokenCount = protocol.activeTokenCount.plus(ONE_BI);
  protocol.save();
}

export function handleCreationFeePaid(event: CreationFeePaid): void {
  const owner = getAccount(event.params.owner, event.block.timestamp);
  owner.feesPaidNusd = owner.feesPaidNusd.plus(event.params.creationFeeNusd);
  owner.save();

  const payment = new CreationFeePayment(eventId(event.transaction.hash, event.logIndex));
  payment.owner = event.params.owner;
  payment.ownerAccount = owner.id;
  payment.contentHash = event.params.contentHash;
  payment.feeNusd = event.params.creationFeeNusd;
  payment.timestamp = event.block.timestamp;
  payment.blockNumber = event.block.number;
  payment.txHash = event.transaction.hash;
  payment.logIndex = event.logIndex;
  payment.save();

  const protocol = getProtocol(event.block.timestamp);
  protocol.totalCreationFeesNusd = protocol.totalCreationFeesNusd.plus(
    event.params.creationFeeNusd,
  );
  protocol.totalFeesNusd = protocol.totalFeesNusd.plus(event.params.creationFeeNusd);
  protocol.save();
}

export function handleTokenTraded(event: TokenTraded): void {
  const market = Market.load(event.params.token);
  if (market === null) {
    log.error("TokenTraded references unknown market {}", [event.params.token.toHexString()]);
    return;
  }

  const previousPrice = market.priceNusd;

  const trader = getAccount(event.params.trader, event.block.timestamp);
  trader.tradeCount = trader.tradeCount.plus(ONE_BI);
  trader.feesPaidNusd = trader.feesPaidNusd.plus(event.params.feeNusd);
  if (event.params.isBuy) {
    trader.buyCount = trader.buyCount.plus(ONE_BI);
    trader.buyVolumeNusd = trader.buyVolumeNusd.plus(event.params.curveNusdAmount);
  } else {
    trader.sellCount = trader.sellCount.plus(ONE_BI);
    trader.sellVolumeNusd = trader.sellVolumeNusd.plus(event.params.curveNusdAmount);
  }
  trader.save();

  const normalizedPrice = priceFromWad(event.params.spotPriceNusdWad);
  const trade = new Trade(eventId(event.transaction.hash, event.logIndex));
  trade.market = market.id;
  trade.trader = event.params.trader;
  trade.traderAccount = trader.id;
  trade.side = event.params.isBuy ? "BUY" : "SELL";
  trade.nusdAmount = event.params.curveNusdAmount;
  trade.curveNusdAmount = event.params.curveNusdAmount;
  trade.userNusdAmount = event.params.userNusdAmount;
  trade.tokenAmount = event.params.tokenAmount;
  trade.feeNusd = event.params.feeNusd;
  trade.priceNusdWad = event.params.spotPriceNusdWad;
  trade.priceNusd = normalizedPrice;
  trade.reserveNusdAfter = event.params.realNusdReserveAfter;
  trade.reserveTokenAfter = event.params.tokenReserveAfter;
  trade.virtualNusdAfter = event.params.virtualNusdReserveAfter;
  trade.virtualTokenAfter = event.params.virtualTokenReserveAfter;
  trade.circulatingSupplyAfter = event.params.circulatingSupplyAfter;
  trade.progressBps = progressBps(event.params.curveProgressBps);
  trade.timestamp = event.block.timestamp;
  trade.blockNumber = event.block.number;
  trade.txHash = event.transaction.hash;
  trade.logIndex = event.logIndex;
  trade.save();

  market.reserveNusd = event.params.realNusdReserveAfter;
  market.reserveToken = event.params.tokenReserveAfter;
  market.virtualNusd = event.params.virtualNusdReserveAfter;
  market.virtualToken = event.params.virtualTokenReserveAfter;
  market.circulatingSupply = event.params.circulatingSupplyAfter;
  market.priceNusdWad = event.params.spotPriceNusdWad;
  market.priceNusd = normalizedPrice;
  market.marketCapNusd = marketCapNusd(
    event.params.spotPriceNusdWad,
    market.totalSupply,
  );
  market.progressBps = progressBps(event.params.curveProgressBps);
  market.tradeCount = market.tradeCount.plus(ONE_BI);
  market.volumeNusd = market.volumeNusd.plus(event.params.curveNusdAmount);
  market.feesNusd = market.feesNusd.plus(event.params.feeNusd);
  market.lastTradeAt = event.block.timestamp;
  market.updatedAt = event.block.timestamp;
  if (event.params.isBuy) {
    market.buyCount = market.buyCount.plus(ONE_BI);
  } else {
    market.sellCount = market.sellCount.plus(ONE_BI);
  }
  market.save();

  const protocol = getProtocol(event.block.timestamp);
  protocol.tradeCount = protocol.tradeCount.plus(ONE_BI);
  protocol.totalVolumeNusd = protocol.totalVolumeNusd.plus(event.params.curveNusdAmount);
  protocol.totalTradeFeesNusd = protocol.totalTradeFeesNusd.plus(event.params.feeNusd);
  protocol.totalFeesNusd = protocol.totalFeesNusd.plus(event.params.feeNusd);
  if (event.params.isBuy) {
    protocol.buyCount = protocol.buyCount.plus(ONE_BI);
  } else {
    protocol.sellCount = protocol.sellCount.plus(ONE_BI);
  }
  protocol.save();

  for (let i = 0; i < CANDLE_PERIODS.length; i++) {
    updateCandle(
      market,
      CANDLE_PERIODS[i],
      event.block.timestamp,
      previousPrice,
      normalizedPrice,
      event.params.curveNusdAmount,
      event.params.tokenAmount,
      event.params.isBuy,
    );
  }
}

export function handleTokenReadyForGraduation(event: TokenReadyForGraduation): void {
  const market = Market.load(event.params.token);
  if (market === null) {
    log.error("TokenReadyForGraduation references unknown market {}", [
      event.params.token.toHexString(),
    ]);
    return;
  }

  const readiness = new GraduationReadiness(
    eventId(event.transaction.hash, event.logIndex),
  );
  readiness.market = market.id;
  readiness.reserveNusd = event.params.realNusdReserve;
  readiness.reserveToken = event.params.tokenReserve;
  readiness.thresholdNusd = event.params.thresholdNusd;
  readiness.timestamp = event.block.timestamp;
  readiness.blockNumber = event.block.number;
  readiness.txHash = event.transaction.hash;
  readiness.logIndex = event.logIndex;
  readiness.save();

  if (market.status !== "GRADUATED") {
    if (market.status !== "READY") {
      const protocol = getProtocol(event.block.timestamp);
      protocol.readyTokenCount = protocol.readyTokenCount.plus(ONE_BI);
      protocol.save();
    }
    market.status = "READY";
    market.reserveNusd = event.params.realNusdReserve;
    market.reserveToken = event.params.tokenReserve;
    market.graduationThresholdNusd = event.params.thresholdNusd;
    market.progressBps = 10_000;
    market.readyAt = event.block.timestamp;
    market.readyBlock = event.block.number;
    market.readyTx = event.transaction.hash;
    market.updatedAt = event.block.timestamp;
    market.save();
  }
}

export function handleTokenCurveReopened(event: TokenCurveReopened): void {
  const market = Market.load(event.params.token);
  if (market === null) {
    log.error("TokenCurveReopened references unknown market {}", [
      event.params.token.toHexString(),
    ]);
    return;
  }

  const reopening = new CurveReopening(eventId(event.transaction.hash, event.logIndex));
  reopening.market = market.id;
  reopening.reserveNusd = event.params.realNusdReserve;
  reopening.reserveToken = event.params.tokenReserve;
  reopening.timestamp = event.block.timestamp;
  reopening.blockNumber = event.block.number;
  reopening.txHash = event.transaction.hash;
  reopening.logIndex = event.logIndex;
  reopening.save();

  if (market.status === "READY") {
    const protocol = getProtocol(event.block.timestamp);
    protocol.readyTokenCount = guardedDecrement(protocol.readyTokenCount);
    protocol.save();
  }

  market.status = "CURVE";
  market.reserveNusd = event.params.realNusdReserve;
  market.reserveToken = event.params.tokenReserve;
  market.progressBps = market.graduationReserveThresholdNusd.equals(ZERO_BI)
    ? 0
    : progressBps(
        event.params.realNusdReserve
          .times(MAX_BPS_BI)
          .div(market.graduationReserveThresholdNusd),
      );
  market.updatedAt = event.block.timestamp;
  market.save();
}

export function handleTokenGraduated(event: TokenGraduated): void {
  const market = Market.load(event.params.token);
  if (market === null) {
    log.error("TokenGraduated references unknown market {}", [
      event.params.token.toHexString(),
    ]);
    return;
  }

  const graduation = new Graduation(eventId(event.transaction.hash, event.logIndex));
  graduation.market = market.id;
  graduation.dex = event.params.dex;
  graduation.pairId = event.params.pairId;
  graduation.pool = event.params.pool;
  graduation.nusdLiquidity = event.params.nusdLiquidity;
  graduation.tokenLiquidity = event.params.tokenLiquidity;
  graduation.lpAmount = event.params.lpAmount;
  graduation.lpRecipient = event.params.lpRecipient;
  graduation.timestamp = event.block.timestamp;
  graduation.blockNumber = event.block.number;
  graduation.txHash = event.transaction.hash;
  graduation.logIndex = event.logIndex;
  graduation.save();

  if (market.status !== "GRADUATED") {
    const protocol = getProtocol(event.block.timestamp);
    protocol.activeTokenCount = guardedDecrement(protocol.activeTokenCount);
    if (market.status === "READY") {
      protocol.readyTokenCount = guardedDecrement(protocol.readyTokenCount);
    }
    protocol.graduatedTokenCount = protocol.graduatedTokenCount.plus(ONE_BI);
    protocol.save();
  }

  market.status = "GRADUATED";
  market.reserveNusd = ZERO_BI;
  market.reserveToken = ZERO_BI;
  // Graduation burns every unsold curve token except the amount seeded as DEX liquidity.
  market.totalSupply = market.circulatingSupply.plus(event.params.tokenLiquidity);
  market.circulatingSupply = market.totalSupply;
  market.marketCapNusd = marketCapNusd(market.priceNusdWad, market.totalSupply);
  market.progressBps = 10_000;
  market.graduation = graduation.id;
  market.updatedAt = event.block.timestamp;
  market.save();
}

export function handleProtocolFeesWithdrawn(event: ProtocolFeesWithdrawn): void {
  const withdrawal = new FeeWithdrawal(eventId(event.transaction.hash, event.logIndex));
  withdrawal.recipient = event.params.recipient;
  withdrawal.amountNusd = event.params.amountNusd;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.blockNumber = event.block.number;
  withdrawal.txHash = event.transaction.hash;
  withdrawal.logIndex = event.logIndex;
  withdrawal.save();

  const protocol = getProtocol(event.block.timestamp);
  protocol.totalFeesWithdrawnNusd = protocol.totalFeesWithdrawnNusd.plus(
    event.params.amountNusd,
  );
  protocol.save();
}
