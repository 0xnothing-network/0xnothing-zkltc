import { afterAll, assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { Address } from "@graphprotocol/graph-ts";
import {
  handleCreationFeePaid,
  handleProtocolFeesWithdrawn,
  handleTokenCurveReopened,
  handleTokenCreated,
  handleTokenGraduated,
  handleTokenReadyForGraduation,
  handleTokenTraded,
} from "../src/mapping";
import { handleTransfer } from "../src/tokenMapping";
import {
  FACTORY,
  creationFeePaidEvent,
  feesWithdrawnEvent,
  initialMintTransferEvent,
  tokenCreatedEvent,
  tokenGraduatedEvent,
  tokenReadyEvent,
  tokenReopenedEvent,
  tokenTradedEvent,
  transferEvent,
} from "./event-builders";

const TOKEN = Address.fromString("0x0000000000000000000000000000000000000011");
const CREATOR = Address.fromString("0x0000000000000000000000000000000000000022");
const TRADER = Address.fromString("0x0000000000000000000000000000000000000033");
const ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000");

function tokenBalanceId(holder: Address): string {
  return TOKEN.concat(holder).toHexString();
}

describe("0xPump mappings", () => {
  beforeEach(() => {
    clearStore();
  });

  afterAll(() => {
    clearStore();
  });

  test("indexes a new bonding-curve market and creation fee", () => {
    handleCreationFeePaid(creationFeePaidEvent(CREATOR));
    handleTokenCreated(tokenCreatedEvent(TOKEN, CREATOR));

    assert.entityCount("CreationFeePayment", 1);
    assert.entityCount("Market", 1);
    assert.fieldEquals("Market", TOKEN.toHexString(), "status", "CURVE");
    assert.fieldEquals("Market", TOKEN.toHexString(), "factory", FACTORY.toHexString());
    assert.fieldEquals("Market", TOKEN.toHexString(), "holderCount", "0");
    assert.fieldEquals("Market", TOKEN.toHexString(), "creator", CREATOR.toHexString());
    assert.entityCount("TokenBalance", 1);
    assert.fieldEquals(
      "TokenBalance",
      tokenBalanceId(FACTORY),
      "balance",
      "1000000000000000000000000",
    );
    assert.fieldEquals("TokenBalance", tokenBalanceId(FACTORY), "isFactory", "true");
    assert.fieldEquals(
      "Market",
      TOKEN.toHexString(),
      "contentHash",
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.fieldEquals("Market", TOKEN.toHexString(), "priceNusd", "1");
    assert.fieldEquals(
      "Market",
      TOKEN.toHexString(),
      "graduationThresholdNusd",
      "100000000000000000000",
    );
    assert.fieldEquals(
      "Market",
      TOKEN.toHexString(),
      "graduationReserveThresholdNusd",
      "1000",
    );
    assert.fieldEquals("Protocol", "global", "tokenCount", "1");
    assert.fieldEquals(
      "Protocol",
      "global",
      "totalCreationFeesNusd",
      "1000000000000000000",
    );
    assert.fieldEquals(
      "Account",
      CREATOR.toHexString(),
      "feesPaidNusd",
      "1000000000000000000",
    );
  });

  test("ignores the replayed initialize mint after seeding factory inventory", () => {
    handleTokenCreated(tokenCreatedEvent(TOKEN, CREATOR));
    handleTransfer(initialMintTransferEvent(TOKEN));

    assert.fieldEquals(
      "Market",
      TOKEN.toHexString(),
      "totalSupply",
      "1000000000000000000000000",
    );
    assert.fieldEquals("Market", TOKEN.toHexString(), "holderCount", "0");
    assert.fieldEquals(
      "TokenBalance",
      tokenBalanceId(FACTORY),
      "balance",
      "1000000000000000000000000",
    );
    assert.entityCount("TokenBalance", 1);
  });

  test("tracks creator, direct transfers, curve returns, and burns", () => {
    handleTokenCreated(tokenCreatedEvent(TOKEN, CREATOR));

    handleTransfer(transferEvent(TOKEN, FACTORY, CREATOR, "100"));
    assert.fieldEquals("Market", TOKEN.toHexString(), "holderCount", "1");
    assert.fieldEquals("TokenBalance", tokenBalanceId(CREATOR), "balance", "100");
    assert.fieldEquals("TokenBalance", tokenBalanceId(CREATOR), "isCreator", "true");

    handleTransfer(transferEvent(TOKEN, CREATOR, TRADER, "40"));
    assert.fieldEquals("Market", TOKEN.toHexString(), "holderCount", "2");
    assert.fieldEquals("TokenBalance", tokenBalanceId(CREATOR), "balance", "60");
    assert.fieldEquals("TokenBalance", tokenBalanceId(TRADER), "balance", "40");

    handleTransfer(transferEvent(TOKEN, TRADER, FACTORY, "40"));
    assert.fieldEquals("Market", TOKEN.toHexString(), "holderCount", "1");
    assert.fieldEquals("TokenBalance", tokenBalanceId(TRADER), "balance", "0");

    handleTransfer(transferEvent(TOKEN, CREATOR, ZERO_ADDRESS, "60"));
    assert.fieldEquals("Market", TOKEN.toHexString(), "holderCount", "0");
    assert.fieldEquals(
      "Market",
      TOKEN.toHexString(),
      "totalSupply",
      "999999999999999999999940",
    );
    assert.fieldEquals("TokenBalance", tokenBalanceId(CREATOR), "balance", "0");
    assert.entityCount("TokenBalance", 3);
  });

  test("counts a paid reservation even when no market is created", () => {
    handleCreationFeePaid(creationFeePaidEvent(CREATOR));

    assert.entityCount("Market", 0);
    assert.entityCount("CreationFeePayment", 1);
    assert.fieldEquals(
      "Protocol",
      "global",
      "totalCreationFeesNusd",
      "1000000000000000000",
    );
  });

  test("indexes authoritative trade state and all candle periods", () => {
    handleTokenCreated(tokenCreatedEvent(TOKEN, CREATOR));
    handleTokenTraded(tokenTradedEvent(TOKEN, TRADER, true));

    assert.entityCount("Trade", 1);
    assert.entityCount("Candle", 5);
    assert.fieldEquals(
      "Candle",
      TOKEN.toHexString() + "-1-960",
      "period",
      "1",
    );
    assert.fieldEquals(
      "Candle",
      TOKEN.toHexString() + "-1-960",
      "timestamp",
      "960",
    );
    assert.fieldEquals("Candle", TOKEN.toHexString() + "-1-960", "open", "1");
    assert.fieldEquals("Candle", TOKEN.toHexString() + "-1-960", "high", "2");
    assert.fieldEquals("Candle", TOKEN.toHexString() + "-1-960", "low", "1");
    assert.fieldEquals("Candle", TOKEN.toHexString() + "-1-960", "close", "2");
    assert.fieldEquals("Market", TOKEN.toHexString(), "tradeCount", "1");
    assert.fieldEquals("Market", TOKEN.toHexString(), "volumeNusd", "100");
    assert.fieldEquals("Market", TOKEN.toHexString(), "priceNusd", "2");
    assert.fieldEquals("Market", TOKEN.toHexString(), "progressBps", "5000");
    assert.fieldEquals("Account", TRADER.toHexString(), "buyCount", "1");
    assert.fieldEquals("Protocol", "global", "totalTradeFeesNusd", "1");
  });

  test("moves a market through ready and graduated states", () => {
    handleTokenCreated(tokenCreatedEvent(TOKEN, CREATOR));
    handleTokenReadyForGraduation(tokenReadyEvent(TOKEN));

    assert.entityCount("GraduationReadiness", 1);
    assert.fieldEquals("Market", TOKEN.toHexString(), "status", "READY");
    assert.fieldEquals("Protocol", "global", "readyTokenCount", "1");

    handleTokenGraduated(tokenGraduatedEvent(TOKEN));

    assert.entityCount("Graduation", 1);
    assert.fieldEquals("Market", TOKEN.toHexString(), "status", "GRADUATED");
    assert.fieldEquals("Market", TOKEN.toHexString(), "totalSupply", "500");
    assert.fieldEquals("Market", TOKEN.toHexString(), "circulatingSupply", "500");
    assert.fieldEquals("Protocol", "global", "activeTokenCount", "0");
    assert.fieldEquals("Protocol", "global", "readyTokenCount", "0");
    assert.fieldEquals("Protocol", "global", "graduatedTokenCount", "1");
  });

  test("reopens a ready curve after a holder sells", () => {
    handleTokenCreated(tokenCreatedEvent(TOKEN, CREATOR));
    handleTokenReadyForGraduation(tokenReadyEvent(TOKEN));
    handleTokenCurveReopened(tokenReopenedEvent(TOKEN));

    assert.entityCount("CurveReopening", 1);
    assert.fieldEquals("Market", TOKEN.toHexString(), "status", "CURVE");
    assert.fieldEquals("Market", TOKEN.toHexString(), "reserveNusd", "900");
    assert.fieldEquals("Market", TOKEN.toHexString(), "reserveToken", "600");
    assert.fieldEquals("Market", TOKEN.toHexString(), "progressBps", "9000");
    assert.fieldEquals("Protocol", "global", "readyTokenCount", "0");
  });

  test("tracks protocol fee withdrawals", () => {
    handleProtocolFeesWithdrawn(feesWithdrawnEvent(CREATOR));

    assert.entityCount("FeeWithdrawal", 1);
    assert.fieldEquals("Protocol", "global", "totalFeesWithdrawnNusd", "42");
  });
});
