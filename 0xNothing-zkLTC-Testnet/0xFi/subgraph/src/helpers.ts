import { Address, BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Protocol, Token } from "../generated/schema";

export const ZERO_BI = BigInt.zero();
export const ZERO_BD = BigDecimal.fromString("0");
export const ONE_BI = BigInt.fromI32(1);

// The LiteForge RPC keeps only ~64 blocks of state, so a handler cannot eth_call while the
// indexer catches up (graph-node retries "historical state is not available" forever).
// Deployment facts therefore live here; tests/deployment.test.mjs checks them against
// config/liteforge-testnet.json and Deploy0xFiV3.s.sol.
export const NUSD = Address.fromString("0x69320a82accec1b8a5ef59fd02b217e7ea4aea19");
const WZKLTC = Address.fromString("0xe93d4373ce1eda3df6c3ab7ed3ab07a07aa5939f");
export const NBTC = Address.fromString("0xaa612e178ff9c4ea044ef507670c7502d58cba46");
export const NETH = Address.fromString("0x3f3b4f9dfe1ae3cdaa89788810557194c662a8ef");

export function eventId(txHash: Bytes, logIndex: BigInt): Bytes {
  return txHash.concatI32(logIndex.toI32());
}

export function loadProtocol(timestamp: BigInt): Protocol {
  let protocol = Protocol.load("0xfi");
  if (protocol == null) {
    protocol = new Protocol("0xfi");
    protocol.pairCount = ZERO_BI;
    protocol.swapCount = ZERO_BI;
    protocol.mintCount = ZERO_BI;
    protocol.burnCount = ZERO_BI;
    protocol.gaugeCount = ZERO_BI;
    protocol.totalVolumeNusd = ZERO_BI;
  }
  protocol.updatedAt = timestamp;
  return protocol;
}

export function loadToken(address: Address, timestamp: BigInt): Token {
  let token = Token.load(address);
  if (token != null) return token;

  token = new Token(address);
  // shortcut: tokens outside this table get a placeholder (clients read metadata over RPC);
  // add a row when 0xFi pairs a new token with fewer or more than 18 decimals.
  token.symbol = address.toHexString().slice(0, 8);
  token.name = "Unknown token";
  token.decimals = 18;
  if (address.equals(NUSD)) { token.symbol = "NUSD"; token.name = "Nothing USD"; }
  else if (address.equals(WZKLTC)) { token.symbol = "WzkLTC"; token.name = "Wrapped zkLTC"; }
  else if (address.equals(NBTC)) { token.symbol = "nBTC"; token.name = "0xFi Synthetic Bitcoin"; }
  else if (address.equals(NETH)) { token.symbol = "nETH"; token.name = "0xFi Synthetic Ether"; }
  token.createdAt = timestamp;
  token.save();
  return token;
}

export function decimalAmount(value: BigInt, decimals: i32): BigDecimal {
  return value.toBigDecimal().div(BigInt.fromI32(10).pow(decimals as u8).toBigDecimal());
}
