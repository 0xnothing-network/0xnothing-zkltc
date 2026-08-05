import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { BootstrapCompleted, Burn, Mint, Swap as SwapEvent, Sync } from "../generated/templates/Pair/Pair";
import { Candle, LiquidityEvent, Pool, Swap, Token } from "../generated/schema";
import { decimalAmount, eventId, loadProtocol, ONE_BI, ZERO_BI } from "./helpers";

const NUSD = Address.fromString("0x5317e21aba902c6c7087a84457bc02ffe99604d1");
const PERIODS: i32[] = [60, 300, 3_600, 14_400, 86_400];

export function handleSync(event: Sync): void {
  const pool = Pool.load(event.address);
  if (pool == null) return;
  pool.reserve0 = event.params.reserve0;
  pool.reserve1 = event.params.reserve1;

  const token0 = Token.load(pool.token0);
  const token1 = Token.load(pool.token1);
  if (token0 != null && token1 != null && !event.params.reserve0.isZero() && !event.params.reserve1.isZero()) {
    const amount0 = decimalAmount(event.params.reserve0, token0.decimals);
    const amount1 = decimalAmount(event.params.reserve1, token1.decimals);
    pool.price0 = amount1.div(amount0);
    pool.price1 = amount0.div(amount1);
  }
  pool.updatedAt = event.block.timestamp;
  pool.save();
}

export function handleMint(event: Mint): void {
  const pool = Pool.load(event.address);
  if (pool == null) return;
  const item = new LiquidityEvent(eventId(event.transaction.hash, event.logIndex));
  item.pool = pool.id;
  item.action = "MINT";
  item.sender = event.params.sender;
  item.recipient = event.params.to;
  item.amount0 = event.params.amount0;
  item.amount1 = event.params.amount1;
  item.liquidity = event.params.liquidity;
  item.timestamp = event.block.timestamp;
  item.blockNumber = event.block.number;
  item.txHash = event.transaction.hash;
  item.logIndex = event.logIndex;
  item.save();

  pool.mintCount = pool.mintCount.plus(ONE_BI);
  pool.updatedAt = event.block.timestamp;
  pool.save();
  const protocol = loadProtocol(event.block.timestamp);
  protocol.mintCount = protocol.mintCount.plus(ONE_BI);
  protocol.save();
}

export function handleBurn(event: Burn): void {
  const pool = Pool.load(event.address);
  if (pool == null) return;
  const item = new LiquidityEvent(eventId(event.transaction.hash, event.logIndex));
  item.pool = pool.id;
  item.action = "BURN";
  item.sender = event.params.sender;
  item.recipient = event.params.to;
  item.amount0 = event.params.amount0;
  item.amount1 = event.params.amount1;
  item.liquidity = event.params.liquidity;
  item.timestamp = event.block.timestamp;
  item.blockNumber = event.block.number;
  item.txHash = event.transaction.hash;
  item.logIndex = event.logIndex;
  item.save();

  pool.burnCount = pool.burnCount.plus(ONE_BI);
  pool.updatedAt = event.block.timestamp;
  pool.save();
  const protocol = loadProtocol(event.block.timestamp);
  protocol.burnCount = protocol.burnCount.plus(ONE_BI);
  protocol.save();
}

