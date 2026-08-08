export const synthVaultAbi = [
  { type: "function", name: "safetyReserve", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "activated", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "depositCollateral", stateMutability: "nonpayable", inputs: [{ name: "amountNusd", type: "uint256" }, { name: "onBehalfOf", type: "address" }], outputs: [] },
  { type: "function", name: "depositAndMint", stateMutability: "nonpayable", inputs: [{ name: "collateralAmountNusd", type: "uint256" }, { name: "syntheticAmount", type: "uint256" }, { name: "maximumFeeNusd", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "amountSynthetic", type: "uint256" }, { name: "maximumFeeNusd", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "repay", stateMutability: "nonpayable", inputs: [{ name: "maximumAmountSynthetic", type: "uint256" }, { name: "onBehalfOf", type: "address" }], outputs: [{ name: "amountRepaidSynthetic", type: "uint256" }] },
  { type: "function", name: "repayAndWithdraw", stateMutability: "nonpayable", inputs: [{ name: "maximumRepaySynthetic", type: "uint256" }, { name: "collateralAmountNusd", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [{ name: "amountRepaidSynthetic", type: "uint256" }] },
  { type: "function", name: "withdrawCollateral", stateMutability: "nonpayable", inputs: [{ name: "amountNusd", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  {
    type: "function", name: "position", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "userCollateralNusd", type: "uint256" },
      { name: "reserveCollateralNusd", type: "uint256" },
      { name: "debtSynthetic", type: "uint256" },
      { name: "accountHealthFactorWad", type: "uint256" },
      { name: "maxWithdrawableNusd", type: "uint256" },
    ],
  },
  { type: "function", name: "maxMintableSynthetic", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "amountSynthetic", type: "uint256" }] },
  { type: "function", name: "maxUserCollateralWithdrawable", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "amountNusd", type: "uint256" }] },
  { type: "function", name: "debtCeilingSynthetic", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalDebtSynthetic", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalBadDebtSynthetic", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalUserCollateralNusd", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalReserveCollateralNusd", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "mintPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "withdrawPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function", name: "quoteDepositAndMint", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }, { name: "userCollateralAmountNusd", type: "uint256" }],
    outputs: [
      { name: "syntheticAmount", type: "uint256" },
      { name: "reserveRequiredNusd", type: "uint256" },
      { name: "oneToOneAvailable", type: "bool" },
    ],
  },
  { type: "function", name: "quoteMintForCollateral", stateMutability: "view", inputs: [{ name: "collateralAmountNusd", type: "uint256" }], outputs: [{ name: "amountSynthetic", type: "uint256" }] },
  { type: "function", name: "quoteMintFee", stateMutability: "view", inputs: [{ name: "amountSynthetic", type: "uint256" }], outputs: [{ name: "feeNusd", type: "uint256" }] },
  { type: "function", name: "quoteCollateralForMint", stateMutability: "view", inputs: [{ name: "amountSynthetic", type: "uint256" }], outputs: [{ name: "collateralAmountNusd", type: "uint256" }] },
  { type: "function", name: "releaseExcessReserveCollateral", stateMutability: "nonpayable", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "releasedNusd", type: "uint256" }] },
] as const;

export const synthSafetyReserveAbi = [
  { type: "function", name: "totalReserveNusd", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "freeReserveNusd", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalAllocatedNusd", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "ENTRY_TVL_NUSD", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "EXIT_TVL_NUSD", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "ACTIVATION_DELAY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "sponsorshipActive", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "eligibleSince", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allocationsPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
] as const;

export const legacySynthVaultAbi = [
  {
    type: "function", name: "positions", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "collateralNusd", type: "uint256" },
      { name: "debtSynthetic", type: "uint256" },
    ],
  },
  { type: "function", name: "mintPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "withdrawPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "withdrawCollateral", stateMutability: "nonpayable", inputs: [{ name: "amountNusd", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
] as const;
