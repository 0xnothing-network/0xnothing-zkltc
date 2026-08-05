import { PairCreated } from "../generated/ZeroXFiFactory/ZeroXFiFactory";
import { Pool } from "../generated/schema";
import { Pair as PairTemplate } from "../generated/templates";
import { loadProtocol, loadToken, ONE_BI, ZERO_BD, ZERO_BI } from "./helpers";

export function handlePairCreated(event: PairCreated): void {
  const token0 = loadToken(event.params.token0, event.block.timestamp);
  const token1 = loadToken(event.params.token1, event.block.timestamp);

  const pool = new Pool(event.params.pair);
  pool.pairId = event.params.pairId;
  pool.token0 = token0.id;
  pool.token1 = token1.id;
  pool.protectedBootstrap = event.params.protectedBootstrap;
  pool.bootstrapped = !event.params.protectedBootstrap;
  pool.reserve0 = ZERO_BI;
  pool.reserve1 = ZERO_BI;
  pool.price0 = ZERO_BD;
  pool.price1 = ZERO_BD;
  pool.swapCount = ZERO_BI;
  pool.mintCount = ZERO_BI;
  pool.burnCount = ZERO_BI;
  pool.volume0 = ZERO_BI;
  pool.volume1 = ZERO_BI;
  pool.volumeNusd = ZERO_BI;
  pool.createdAt = event.block.timestamp;
  pool.createdBlock = event.block.number;
  pool.createdTx = event.transaction.hash;
  pool.updatedAt = event.block.timestamp;
  pool.save();

  const protocol = loadProtocol(event.block.timestamp);
  protocol.pairCount = protocol.pairCount.plus(ONE_BI);
  protocol.save();
  PairTemplate.create(event.params.pair);
}
