export const dexFactoryAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "getPair", stateMutability: "view",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    outputs: [{ name: "pair", type: "address" }],
  },
  { type: "function", name: "allPairsLength", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allPairs", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "isPair", stateMutability: "view", inputs: [{ name: "candidate", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "router", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "swapsPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function", name: "createPair", stateMutability: "nonpayable",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    outputs: [{ name: "pair", type: "address" }],
  },
] as const;

export const dexPoolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "getReserves", stateMutability: "view", inputs: [],
    outputs: [{ name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" }],
  },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const addLiquidityComponents = [
  { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" },
  { name: "amountADesired", type: "uint256" }, { name: "amountBDesired", type: "uint256" },
  { name: "amountAMin", type: "uint256" }, { name: "amountBMin", type: "uint256" },
  { name: "minimumLiquidity", type: "uint256" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
] as const;

const addLiquidityNativeComponents = [
  { name: "token", type: "address" }, { name: "amountTokenDesired", type: "uint256" },
  { name: "amountTokenMin", type: "uint256" }, { name: "amountNativeMin", type: "uint256" },
  { name: "minimumLiquidity", type: "uint256" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
] as const;

const removeLiquidityComponents = [
  { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "liquidity", type: "uint256" },
  { name: "amountAMin", type: "uint256" }, { name: "amountBMin", type: "uint256" },
  { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
] as const;

const removeLiquidityNativeComponents = [
  { name: "token", type: "address" }, { name: "liquidity", type: "uint256" },
  { name: "amountTokenMin", type: "uint256" }, { name: "amountNativeMin", type: "uint256" },
  { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
] as const;

export const dexRouterAbi = [
  { type: "function", name: "LP_FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "PROTOCOL_FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "ROUTE_SURCHARGE_BPS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "accruedRouterFees", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "withdrawRouterFees", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  {
    type: "function", name: "getAmountsOut", stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function", name: "getReserves", stateMutability: "view",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    outputs: [{ name: "reserveA", type: "uint256" }, { name: "reserveB", type: "uint256" }],
  },
  {
    type: "function", name: "swapExactTokensForTokens", stateMutability: "nonpayable",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function", name: "swapExactNativeForTokens", stateMutability: "payable",
    inputs: [{ name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function", name: "swapExactTokensForNative", stateMutability: "nonpayable",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  { type: "function", name: "addLiquidity", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: addLiquidityComponents }], outputs: [{ name: "amountA", type: "uint256" }, { name: "amountB", type: "uint256" }, { name: "liquidity", type: "uint256" }] },
  { type: "function", name: "addLiquidityNative", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: addLiquidityNativeComponents }], outputs: [{ name: "amountToken", type: "uint256" }, { name: "amountNative", type: "uint256" }, { name: "liquidity", type: "uint256" }] },
  { type: "function", name: "removeLiquidity", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: removeLiquidityComponents }], outputs: [{ name: "amountA", type: "uint256" }, { name: "amountB", type: "uint256" }] },
  { type: "function", name: "removeLiquidityNative", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: removeLiquidityNativeComponents }], outputs: [{ name: "amountToken", type: "uint256" }, { name: "amountNative", type: "uint256" }] },
] as const;
