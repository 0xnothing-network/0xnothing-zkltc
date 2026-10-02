/** ERC-20 Transfer(address,address,uint256), with both addresses indexed. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/i;

interface TokenReceipt {
  status: string;
  logs: readonly {
    address: string;
    topics: readonly string[];
    data: string;
    removed?: boolean;
  }[];
}

/** Net tokens received in this transaction; unrelated transfers never count. */
export function deliveredTokenAmount(receipt: TokenReceipt, token: string, recipient: string): bigint {
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  if (![token, recipient].every((value) => /^0x[0-9a-f]{40}$/i.test(value))) {
    throw new Error("Invalid token delivery address");
  }
  const contract = token.toLowerCase();
  const account = recipient.toLowerCase();
  let delivered = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.removed || log.topics.length !== 3 || !ADDRESS_TOPIC.test(log.topics[1]!)
      || !ADDRESS_TOPIC.test(log.topics[2]!) || !/^0x[0-9a-f]{64}$/i.test(log.data)) {
      throw new Error("Invalid token delivery log");
    }
    const amount = BigInt(log.data);
    if (`0x${log.topics[2]!.slice(-40).toLowerCase()}` === account) delivered += amount;
    if (`0x${log.topics[1]!.slice(-40).toLowerCase()}` === account) delivered -= amount;
  }
  if (delivered <= 0n) throw new Error("No tokens delivered by this transaction");
  return delivered;
}
