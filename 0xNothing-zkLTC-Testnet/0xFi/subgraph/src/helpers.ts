import { Address, BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { ERC20 } from "../generated/ZeroXFiFactory/ERC20";
import { Protocol, Token } from "../generated/schema";

export const ZERO_BI = BigInt.zero();
export const ZERO_BD = BigDecimal.fromString("0");
export const ONE_BI = BigInt.fromI32(1);

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
  const contract = ERC20.bind(address);
  const symbol = contract.try_symbol();
  const name = contract.try_name();
  const decimals = contract.try_decimals();
  token.symbol = symbol.reverted ? address.toHexString().slice(0, 8) : symbol.value;
  token.name = name.reverted ? "Unknown token" : name.value;
  token.decimals = decimals.reverted ? 18 : decimals.value;
  token.createdAt = timestamp;
  token.save();
  return token;
}

export function decimalAmount(value: BigInt, decimals: i32): BigDecimal {
  return value.toBigDecimal().div(BigInt.fromI32(10).pow(decimals as u8).toBigDecimal());
}