export function handleSwap(event: SwapEvent): void {
  const pool = Pool.load(event.address);
  if (pool == null) return;
  const volume0 = event.params.amount0In.plus(event.params.amount0Out);
  const volume1 = event.params.amount1In.plus(event.params.amount1Out);
  const price = pool.token0.equals(NUSD) ? pool.price1 : pool.price0;
  // ZeroXFiPair emits Sync before Swap, so pool reserves already contain the post-swap balances.
  const reserve0Before = pool.reserve0.minus(event.params.amount0In).plus(event.params.amount0Out);
  const reserve1Before = pool.reserve1.minus(event.params.amount1In).plus(event.params.amount1Out);
  const previousPrice = priceNusdFromReserves(pool, reserve0Before, reserve1Before, price);
  let amountNusd = ZERO_BI;
  if (pool.token0.equals(NUSD)) amountNusd = volume0;
  if (pool.token1.equals(NUSD)) amountNusd = volume1;

  const swap = new Swap(eventId(event.transaction.hash, event.logIndex));
  swap.pool = pool.id;
  swap.sender = event.params.sender;
  swap.recipient = event.params.to;
  swap.amount0In = event.params.amount0In;
  swap.amount1In = event.params.amount1In;
  swap.amount0Out = event.params.amount0Out;
  swap.amount1Out = event.params.amount1Out;
  swap.amountNusd = amountNusd;
  swap.price0 = pool.price0;
  swap.price1 = pool.price1;
  swap.reserve0After = pool.reserve0;
  swap.reserve1After = pool.reserve1;
  swap.timestamp = event.block.timestamp;
  swap.blockNumber = event.block.number;
  swap.txHash = event.transaction.hash;
  swap.logIndex = event.logIndex;
  swap.save();

  pool.swapCount = pool.swapCount.plus(ONE_BI);
  pool.volume0 = pool.volume0.plus(volume0);
  pool.volume1 = pool.volume1.plus(volume1);
  pool.volumeNusd = pool.volumeNusd.plus(amountNusd);
  pool.updatedAt = event.block.timestamp;
  pool.save();

  const protocol = loadProtocol(event.block.timestamp);
  protocol.swapCount = protocol.swapCount.plus(ONE_BI);
  protocol.totalVolumeNusd = protocol.totalVolumeNusd.plus(amountNusd);
  protocol.save();
  updateCandles(pool, event.block.timestamp, previousPrice, price, volume0, volume1, amountNusd);
}

export function handleBootstrapCompleted(event: BootstrapCompleted): void {
  const pool = Pool.load(event.address);
  if (pool == null) return;
  pool.bootstrapped = true;
  pool.updatedAt = event.block.timestamp;
  pool.save();
}

function priceNusdFromReserves(
  pool: Pool,
  reserve0: BigInt,
  reserve1: BigInt,
  fallback: BigDecimal,
): BigDecimal {
  if (reserve0.isZero() || reserve1.isZero()) return fallback;
  const token0 = Token.load(pool.token0);
  const token1 = Token.load(pool.token1);
  if (token0 == null || token1 == null) return fallback;
  const amount0 = decimalAmount(reserve0, token0.decimals);
  const amount1 = decimalAmount(reserve1, token1.decimals);
  return pool.token0.equals(NUSD) ? amount0.div(amount1) : amount1.div(amount0);
}

function updateCandles(
  pool: Pool,
  timestamp: BigInt,
  previousPrice: BigDecimal,
  price: BigDecimal,
  volume0: BigInt,
  volume1: BigInt,
  volumeNusd: BigInt,
): void {
  for (let i = 0; i < PERIODS.length; i++) {
    const period = PERIODS[i];
    const periodBI = BigInt.fromI32(period);
    const bucket = timestamp.div(periodBI).times(periodBI);
    const id = pool.id.toHexString() + "-" + period.toString() + "-" + bucket.toString();
    let candle = Candle.load(id);
    if (candle == null) {
      candle = new Candle(id);
      candle.pool = pool.id;
      candle.period = period;
      candle.bucket = bucket;
      candle.timestamp = bucket;
      candle.open = previousPrice;
      candle.high = previousPrice.gt(price) ? previousPrice : price;
      candle.low = previousPrice.lt(price) ? previousPrice : price;
      candle.close = price;
      candle.volume0 = ZERO_BI;
      candle.volume1 = ZERO_BI;
      candle.volumeNusd = ZERO_BI;
      candle.tradeCount = ZERO_BI;
    } else {
      if (previousPrice.gt(candle.high)) candle.high = previousPrice;
      if (previousPrice.lt(candle.low)) candle.low = previousPrice;
      if (price.gt(candle.high)) candle.high = price;
      if (price.lt(candle.low)) candle.low = price;
      candle.close = price;
    }
    candle.volume0 = candle.volume0.plus(volume0);
    candle.volume1 = candle.volume1.plus(volume1);
    candle.volumeNusd = candle.volumeNusd.plus(volumeNusd);
    candle.tradeCount = candle.tradeCount.plus(ONE_BI);
    candle.save();
  }
}
