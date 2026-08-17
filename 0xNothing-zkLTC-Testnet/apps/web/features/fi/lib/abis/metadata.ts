export const tokenMetadataRegistryAbi = [
  { type: "function", name: "registerImage", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "imageURI_", type: "string" }], outputs: [{ name: "registrationId", type: "uint256" }] },
  { type: "function", name: "imageURI", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "", type: "string" }] },
  {
    type: "function", name: "imageRecord", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: [
      { name: "imageURI", type: "string" }, { name: "registrant", type: "address" }, { name: "registeredAt", type: "uint64" },
    ]}],
  },
  { type: "function", name: "isProtectedToken", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "registrationCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "registeredToken", stateMutability: "view", inputs: [{ name: "registrationId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "protectedTokenCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "protectedToken", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "event", name: "TokenImageRegistered", inputs: [{ name: "token", type: "address", indexed: true }, { name: "registrant", type: "address", indexed: true }, { name: "registrationId", type: "uint256", indexed: true }, { name: "imageURI", type: "string", indexed: false }] },
] as const;
