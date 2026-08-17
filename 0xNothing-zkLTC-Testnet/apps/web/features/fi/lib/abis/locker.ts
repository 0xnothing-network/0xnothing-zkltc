export const communityLiquidityLockerAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "activeLockedByToken", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "lockPermanent", stateMutability: "nonpayable", inputs: [{ name: "lpToken", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "id", type: "uint256" }] },
  { type: "function", name: "lockUntil", stateMutability: "nonpayable", inputs: [{ name: "lpToken", type: "address" }, { name: "amount", type: "uint256" }, { name: "unlockAt", type: "uint64" }], outputs: [{ name: "id", type: "uint256" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "lockCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "getLock", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "lpToken", type: "address" }, { name: "amount", type: "uint256" },
      { name: "lockedAt", type: "uint64" }, { name: "unlockAt", type: "uint64" }, { name: "permanent", type: "bool" }, { name: "withdrawn", type: "bool" },
    ]}],
  },
  { type: "function", name: "ownerLockIds", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256[]" }] },
  { type: "function", name: "ownerLockCount", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "event", name: "LiquidityLocked", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true }, { name: "lpToken", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "unlockAt", type: "uint64", indexed: false }, { name: "permanent", type: "bool", indexed: false }] },
  { type: "event", name: "LiquidityWithdrawn", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true }, { name: "lpToken", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
] as const;
