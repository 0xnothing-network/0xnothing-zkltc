// Minimal ABI for the 0xMarketplace contract. Only the functions the
// frontend calls are included.

export const MarketplaceAbi = [
  {
    type: "function",
    name: "buy",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "cancelListing",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "list",
    inputs: [
      { name: "collection", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "price", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getActiveListings",
    inputs: [
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getListingByToken",
    inputs: [
      { name: "collection", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [
      { name: "", type: "uint256" },
      {
        name: "",
        type: "tuple",
        components: [
          { name: "collection", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "seller", type: "address" },
          { name: "active", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "listings",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "collection", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "price", type: "uint256" },
      { name: "seller", type: "address" },
      { name: "active", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "paused",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Listed",
    inputs: [
      { indexed: true, name: "listingId", type: "uint256" },
      { indexed: true, name: "collection", type: "address" },
      { indexed: false, name: "tokenId", type: "uint256" },
      { indexed: false, name: "seller", type: "address" },
      { indexed: false, name: "price", type: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Bought",
    inputs: [
      { indexed: true, name: "listingId", type: "uint256" },
      { indexed: false, name: "buyer", type: "address" },
      { indexed: false, name: "price", type: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ListingCancelled",
    inputs: [{ indexed: true, name: "listingId", type: "uint256" }],
    anonymous: false,
  },
] as const;

export interface RawListing {
  listingId: bigint;
  collection: `0x${string}`;
  tokenId: bigint;
  price: bigint;
  seller: `0x${string}`;
  active: boolean;
}

export function marketplaceNftKey(
  collection: string,
  tokenId: string | bigint,
): string {
  return `${collection.toLowerCase()}:${tokenId.toString()}`;
}
