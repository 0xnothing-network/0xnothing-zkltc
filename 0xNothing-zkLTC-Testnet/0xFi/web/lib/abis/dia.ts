export const diaAggregatorAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [{ name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" }],
  },
] as const;

export const diaOracleAdapterAbi = [
  { type: "function", name: "isFresh", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function", name: "readPriceWad", stateMutability: "view", inputs: [],
    outputs: [{ name: "priceWad", type: "uint256" }, { name: "updatedAt", type: "uint256" }, { name: "roundId", type: "uint80" }],
  },
] as const;

export const wzkLtcAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

