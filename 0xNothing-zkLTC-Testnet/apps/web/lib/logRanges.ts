/**
 * The LiteForge RPC refuses an eth_getLogs that spans more than 2,000 blocks
 * ("eth_getLogs range exceeds 2000 blocks; split the range"), so every log scan
 * goes through windows of at most this size.
 */
export const MAX_LOG_RANGE_BLOCKS = 2_000n;

export interface LogRange {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Splits the inclusive range into windows the RPC accepts, oldest first. The
 * windows are aligned to the newest block, so a scan that walks them from the end
 * and stops early has covered the most recent blocks without a gap.
 */
export function logRanges(fromBlock: bigint, toBlock: bigint, size: bigint = MAX_LOG_RANGE_BLOCKS): LogRange[] {
  if (size <= 0n) throw new RangeError("Log range size must be positive");
  const ranges: LogRange[] = [];
  for (let end = toBlock; end >= fromBlock; end -= size) {
    const start = end - size + 1n;
    ranges.push({ fromBlock: start > fromBlock ? start : fromBlock, toBlock: end });
  }
  return ranges.reverse();
}
