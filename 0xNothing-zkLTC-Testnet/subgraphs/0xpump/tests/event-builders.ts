import { newMockEvent } from "matchstick-as";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  CreationFeePaid,
  ProtocolFeesWithdrawn,
  TokenCurveReopened,
  TokenCreated,
  TokenGraduated,
  TokenReadyForGraduation,
  TokenTraded,
} from "../generated/ZeroXPump/ZeroXPump";
import { Transfer } from "../generated/templates/PumpToken/PumpToken";

export const FACTORY = Address.fromString(
  "0x00000000000000000000000000000000000000f0",
);
const ZERO_ADDRESS = Address.fromString(
  "0x0000000000000000000000000000000000000000",
);
const CREATION_TX = Bytes.fromHexString(
  "0xc100000000000000000000000000000000000000000000000000000000000001",
);
const INITIAL_SUPPLY = "1000000000000000000000000";

function uint(value: string): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(BigInt.fromString(value));
}

function stamp(event: ethereum.Event, logIndex: i32): void {
  event.logIndex = BigInt.fromI32(logIndex);
  event.block.number = BigInt.fromI32(100 + logIndex);
  event.block.timestamp = BigInt.fromI32(1_000 + logIndex);
}

export function tokenCreatedEvent(token: Address, creator: Address): TokenCreated {
  const event = changetype<TokenCreated>(newMockEvent());
  stamp(event, 1);
  event.address = FACTORY;
  event.transaction.hash = CREATION_TX;
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  event.parameters.push(
    new ethereum.EventParam("creator", ethereum.Value.fromAddress(creator)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "contentHash",
      ethereum.Value.fromFixedBytes(
        Bytes.fromHexString(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ),
    ),
  );
  event.parameters.push(new ethereum.EventParam("name", ethereum.Value.fromString("Test Token")));
  event.parameters.push(new ethereum.EventParam("symbol", ethereum.Value.fromString("TEST")));
  event.parameters.push(
    new ethereum.EventParam("metadataURI", ethereum.Value.fromString("ipfs://metadata")),
  );
  event.parameters.push(
    new ethereum.EventParam("imageURI", ethereum.Value.fromString("ipfs://image")),
  );
  event.parameters.push(
    new ethereum.EventParam("totalSupply", uint(INITIAL_SUPPLY)),
  );
  event.parameters.push(
    new ethereum.EventParam("curveTokenSupply", uint(INITIAL_SUPPLY)),
  );
  event.parameters.push(
    new ethereum.EventParam("virtualNusdReserve", uint("1000000000000000000")),
  );
  event.parameters.push(
    new ethereum.EventParam("virtualTokenReserve", uint("1000000000000000000")),
  );
  event.parameters.push(
    new ethereum.EventParam("graduationThresholdNusd", uint("100000000000000000000")),
  );
  event.parameters.push(
    new ethereum.EventParam("graduationReserveThresholdNusd", uint("1000")),
  );
  event.parameters.push(
    new ethereum.EventParam("creationFeeNusd", uint("1000000000000000000")),
  );
  return event;
}

export function transferEvent(
  token: Address,
  from: Address,
  to: Address,
  value: string,
): Transfer {
  const event = changetype<Transfer>(newMockEvent());
  stamp(event, 6);
  event.address = token;
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(new ethereum.EventParam("from", ethereum.Value.fromAddress(from)));
  event.parameters.push(new ethereum.EventParam("to", ethereum.Value.fromAddress(to)));
  event.parameters.push(new ethereum.EventParam("value", uint(value)));
  return event;
}

export function initialMintTransferEvent(token: Address): Transfer {
  const event = transferEvent(token, ZERO_ADDRESS, FACTORY, INITIAL_SUPPLY);
  event.block.number = BigInt.fromI32(101);
  event.block.timestamp = BigInt.fromI32(1_001);
  event.transaction.hash = CREATION_TX;
  return event;
}

export function creationFeePaidEvent(owner: Address): CreationFeePaid {
  const event = changetype<CreationFeePaid>(newMockEvent());
  stamp(event, 0);
  const contentHash = Bytes.fromHexString(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("owner", ethereum.Value.fromAddress(owner)),
  );
  event.parameters.push(
    new ethereum.EventParam(
      "contentHash",
      ethereum.Value.fromFixedBytes(contentHash),
    ),
  );
  event.parameters.push(
    new ethereum.EventParam("creationFeeNusd", uint("1000000000000000000")),
  );
  return event;
}

export function tokenTradedEvent(
  token: Address,
  trader: Address,
  isBuy: boolean,
): TokenTraded {
  const event = changetype<TokenTraded>(newMockEvent());
  stamp(event, 2);
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  event.parameters.push(
    new ethereum.EventParam("trader", ethereum.Value.fromAddress(trader)),
  );
  event.parameters.push(new ethereum.EventParam("isBuy", ethereum.Value.fromBoolean(isBuy)));
  event.parameters.push(new ethereum.EventParam("tokenAmount", uint("50000000000000000000")));
  event.parameters.push(new ethereum.EventParam("curveNusdAmount", uint("100")));
  event.parameters.push(new ethereum.EventParam("userNusdAmount", uint(isBuy ? "101" : "99")));
  event.parameters.push(new ethereum.EventParam("feeNusd", uint("1")));
  event.parameters.push(new ethereum.EventParam("realNusdReserveAfter", uint("100")));
  event.parameters.push(new ethereum.EventParam("tokenReserveAfter", uint("900")));
  event.parameters.push(new ethereum.EventParam("virtualNusdReserveAfter", uint("1100")));
  event.parameters.push(new ethereum.EventParam("virtualTokenReserveAfter", uint("1900")));
  event.parameters.push(new ethereum.EventParam("circulatingSupplyAfter", uint("100")));
  event.parameters.push(
    new ethereum.EventParam("spotPriceNusdWad", uint("2000000000000000000")),
  );
  event.parameters.push(new ethereum.EventParam("curveProgressBps", uint("5000")));
  return event;
}

export function tokenReadyEvent(token: Address): TokenReadyForGraduation {
  const event = changetype<TokenReadyForGraduation>(newMockEvent());
  stamp(event, 3);
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  event.parameters.push(new ethereum.EventParam("realNusdReserve", uint("1000")));
  event.parameters.push(new ethereum.EventParam("tokenReserve", uint("500")));
  event.parameters.push(new ethereum.EventParam("thresholdNusd", uint("1000")));
  return event;
}

export function tokenReopenedEvent(token: Address): TokenCurveReopened {
  const event = changetype<TokenCurveReopened>(newMockEvent());
  stamp(event, 4);
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  event.parameters.push(new ethereum.EventParam("realNusdReserve", uint("900")));
  event.parameters.push(new ethereum.EventParam("tokenReserve", uint("600")));
  return event;
}

export function tokenGraduatedEvent(token: Address): TokenGraduated {
  const event = changetype<TokenGraduated>(newMockEvent());
  stamp(event, 4);
  const dex = Address.fromString("0x00000000000000000000000000000000000000d1");
  const pool = Address.fromString("0x00000000000000000000000000000000000000d2");
  const locker = Address.fromString("0x00000000000000000000000000000000000000d3");
  const pairId = Bytes.fromHexString(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  );
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(token)));
  event.parameters.push(new ethereum.EventParam("dex", ethereum.Value.fromAddress(dex)));
  event.parameters.push(new ethereum.EventParam("pairId", ethereum.Value.fromFixedBytes(pairId)));
  event.parameters.push(new ethereum.EventParam("pool", ethereum.Value.fromAddress(pool)));
  event.parameters.push(new ethereum.EventParam("nusdLiquidity", uint("1000")));
  event.parameters.push(new ethereum.EventParam("tokenLiquidity", uint("500")));
  event.parameters.push(new ethereum.EventParam("lpAmount", uint("250")));
  event.parameters.push(
    new ethereum.EventParam("lpRecipient", ethereum.Value.fromAddress(locker)),
  );
  return event;
}

export function feesWithdrawnEvent(recipient: Address): ProtocolFeesWithdrawn {
  const event = changetype<ProtocolFeesWithdrawn>(newMockEvent());
  stamp(event, 5);
  event.parameters = new Array<ethereum.EventParam>();
  event.parameters.push(
    new ethereum.EventParam("recipient", ethereum.Value.fromAddress(recipient)),
  );
  event.parameters.push(new ethereum.EventParam("amountNusd", uint("42")));
  return event;
}
