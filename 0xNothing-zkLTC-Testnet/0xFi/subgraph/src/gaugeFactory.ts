import { GaugeCreated, GaugeFunded } from "../generated/GaugeFactory/GaugeFactory";
import { Gauge, GaugeAction, Pool } from "../generated/schema";
import { LiquidityGauge as GaugeTemplate } from "../generated/templates";
import { eventId, loadProtocol, ONE_BI, ZERO_BI } from "./helpers";

export function handleGaugeCreated(event: GaugeCreated): void {
  const pool = Pool.load(event.params.pair);
  if (pool == null) return;
  const gauge = new Gauge(event.params.gauge);
  gauge.pool = pool.id;
  gauge.totalStaked = ZERO_BI;
  gauge.totalFunded = ZERO_BI;
  gauge.totalPaid = ZERO_BI;
  gauge.rewardRate = ZERO_BI;
  gauge.periodFinish = ZERO_BI;
  gauge.depositsPaused = false;
  gauge.createdAt = event.block.timestamp;
  gauge.updatedAt = event.block.timestamp;
  gauge.save();

  const protocol = loadProtocol(event.block.timestamp);
  protocol.gaugeCount = protocol.gaugeCount.plus(ONE_BI);
  protocol.save();
  GaugeTemplate.create(event.params.gauge);
}

export function handleGaugeFunded(event: GaugeFunded): void {
  const gauge = Gauge.load(event.params.gauge);
  if (gauge == null) return;
  const action = new GaugeAction(eventId(event.transaction.hash, event.logIndex));
  action.gauge = gauge.id;
  action.account = event.transaction.from;
  action.action = "FUND";
  action.amount = event.params.amount;
  action.duration = event.params.duration;
  action.timestamp = event.block.timestamp;
  action.blockNumber = event.block.number;
  action.txHash = event.transaction.hash;
  action.logIndex = event.logIndex;
  action.save();
}
