# 0xPixel integration guide

0xPixel is a fully on-chain pixel-art NFT collection on LitVM LiteForge testnet
(chain id `4441`, gas token zkLTC). This guide covers three things an integrator
can build on:

1. **Minting** artwork into the 0xPixel V2 collection. Minting is free
   (`value: 0`) and every artwork must be original within the collection.
2. **Reading** tokens: on-chain SVG metadata, raw pixel data, owners and
   royalties.
3. **Trading** on the NUSD NFT marketplace (`NusdNftMarketplaceV2`): listings,
   purchases and escrowed offers, all settled in NUSD (18 decimals).

You only need the contracts over JSON-RPC and the public Goldsky subgraph. The
0xNothing web app's own HTTP routes and WebSocket plumbing are internal and are
not a public API.

All examples use [viem](https://viem.sh) with TypeScript and `bigint` amounts.
Paths are relative to the `0xNothing-zkLTC-Testnet/` folder.

## Contents

- [Network](#network)
- [Contracts and addresses](#contracts-and-addresses)
- [Shared setup](#shared-setup)
- [Flow 1: mint an artwork](#flow-1-mint-an-artwork)
- [Flow 2: read tokens and metadata](#flow-2-read-tokens-and-metadata)
- [Marketplace model](#marketplace-model)
- [Flow 3: list an NFT or change its price](#flow-3-list-an-nft-or-change-its-price)
- [Flow 4: buy a listing](#flow-4-buy-a-listing)
- [Flow 5: make an offer](#flow-5-make-an-offer)
- [Flow 6: accept an offer](#flow-6-accept-an-offer)
- [Flow 7: cancel, expire and withdraw](#flow-7-cancel-expire-and-withdraw)
- [Reading data: RPC or subgraph](#reading-data-rpc-or-subgraph)
- [Error reference](#error-reference)
- [Safety checklist](#safety-checklist)

## Network

| Item | Value | Source |
|---|---|---|
| Chain id | `4441` | `contracts/deployments/v3-core.json:3` |
| Native currency | zkLTC, 18 decimals (gas only) | |
| RPC (HTTP) | `https://rpc.testnet.liteforge.zeeve.net` | `apps/web/lib/publicConfig.ts:6` |
| RPC (WebSocket) | `wss://rpc.testnet.liteforge.zeeve.net/ws` | `apps/web/lib/publicConfig.ts:8` |
| Explorer | `https://explorer.testnet.liteforge.zeeve.net` | `apps/web/lib/publicConfig.ts:9` |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` | `apps/web/lib/publicConfig.ts:10` |

## Contracts and addresses

Load addresses from the deployment manifests at build or start-up time. Do not
copy them into your code by hand: a redeploy changes the manifest, and a
hard-coded address then points at a retired contract. The values below are
current as of tokenomics v3 (live since 2026-10-15) and show what the manifests
contain.

| Contract | Address | Manifest key |
|---|---|---|
| 0xPixel V2 (new mints) | `0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB` | `pixelV2` in `contracts/deployments/v3-core.json:13`; `PIXEL_NFT_ADDRESS` in `apps/web/lib/publicConfig.ts:14` |
| 0xPixel Classic (V1, legacy) | `0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988` | `pixelV1` in `contracts/deployments/v3-core.json:12`; `PIXEL_CLASSIC_ADDRESS` in `apps/web/lib/publicConfig.ts:12` |
| NUSD NFT marketplace (`NusdNftMarketplaceV2`) | `0xd219EfFe076B68934e212313C8d468b994d6e52E` | `nusdMarketplace` in `contracts/deployments/v3-core.json:10`; `address` in `apps/web/lib/nusdMarketplace.generated.json:3` |
| NUSD (settlement token, 18 decimals) | `0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19` | `nusd` in `contracts/deployments/v3-core.json:9`; `nusd` in `apps/web/lib/nusdMarketplace.generated.json:4` |

Other values you need:

| Item | Value | Source |
|---|---|---|
| V2 deployment block | `56305414` | `PIXEL_START_BLOCK`, `apps/web/lib/publicConfig.ts:15` |
| Classic deployment block | `24867130` | `PIXEL_CLASSIC_START_BLOCK`, `apps/web/lib/publicConfig.ts:17` |
| Marketplace deployment block | `61141428` | `deploymentBlock`, `apps/web/lib/nusdMarketplace.generated.json:13` |
| Marketplace `IMPLEMENTATION_ID` | `0xcacabae418335c9bc3d401a0085ac7f27c4ec267a89868777e5712e9d9653739` (`keccak256("0xpixel.nusd.marketplace.v2")`) | `apps/web/lib/nusdMarketplace.generated.json:12`; `contracts/src/0xpixel/NusdNftMarketplaceV2.sol:57` |
| Collections allowed on the market | Classic and V2 | `collections`, `apps/web/lib/nusdMarketplace.generated.json:8-11` |
| Market subgraph (Goldsky, public) | `https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/pixel-nusd-market/1.1.0/gn` | `nusdMarketGoldskyEndpoint`, `apps/web/features/fi/config/testnet.generated.json:42` |

The manifests can still be wrong about a live contract, so check on-chain before
you sign: `nusd()` must equal the NUSD address, `IMPLEMENTATION_ID()` must equal
the marker above, and `collectionAllowed(collection)` must be `true` for the
collection you trade.

Retired contracts. Do not send transactions to them:

- The legacy zkLTC-priced market `0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4`
  is paused (`deployments/liteforge-testnet/legacy-marketplace-pause.json:3,8`).
- The first NUSD market `0x188eACB8e05691aD5Ca6b31703DA97B13b2cf377`
  (`deployments/liteforge-testnet/nusd-marketplace.json:3`) is retired.
- The Classic collection is still readable and tradable, but new art should be
  minted to V2 only. The web app no longer mints to Classic.

## Shared setup

```ts
// liteforge.ts
import {
  createPublicClient, createWalletClient, custom, defineChain, http, fallback,
  getAddress, type Address,
} from "viem";
import v3Core from "../contracts/deployments/v3-core.json";
import market from "../apps/web/lib/nusdMarketplace.generated.json";
import fiTestnet from "../apps/web/features/fi/config/testnet.generated.json";

export const liteforge = defineChain({
  id: 4441,
  name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.liteforge.zeeve.net"],
      webSocket: ["wss://rpc.testnet.liteforge.zeeve.net/ws"],
    },
  },
  blockExplorers: { default: { name: "LiteForge Explorer", url: "https://explorer.testnet.liteforge.zeeve.net" } },
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } },
});

// Addresses come from the manifests, never from literals.
if (v3Core.chainId !== 4441 || market.chainId !== 4441) throw new Error("Manifest is not for LiteForge");
export const PIXEL_V2: Address = getAddress(v3Core.pixelV2);
export const PIXEL_CLASSIC: Address = getAddress(v3Core.pixelV1);
export const MARKET: Address = getAddress(v3Core.nusdMarketplace);
export const NUSD: Address = getAddress(v3Core.nusd);
export const MARKET_IMPLEMENTATION_ID = market.implementation as `0x${string}`;
export const SUBGRAPH_URL: string = fiTestnet.nusdMarketGoldskyEndpoint;
if (getAddress(market.address) !== MARKET || getAddress(market.nusd) !== NUSD)
  throw new Error("Manifests disagree; refresh both before trading");

export const publicClient = createPublicClient({
  chain: liteforge,
  transport: fallback([
    http("https://rpc.testnet.liteforge.zeeve.net"),
  ]),
});

export const wallet = createWalletClient({ chain: liteforge, transport: custom(window.ethereum!) });

/** Returns the connected account after making sure the wallet is on chain 4441. */
export async function connectedAccount(): Promise<Address> {
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("No wallet account");
  if ((await wallet.getChainId()) !== liteforge.id) {
    await wallet.switchChain({ id: liteforge.id }); // the wallet may ask to add the chain first
    if ((await wallet.getChainId()) !== liteforge.id) throw new Error("Switch the wallet to LiteForge (4441)");
  }
  return account;
}
```

A shared write helper. Every write in this guide goes through it: simulate with
the exact account (and no `value`, so the call sends 0 zkLTC), send the
simulated request, wait for the receipt and require `status === "success"`.

```ts
// send.ts
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName } from "viem";
import { publicClient, wallet, liteforge } from "./liteforge";

export async function send<
  const abi extends Abi,
  fn extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(p: {
  account: Address;
  address: Address;
  abi: abi;
  functionName: fn;
  args: ContractFunctionArgs<abi, "nonpayable" | "payable", fn>;
  gas?: bigint;
}) {
  if ((await wallet.getChainId()) !== liteforge.id) throw new Error("Wrong chain");
  // Every function used here is nonpayable: no `value` field, so the call carries 0 zkLTC.
  const { request } = await publicClient.simulateContract(p as never);
  const hash = await wallet.writeContract({ ...(request as object), gas: p.gas } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}
```

No 0xPixel or marketplace function is payable, so every call sends 0 zkLTC.
Leave `value` out: viem's types reject a `value` field on a nonpayable function
(`value?: undefined`), and an omitted value is 0. zkLTC only pays gas.

## Flow 1: mint an artwork

**Purpose.** Create a new token in 0xPixel V2 from a square grid of colours.

**Contract.** `ZeroXPixelV2` at `pixelV2`
(`contracts/src/0xpixel/ZeroXPixelV2.sol`).

```solidity
function mintPacked(string artName, string description, uint256 grid, bytes pixels) returns (uint256 id) // :65
function checkOriginalPacked(bytes pixels, uint256 grid) view returns (bool)                         // :112-115
function getCreatorPacked(bytes pixels, uint256 grid) view returns (address)                          // :117-120
event Minted(address indexed creator, uint256 indexed tokenId, string name)                           // :53
event ArtworkRegistered(bytes32 indexed artworkHash, uint256 indexed tokenId, uint256 gridSize)       // :54
```

**Preconditions.**

- Wallet on chain 4441 with a little zkLTC for gas. The mint itself is free:
  `mintPacked` is nonpayable, so send no value. No ERC-20 or NFT approval is
  needed.
- `artName`: 1 to 64 bytes of valid UTF-8. `description`: 0 to 1,024 bytes of
  valid UTF-8 (`ZeroXPixelV2.sol:16-17,68-71`).
- `grid` is one of 8, 16, 32, 64, 128 or 256 (`:187`).
- `pixels` is the canonical encoding below and the artwork is not minted yet.
- The token is minted with `_safeMint` (`:89`). A smart-contract minter must
  implement `onERC721Received`.

### Pixel encoding

`pixels` is raw binary: 6 bytes per horizontal run of one colour,
`[x, y, countMinusOne, r, g, b]` (`ZeroXPixelV2.sol:12`, decoded at `:201-207`).
The run covers `countMinusOne + 1` cells (1 to 256). Cells not covered by any
run are transparent.

The contract accepts exactly one encoding per image (`_validatePixels`,
`:186-218`):

- `pixels.length` is greater than 0, at most 24,576 (4,096 runs) and a multiple
  of 6. Otherwise `InvalidPixels()`. A fully transparent canvas cannot be
  minted.
- `x < grid`, `y < grid` and `x + width <= grid`. Otherwise `PixelOutOfBounds()`.
- Runs are row-major: sorted by `y` ascending, and within a row by `x`, with no
  overlap.
- Two runs that touch in the same row must have different colours. Equal
  neighbours must be merged into one run. Otherwise `NonCanonicalPixels()`.

The 4,096-run cap means very detailed 256 x 256 images (for example a
checkerboard) cannot be minted. Count runs before you ask for a signature.

### Originality

The artwork hash is `keccak256(abi.encodePacked(uint16(grid), pixels))`
(`:182-184`), stored in `artworkRegistry(bytes32) -> tokenId` (`:49`).
`checkOriginalPacked` returns `true` if the art is free and `false` if it is
already minted. It **reverts** with the encoding errors above if `pixels` is not
canonical, so treat a revert as "fix the encoding", not "taken". Originality is
per collection. Classic has its own registry and a different hash.

### Steps

1. Encode the grid canonically (the packer below matches the web's
   `pixelDataToPackedBytes` in `apps/web/lib/pixelPacking.ts:2-25`).
2. Check name and description byte lengths with `TextEncoder`.
3. Call `checkOriginalPacked(pixels, grid)`. Stop on `false`.
4. Simulate `mintPacked` with the account and no `value` (0 zkLTC).
5. Estimate gas and add headroom. Large 256 grids are gas-heavy because the
   pixel bytes are deployed as one or two data contracts (`PixelData.sol:16-24`).
   The web uses `estimate + estimate / 5 + 100_000` and refuses if that is above
   90% of the block gas limit (`apps/web/features/pixel/components/MintPanel.tsx:262-277`).
6. Send, wait for the receipt, require success, and read the token id from the
   `Minted` event. Token ids are sequential from 1 (`:76`).

### Code

```ts
import { parseAbi, parseEventLogs, type Hex } from "viem";
import { publicClient, wallet, connectedAccount, PIXEL_V2 } from "./liteforge";

export const pixelV2Abi = parseAbi([
  "function mintPacked(string artName, string description, uint256 grid, bytes pixels) returns (uint256)",
  "function checkOriginalPacked(bytes pixels, uint256 grid) view returns (bool)",
  "function getCreatorPacked(bytes pixels, uint256 grid) view returns (address)",
  "event Minted(address indexed creator, uint256 indexed tokenId, string name)",
  "event ArtworkRegistered(bytes32 indexed artworkHash, uint256 indexed tokenId, uint256 gridSize)",
  "error InvalidName()", "error InvalidDescription()", "error InvalidUTF8()", "error InvalidGrid()",
  "error InvalidPixels()", "error PixelOutOfBounds()", "error NonCanonicalPixels()",
  "error ArtworkAlreadyExists()", "error ReentrantCall()",
]);

const GRIDS = [8, 16, 32, 64, 128, 256];
const MAX_RUNS = 4096;

/** rows[y][x] is "#rrggbb" or null (transparent). Returns the canonical encoding. */
export function packPixels(rows: (string | null)[][], grid: number): Hex {
  if (!GRIDS.includes(grid) || rows.length !== grid) throw new Error("Unsupported grid");
  const out: number[] = [];
  for (let y = 0; y < grid; y++) {
    if (rows[y].length !== grid) throw new Error(`Row ${y} has the wrong width`);
    for (let x = 0; x < grid; ) {
      const c = rows[y][x]?.toLowerCase();
      if (!c) { x++; continue; }
      if (!/^#[0-9a-f]{6}$/.test(c)) throw new Error(`Bad colour at ${x},${y}`);
      let w = 1;
      while (x + w < grid && rows[y][x + w]?.toLowerCase() === c) w++; // merge equal neighbours
      const rgb = parseInt(c.slice(1), 16);
      out.push(x, y, w - 1, rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff);
      x += w;
    }
  }
  if (out.length === 0) throw new Error("Paint at least one pixel");
  if (out.length / 6 > MAX_RUNS) throw new Error(`Artwork has ${out.length / 6} runs; the limit is ${MAX_RUNS}`);
  return `0x${out.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function mintArtwork(name: string, description: string, rows: (string | null)[][], grid: number) {
  const account = await connectedAccount(); // chain 4441 checked here

  const artName = name.trim();
  const nameBytes = new TextEncoder().encode(artName).length;
  const descBytes = new TextEncoder().encode(description).length;
  if (nameBytes < 1 || nameBytes > 64) throw new Error("Name must be 1-64 bytes");
  if (descBytes > 1024) throw new Error("Description must be at most 1,024 bytes");

  const pixels = packPixels(rows, grid);
  const gridArg = BigInt(grid);

  // Fresh originality read. A revert here means the encoding is wrong.
  const original = await publicClient.readContract({
    address: PIXEL_V2, abi: pixelV2Abi, functionName: "checkOriginalPacked", args: [pixels, gridArg],
  });
  if (!original) throw new Error("This exact artwork is already minted");

  // Simulate with the exact account. mintPacked is nonpayable, so there is no `value`
  // field (viem rejects one) and the call sends 0 zkLTC. Catches a race (ArtworkAlreadyExists).
  const { request } = await publicClient.simulateContract({
    account, address: PIXEL_V2, abi: pixelV2Abi, functionName: "mintPacked",
    args: [artName, description, gridArg, pixels],
  });

  const est = await publicClient.estimateContractGas({
    account, address: PIXEL_V2, abi: pixelV2Abi, functionName: "mintPacked",
    args: [artName, description, gridArg, pixels],
  });
  const gas = est + est / 5n + 100_000n;
  const block = await publicClient.getBlock({ blockTag: "latest" });
  if (gas * 10n > block.gasLimit * 9n) throw new Error("Artwork is too large for one block; simplify it");

  const hash = await wallet.writeContract({ ...request, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Mint reverted: ${hash}`);

  const [minted] = parseEventLogs({ abi: pixelV2Abi, eventName: "Minted", logs: receipt.logs });
  if (!minted) throw new Error("Minted event not found");
  return { tokenId: minted.args.tokenId, hash }; // tokenId is a bigint
}
```

There is no price, so there is no slippage. The only race is another wallet
minting the same art first. That shows up as `ArtworkAlreadyExists` in
simulation, or as a reverted receipt if it lands between simulation and
inclusion.

### Errors to handle

| Error | Meaning | What to show |
|---|---|---|
| `InvalidName` | Name empty or over 64 bytes | Ask for a shorter or non-empty name |
| `InvalidDescription` | Description over 1,024 bytes | Ask for a shorter description |
| `InvalidUTF8` | Name or description is not valid UTF-8 | Remove invalid characters |
| `InvalidGrid` | Grid is not 8/16/32/64/128/256 | Bug in your client |
| `InvalidPixels` | Empty, too long or not a multiple of 6 | "Paint at least one pixel" or "too detailed" |
| `PixelOutOfBounds` | A run leaves the canvas | Bug in your packer |
| `NonCanonicalPixels` | Order, overlap or unmerged equal neighbours | Bug in your packer |
| `ArtworkAlreadyExists` | Same grid and pixels already minted | "Already minted"; let the user change a pixel |
| `ReentrantCall` | Reentrant mint from a receiver contract | Contract minters only |

The web app's ABI (`apps/web/lib/pixelNftAbi.ts`) leaves these errors out. Keep
them in your ABI so viem can decode reverts.

## Flow 2: read tokens and metadata

**Purpose.** Show a user's tokens, render artwork, display creator and
royalty.

V2 views (`ZeroXPixelV2.sol`):

```solidity
function tokenPackedData(uint256 id) view returns (string artName, string description, uint256 gridSize, bytes pixelData, address creator, uint256 mintedAt, bytes32 artworkHash) // :103-110
function tokenData(uint256 id) view returns (string artName, uint256 gridSize, string pixelData, address creator, uint256 mintedAt, bytes32 artworkHash) // :94-101, legacy hex runs
function tokenURI(uint256 id) view returns (string)                       // :130-146
function tokensOfOwner(address owner) view returns (uint256[])           // :126-128
function totalSupply() view returns (uint256)                            // :46
function artworkRegistry(bytes32) view returns (uint256)                 // :49, 0 = not minted
function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 amount) // :148-152
function transferNFT(address to, uint256 id)                             // :122-124, = safeTransferFrom(msg.sender, to, id)
```

Plus standard ERC-721 (`PixelERC721.sol:45-136`): `balanceOf`, `ownerOf`,
`approve`, `getApproved`, `setApprovalForAll`, `isApprovedForAll`,
`transferFrom`, `safeTransferFrom`. Name is `0xPixel`, symbol `0XP`.

Notes:

- Reads for a token id that does not exist revert.
- `tokenURI` is `data:application/json;base64,...` with `name`, `description`,
  `image` (an SVG data URI), `artwork_hash` and `attributes` (Grid Size, Creator,
  Minted At, Run Count, Encoding Version = 2).
- `royaltyInfo` returns the creator and 1% of the sale price (ERC-2981). The
  marketplace does not use this amount; it pays its own fixed 0.4% creator fee
  (see [Marketplace model](#marketplace-model)).
- Name, description, creator and hash are in contract storage. The pixel bytes
  are stored as the code of one or two STOP-prefixed data contracts
  (`PixelData.sol:4-24`, `ZeroXPixelV2.sol:75,178-180`).
- `tokenData` keeps the old hex-string format so legacy readers still work. A
  256-wide run appears there as 255 + 1. Prefer `tokenPackedData`.

```ts
import { parseAbi, type Address } from "viem";
import { publicClient, PIXEL_V2 } from "./liteforge";

const pixelReadAbi = parseAbi([
  "function tokenPackedData(uint256 tokenId) view returns (string artName, string description, uint256 grid, bytes pixels, address creator, uint256 mintedAt, bytes32 artworkHash)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function tokensOfOwner(address owner) view returns (uint256[])",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 amount)",
]);

export async function loadOwnedArt(owner: Address) {
  const ids = await publicClient.readContract({
    address: PIXEL_V2, abi: pixelReadAbi, functionName: "tokensOfOwner", args: [owner],
  });
  return Promise.all(ids.map(async (id) => { // batched into Multicall3 by viem when batch.multicall is on
    const [artName, description, grid, pixels, creator, mintedAt, artworkHash] = await publicClient.readContract({
      address: PIXEL_V2, abi: pixelReadAbi, functionName: "tokenPackedData", args: [id],
    });
    const uri = await publicClient.readContract({ address: PIXEL_V2, abi: pixelReadAbi, functionName: "tokenURI", args: [id] });
    const prefix = "data:application/json;base64,";
    if (!uri.startsWith(prefix)) throw new Error("Unexpected tokenURI format");
    const json = new TextDecoder().decode(Uint8Array.from(atob(uri.slice(prefix.length)), (c) => c.charCodeAt(0)));
    const meta = JSON.parse(json) as { name: string; description: string; image: string };
    return { id, artName, description, grid, pixels, creator, mintedAt, artworkHash, image: meta.image };
  }));
}
```

Render `image` with an `<img src>` (it is an SVG data URI). Do not inject it as
HTML.

**Classic (V1).** `PixelClassicABI` in `apps/web/lib/abi.ts`; source
`contracts/src/0xpixel/reference/0xPixel.deployed.sol`. It has `tokenData`,
`tokenURI`, `royaltyInfo` (creator, 1%), `checkOriginal(string px, uint256 grid)`
and `getCreator(string px, uint256 grid)`. It supports grids 8 to 64 and names
up to 32 bytes. Treat it as read-only legacy and do not mint new art there.

## Marketplace model

**Contract.** `NusdNftMarketplaceV2` at `nusdMarketplace`
(`contracts/src/0xpixel/NusdNftMarketplaceV2.sol`).

**Fees** (`:61-62`, `apps/web/lib/nusdMarketplace.generated.json:6-7`):

- `BURN_BPS = 10`: 0.1% of the price is burned through `NUSD.burn`.
- `CREATOR_BPS = 40`: 0.4% is credited to the token's ERC-2981 receiver (the
  artist for both 0xPixel collections).
- There is no platform fee and no treasury (`:18-21`).
- `quoteSale(collection, tokenId, price)` returns
  `(burnAmount, creator, creatorFee, sellerProceeds)` (`:226-235`), where
  `burnAmount = price * 10 / 10000`, `creatorFee = price * 40 / 10000` and
  `sellerProceeds = price - burnAmount - creatorFee`.
- If the collection names no creator, or names the market itself, the seller
  keeps the creator share (`:260-264`). If the seller is the creator, the seller
  is credited both parts.
- Example: a 100 NUSD sale (`100n * 10n ** 18n`) burns 0.1 NUSD, credits the
  creator 0.4 NUSD and credits the seller 99.5 NUSD.

**Limits.** Price must be greater than 0 and at most `type(uint128).max`
(`:58`, `:345-347`). Offers last at most 30 days (`MAX_OFFER_DURATION`, `:59`);
the web allows 1 to 720 hours. Page reads are capped at 100 items
(`MAX_PAGE_SIZE`, `:60`). NUSD has 18 decimals (the constructor requires it,
`:96-97`).

**Credits.** Sale proceeds, creator fees and offer refunds are not transferred
to wallets. They are added to `credits(account)` inside the market
(`:266-268`, `:299-300`). `buy` and `makeOffer` spend credits first and pull only
the rest from the wallet (`_fund`, `:283-292`). `maxWalletPayment` caps that wallet
pull, so a change in your credit balance cannot make you pay more than you
approved (`WalletPaymentExceeded`). Withdraw credits with `withdrawNusd`.

Wallet payment for a price:

```ts
export const walletPayment = (price: bigint, credit: bigint) => price - (credit < price ? credit : price);
```

**Pause.** `list`, `updateListingPrice`, `buy`, `makeOffer` and `acceptOffer` are
`whenNotPaused`. `cancelListing`, `cancelOffer`, `expireOffer` and
`withdrawNusd` work while paused.

**Approvals.**

- Seller side (`list`, `acceptOffer`): the market must be approved for the NFT
  before the call, through `approve(market, tokenId)` or
  `setApprovalForAll(market, true)` (`_ownsAndApproves`, `:349-359`). The web
  approves only the one token. Any ERC-721 transfer clears a single-token
  approval.
- Buyer side (`buy`, `makeOffer`): NUSD `approve(market, walletPayment)`. Approve
  the exact shortfall, and only when `allowance < walletPayment`. If credits
  cover the whole price, no approval is needed.

**Functions** (`NusdNftMarketplaceV2.sol`; the web ABI is
`apps/web/lib/nusdMarketplace.ts:10-44`):

```solidity
function list(address collection, uint256 tokenId, uint256 price) returns (uint256 listingId)                    // :109
function updateListingPrice(uint256 listingId, uint256 price)                                                    // :128
function cancelListing(uint256 listingId)                                                                        // :139
function invalidateListing(uint256 listingId)                                                                    // :146, anyone; only if the listing is no longer valid
function buy(uint256 listingId, uint256 expectedPrice, uint256 maxWalletPayment)                                 // :154
function makeOffer(address collection, uint256 tokenId, uint256 price, uint64 expiresAt, uint256 maxWalletPayment) returns (uint256 offerId) // :167
function acceptOffer(uint256 offerId, uint256 minimumSellerProceeds)                                             // :183
function cancelOffer(uint256 offerId)                                                                            // :201
function expireOffer(uint256 offerId)                                                                            // :206, anyone, after expiry
function withdrawNusd(address recipient)                                                                         // :211

function listings(uint256) view returns (address collection, uint256 tokenId, uint256 price, address seller, bool active)
function offers(uint256) view returns (address collection, uint256 tokenId, address offerer, uint256 price, uint64 expiresAt, bool active)
function tokenToListingId(address collection, uint256 tokenId) view returns (uint256)
function getActiveListings(uint256 offset, uint256 limit) view returns (uint256[])  // :250, listing ids; limit <= 100
function getActiveOffers(uint256 offset, uint256 limit) view returns (uint256[])    // :254, offer ids; limit <= 100
// also: IMPLEMENTATION_ID, nusd, BURN_BPS, CREATOR_BPS, paused, listingCount, offerCount,
// activeListingCount, activeOfferCount, escrowedNusd, totalCreditsNusd, totalLiabilitiesNusd,
// totalVolumeNusd, totalSales, collectionAllowed(address), credits(address), quoteSale(...)
```

`getActiveListings` and `getActiveOffers` return ids only. Read each id with
`listings(id)` or `offers(id)` (Multicall3 batches these).

**Events** (`:81-91`). The web ABI has no events; take them from the source:

```solidity
event CollectionAllowed(address indexed collection, bool allowed);
event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 price);
event ListingCancelled(uint256 indexed listingId);
event ListingInvalidated(uint256 indexed listingId);
event ListingPriceUpdated(uint256 indexed listingId, uint256 price);
event Bought(uint256 indexed listingId, address indexed buyer, uint256 price);
event OfferCreated(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address offerer, uint256 price, uint64 expiresAt);
event OfferCancelled(uint256 indexed offerId, address indexed offerer, uint256 refund); // also emitted by expireOffer
event OfferAccepted(uint256 indexed offerId, address indexed seller, address indexed buyer, uint256 price);
event SaleSettled(address indexed seller, address indexed buyer, address indexed collection, uint256 tokenId, uint256 price, uint256 burned, address creator, uint256 creatorFee);
event NusdWithdrawn(address indexed account, address indexed recipient, uint256 amount);
```

### Marketplace setup code

```ts
// market.ts
import { parseAbi, type Address } from "viem";
import { publicClient, MARKET, NUSD, MARKET_IMPLEMENTATION_ID } from "./liteforge";
import { send } from "./send";

export const marketAbi = parseAbi([
  "function IMPLEMENTATION_ID() view returns (bytes32)",
  "function nusd() view returns (address)",
  "function paused() view returns (bool)",
  "function credits(address) view returns (uint256)",
  "function collectionAllowed(address) view returns (bool)",
  "function tokenToListingId(address collection, uint256 tokenId) view returns (uint256)",
  "function listings(uint256) view returns (address collection, uint256 tokenId, uint256 price, address seller, bool active)",
  "function offers(uint256) view returns (address collection, uint256 tokenId, address offerer, uint256 price, uint64 expiresAt, bool active)",
  "function quoteSale(address collection, uint256 tokenId, uint256 price) view returns (uint256 burnAmount, address creator, uint256 creatorFee, uint256 sellerProceeds)",
  "function list(address collection, uint256 tokenId, uint256 price) returns (uint256)",
  "function updateListingPrice(uint256 listingId, uint256 price)",
  "function cancelListing(uint256 listingId)",
  "function invalidateListing(uint256 listingId)",
  "function buy(uint256 listingId, uint256 expectedPrice, uint256 maxWalletPayment)",
  "function makeOffer(address collection, uint256 tokenId, uint256 price, uint64 expiresAt, uint256 maxWalletPayment) returns (uint256)",
  "function acceptOffer(uint256 offerId, uint256 minimumSellerProceeds)",
  "function cancelOffer(uint256 offerId)",
  "function expireOffer(uint256 offerId)",
  "function withdrawNusd(address recipient)",
  "event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 price)",
  "event OfferCreated(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address offerer, uint256 price, uint64 expiresAt)",
  "event SaleSettled(address indexed seller, address indexed buyer, address indexed collection, uint256 tokenId, uint256 price, uint256 burned, address creator, uint256 creatorFee)",
  "event NusdWithdrawn(address indexed account, address indexed recipient, uint256 amount)",
  "error InvalidConfiguration()", "error CollectionNotAllowed()", "error InvalidPrice()", "error InvalidExpiry()",
  "error Inactive()", "error Unauthorized()", "error NotPurchasable()", "error AlreadyListed()", "error PriceChanged()",
  "error NonExactTransfer()", "error NothingToWithdraw()", "error InvalidPage()", "error InsufficientProceeds()",
  "error WalletPaymentExceeded()", "error EnforcedPause()", "error ReentrancyGuardReentrantCall()",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const erc721Abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 tokenId)",
]);

export const MAX_PRICE = (1n << 128n) - 1n;
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
export const walletPayment = (price: bigint, credit: bigint) => price - (credit < price ? credit : price);

/** Verifies the market identity at the latest block. Throws if trading is paused and `trading` is true. */
export async function checkMarket(trading: boolean) {
  const [token, impl, paused] = await Promise.all([
    publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "nusd" }),
    publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "IMPLEMENTATION_ID" }),
    publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "paused" }),
  ]);
  if (!same(token, NUSD) || impl !== MARKET_IMPLEMENTATION_ID) throw new Error("Unexpected marketplace contract");
  if (trading && paused) throw new Error("Trading is paused");
}

export async function ensureNftApproval(account: Address, collection: Address, tokenId: bigint) {
  const [approved, all] = await Promise.all([
    publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "getApproved", args: [tokenId] }),
    publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "isApprovedForAll", args: [account, MARKET] }),
  ]);
  if (all || same(approved, MARKET)) return;
  await send({ account, address: collection, abi: erc721Abi, functionName: "approve", args: [MARKET, tokenId] });
}

export async function ensureNusdAllowance(account: Address, amount: bigint) {
  if (amount === 0n) return;
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({ address: NUSD, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: NUSD, abi: erc20Abi, functionName: "allowance", args: [account, MARKET] }),
  ]);
  if (balance < amount) throw new Error("Not enough NUSD in the wallet");
  if (allowance < amount) await send({ account, address: NUSD, abi: erc20Abi, functionName: "approve", args: [MARKET, amount] });
}
```

## Flow 3: list an NFT or change its price

**Purpose.** Offer an owned 0xPixel token for a fixed NUSD price. The NFT stays
in the seller's wallet until a buyer pays.

**Preconditions.** Caller owns the token, the collection is allowed, the market
is not paused, and the market is approved for the token.

**Steps.**

1. Check chain 4441 and the market identity; stop if paused.
2. Parse the price with `parseUnits(text, 18)`; require `0 < price <= 2^128 - 1`.
3. Read `collectionAllowed(collection)` and `ownerOf(tokenId)`.
4. Read `tokenToListingId(collection, tokenId)` and that listing. If it is active
   and yours, call `updateListingPrice` instead of `list`.
5. Ensure NFT approval for this token.
6. Simulate, send, wait for the receipt, read `Listed` for the listing id.

```ts
import { parseEventLogs, parseUnits, type Address } from "viem";
import { publicClient, connectedAccount, MARKET } from "./liteforge";
import { send } from "./send";
import { marketAbi, erc721Abi, checkMarket, ensureNftApproval, MAX_PRICE } from "./market";

export async function listOrReprice(collection: Address, tokenId: bigint, priceText: string) {
  const account = await connectedAccount();
  await checkMarket(true);
  const price = parseUnits(priceText, 18);
  if (price <= 0n || price > MAX_PRICE) throw new Error("Invalid price");

  const [allowed, owner, existingId] = await Promise.all([
    publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "collectionAllowed", args: [collection] }),
    publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] }),
    publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "tokenToListingId", args: [collection, tokenId] }),
  ]);
  if (!allowed) throw new Error("This collection is not tradable here");
  if (owner.toLowerCase() !== account.toLowerCase()) throw new Error("You do not own this token");

  if (existingId !== 0n) {
    const [, , oldPrice, seller, active] = await publicClient.readContract({
      address: MARKET, abi: marketAbi, functionName: "listings", args: [existingId],
    });
    if (active && seller.toLowerCase() === account.toLowerCase()) {
      if (oldPrice === price) return { listingId: existingId };
      await ensureNftApproval(account, collection, tokenId); // updateListingPrice also checks approval
      await send({ account, address: MARKET, abi: marketAbi, functionName: "updateListingPrice", args: [existingId, price] });
      return { listingId: existingId };
    }
  }

  await ensureNftApproval(account, collection, tokenId);
  const receipt = await send({ account, address: MARKET, abi: marketAbi, functionName: "list", args: [collection, tokenId, price] });
  const [listed] = parseEventLogs({ abi: marketAbi, eventName: "Listed", logs: receipt.logs });
  if (!listed) throw new Error("Listed event not found");
  return { listingId: listed.args.listingId };
}
```

**Errors.** `CollectionNotAllowed`, `InvalidPrice`, `NotPurchasable` (not the
owner, or the market is not approved), `AlreadyListed` (an active, still-valid
listing exists; a stale listing by a former owner is invalidated automatically,
`:113-119`), `Unauthorized` and `Inactive` on `updateListingPrice`,
`EnforcedPause`.

## Flow 4: buy a listing

**Purpose.** Pay a listing's price in NUSD and receive the NFT.

**Slippage guard.** `expectedPrice` must equal the current price or the call
reverts `PriceChanged`. `maxWalletPayment` caps what leaves the wallet. Read
both fresh right before signing.

**Steps.**

1. Check chain and market; stop if paused.
2. Read `listings(id)`: require `active` and a seller that is not you.
3. Read `credits(account)`; compute `pay = walletPayment(price, credit)`.
4. Check NUSD balance; approve exactly `pay` if allowance is lower.
5. Simulate `buy(id, price, pay)`, send, wait for the receipt.

```ts
import { publicClient, connectedAccount, MARKET } from "./liteforge";
import { send } from "./send";
import { marketAbi, checkMarket, ensureNusdAllowance, walletPayment } from "./market";

export async function buyListing(listingId: bigint) {
  const account = await connectedAccount();
  await checkMarket(true);
  const [, , price, seller, active] = await publicClient.readContract({
    address: MARKET, abi: marketAbi, functionName: "listings", args: [listingId],
  });
  if (!active) throw new Error("Listing is no longer active");
  if (seller.toLowerCase() === account.toLowerCase()) throw new Error("You cannot buy your own listing");

  const credit = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "credits", args: [account] });
  const pay = walletPayment(price, credit);
  await ensureNusdAllowance(account, pay); // also checks wallet balance

  return send({ account, address: MARKET, abi: marketAbi, functionName: "buy", args: [listingId, price, pay] });
}
```

**Errors.** `Inactive`, `PriceChanged` (re-read and show the new price),
`Unauthorized` (own listing), `NotPurchasable` (seller lost the NFT or its
approval), `WalletPaymentExceeded` (credits dropped since you read them),
`EnforcedPause`, ERC-20 balance or allowance failures. The NFT is sent with
`safeTransferFrom` (`:273`): a contract buyer must implement
`onERC721Received`.

## Flow 5: make an offer

**Purpose.** Escrow NUSD against any existing token in an allowed collection,
listed or not. The full price is locked until it is accepted, cancelled or
expired.

**Preconditions.** The token exists (`ownerOf` does not revert), you are not the
owner, the collection is allowed, and `now < expiresAt <= now + 30 days`.

**Steps.**

1. Check chain and market; stop if paused.
2. Parse the price; read `collectionAllowed` and `ownerOf`.
3. Read the latest block timestamp; `expiresAt = timestamp + hours * 3600n` with
   hours from 1 to 720.
4. Read credits; compute `pay`; approve exactly `pay` if needed.
5. Simulate `makeOffer`, send, wait, read `OfferCreated` for the offer id.

```ts
import { parseEventLogs, parseUnits, type Address } from "viem";
import { publicClient, connectedAccount, MARKET } from "./liteforge";
import { send } from "./send";
import { marketAbi, erc721Abi, checkMarket, ensureNusdAllowance, walletPayment, MAX_PRICE } from "./market";

export async function makeOffer(collection: Address, tokenId: bigint, priceText: string, hours: bigint) {
  const account = await connectedAccount();
  await checkMarket(true);
  const price = parseUnits(priceText, 18);
  if (price <= 0n || price > MAX_PRICE) throw new Error("Invalid price");
  if (hours < 1n || hours > 720n) throw new Error("Duration must be 1-720 hours");

  const [allowed, owner] = await Promise.all([
    publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "collectionAllowed", args: [collection] }),
    publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] }), // reverts if missing
  ]);
  if (!allowed) throw new Error("This collection is not tradable here");
  if (owner.toLowerCase() === account.toLowerCase()) throw new Error("You already own this token");

  const { timestamp } = await publicClient.getBlock({ blockTag: "latest" });
  const expiresAt = timestamp + hours * 3600n;

  const credit = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "credits", args: [account] });
  const pay = walletPayment(price, credit);
  await ensureNusdAllowance(account, pay);

  const receipt = await send({
    account, address: MARKET, abi: marketAbi, functionName: "makeOffer",
    args: [collection, tokenId, price, expiresAt, pay],
  });
  const [created] = parseEventLogs({ abi: marketAbi, eventName: "OfferCreated", logs: receipt.logs });
  if (!created) throw new Error("OfferCreated event not found");
  return { offerId: created.args.offerId, expiresAt };
}
```

**Errors.** `CollectionNotAllowed`, `InvalidPrice`, `InvalidExpiry` (expiry in
the past or more than 30 days ahead), `Unauthorized` (you own the token), an
`ownerOf` revert (token does not exist), `WalletPaymentExceeded`,
`EnforcedPause`.

## Flow 6: accept an offer

**Purpose.** The current owner sells the token to an offer's maker.

**Slippage guard.** `minimumSellerProceeds` is the least the seller will accept
after the 0.1% burn and the 0.4% creator fee. Take it from `quoteSale` right
before signing. The call reverts `InsufficientProceeds` if settlement would pay
less.

**Steps.**

1. Check chain and market; stop if paused.
2. Read `offers(id)`: require `active`, `now < expiresAt` and an offerer that is
   not you.
3. Read `quoteSale(collection, tokenId, price)`; use `sellerProceeds`.
4. Ensure NFT approval for the token.
5. Simulate `acceptOffer(id, sellerProceeds)`, send, wait.

Accepting also cancels the token's active listing, if any (`:192-196`, emits
`ListingCancelled`).

```ts
import { publicClient, connectedAccount, MARKET } from "./liteforge";
import { send } from "./send";
import { marketAbi, checkMarket, ensureNftApproval } from "./market";

export async function acceptOffer(offerId: bigint) {
  const account = await connectedAccount();
  await checkMarket(true);
  const [collection, tokenId, offerer, price, expiresAt, active] = await publicClient.readContract({
    address: MARKET, abi: marketAbi, functionName: "offers", args: [offerId],
  });
  const { timestamp } = await publicClient.getBlock({ blockTag: "latest" });
  if (!active) throw new Error("Offer is closed");
  if (timestamp >= expiresAt) throw new Error("Offer has expired");
  if (offerer.toLowerCase() === account.toLowerCase()) throw new Error("You cannot accept your own offer");

  const [, , , sellerProceeds] = await publicClient.readContract({
    address: MARKET, abi: marketAbi, functionName: "quoteSale", args: [collection, tokenId, price],
  });
  await ensureNftApproval(account, collection, tokenId);
  return send({ account, address: MARKET, abi: marketAbi, functionName: "acceptOffer", args: [offerId, sellerProceeds] });
}
```

**Errors.** `Inactive`, `InvalidExpiry` (expired), `Unauthorized` (own offer),
`NotPurchasable` (not the owner, or no approval), `InsufficientProceeds`,
`EnforcedPause`.

## Flow 7: cancel, expire and withdraw

These calls need no approvals and all of them work while the market is paused.

| Call | Who | Effect | Errors |
|---|---|---|---|
| `cancelListing(listingId)` | Seller | Closes the listing | `Inactive`, `Unauthorized` |
| `invalidateListing(listingId)` | Anyone | Closes a listing whose seller lost ownership or approval, or whose collection was disabled | `Inactive`, `NotPurchasable` if the listing is still valid |
| `cancelOffer(offerId)` | Offerer | Refunds the escrow to the offerer's credits | `Inactive`, `Unauthorized` |
| `expireOffer(offerId)` | Anyone, after `expiresAt` | Refunds the escrow to the offerer's credits (never to the caller) | `Inactive`, `InvalidExpiry` if not expired |
| `withdrawNusd(recipient)` | Any account with credits | Sends all of `credits(msg.sender)` to `recipient` | `NothingToWithdraw`, `InvalidConfiguration` (recipient is zero or the market), `NonExactTransfer` |

```ts
import { publicClient, connectedAccount, MARKET } from "./liteforge";
import { send } from "./send";
import { marketAbi, checkMarket } from "./market";

export async function withdrawCredits() {
  const account = await connectedAccount();
  await checkMarket(false); // allowed while paused
  const credit = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "credits", args: [account] });
  if (credit === 0n) throw new Error("Nothing to withdraw");
  return send({ account, address: MARKET, abi: marketAbi, functionName: "withdrawNusd", args: [account] });
}

export async function cancelListing(listingId: bigint) {
  const account = await connectedAccount();
  await checkMarket(false);
  return send({ account, address: MARKET, abi: marketAbi, functionName: "cancelListing", args: [listingId] });
}

export async function cancelOffer(offerId: bigint) {
  const account = await connectedAccount();
  await checkMarket(false);
  return send({ account, address: MARKET, abi: marketAbi, functionName: "cancelOffer", args: [offerId] });
}

export async function expireOffer(offerId: bigint) {
  const account = await connectedAccount();
  await checkMarket(false);
  const [, , , , expiresAt, active] = await publicClient.readContract({
    address: MARKET, abi: marketAbi, functionName: "offers", args: [offerId],
  });
  const { timestamp } = await publicClient.getBlock({ blockTag: "latest" });
  if (!active || timestamp < expiresAt) throw new Error("Offer cannot be expired yet");
  return send({ account, address: MARKET, abi: marketAbi, functionName: "expireOffer", args: [offerId] });
}
```

A smart-contract seller or creator must be able to call `withdrawNusd` itself.
Credits cannot be pushed to it.

## Reading data: RPC or subgraph

Use **RPC** for anything you act on: prices, `active` flags, credits, owners,
approvals, pause state and quotes. Read them at the latest block right before
signing. The web refuses to sign on reads older than 60 seconds
(`apps/web/lib/nusdMarketplace.ts:87-90`).

Use the **subgraph** for history, activity feeds, search and totals. It lags
the chain by a few blocks and must not gate a transaction.

Subgraph: `pixel-nusd-market/1.1.0` (endpoint in the
[address table](#contracts-and-addresses)). It indexes the marketplace and
`Transfer` mints from both 0xPixel collections, all from block `61141428`
(`subgraphs/0xpixel-nusd-market/subgraph.yaml:12,51,71`). Mints before that
block are not in it; read them over RPC from the collection deployment blocks.

Entities (`subgraphs/0xpixel-nusd-market/schema.graphql`):

| Entity | Fields |
|---|---|
| `NusdListing` (`:25-36`) | `id` (listing id), `collection`, `tokenId`, `seller`, `price` (NUSD wei), `status` (`ACTIVE`, `SOLD`, `CANCELLED`, `INVALIDATED`), `buyer`, `listedAt`, `updatedAt` |
| `NusdOffer` (`:38-49`) | `id`, `collection`, `tokenId`, `offerer`, `price`, `expiresAt`, `status` (`ACTIVE`, `ACCEPTED`, `REFUNDED`), `createdAt`, `updatedAt` |
| `NusdActivity` (`:51-66`, immutable) | `type` (`MINTED`, `LISTED`, `UPDATED`, `BOUGHT`, `CANCELLED`, `OFFER_CREATED`, `OFFER_REFUNDED`), `collection`, `tokenId`, `actor`, `other`, `price`, `blockNumber`, `logIndex`, `sortKey`, `timestamp`, `transactionHash` |
| `NusdMarketStats` (`:68-77`, id `"global"`) | `listings`, `sales`, `volume`, `offers`, `burned`, `updatedAt` |

Notes:

- `BOUGHT` comes from `SaleSettled` and covers both purchases and accepted
  offers. `actor` is the seller and `other` the buyer
  (`subgraphs/0xpixel-nusd-market/src/mapping.ts:103-107`).
- `ListingInvalidated` sets the listing's `status` to `INVALIDATED` but writes
  a `CANCELLED` activity (`mapping.ts:91-94`).
- A listing closed by an accepted offer ends as `CANCELLED`, not `SOLD`:
  `acceptOffer` emits `ListingCancelled` (`NusdNftMarketplaceV2.sol:192-196`,
  `mapping.ts:86-89`). Only `buy` sets `SOLD` and `buyer` (`mapping.ts:96-101`).
- An offer past `expiresAt` stays `ACTIVE` until someone calls `expireOffer`.
  Compare `expiresAt` with the current time yourself.
- `BigInt` fields arrive as decimal strings. Convert with `BigInt(value)`.

```graphql
query MarketOverview($first: Int!) {
  nusdMarketStats(id: "global") { listings sales volume offers burned }
  nusdListings(where: { status: ACTIVE }, orderBy: price, orderDirection: asc, first: $first) {
    id collection tokenId seller price listedAt
  }
  nusdActivities(orderBy: sortKey, orderDirection: desc, first: 20) {
    type collection tokenId actor other price timestamp transactionHash
  }
}
```

```ts
import { formatUnits } from "viem";
import { SUBGRAPH_URL } from "./liteforge";

export async function marketOverview(query: string) {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { first: 24 } }),
  });
  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors[0].message);
  return data.nusdListings.map((l: { id: string; collection: string; tokenId: string; seller: string; price: string }) => ({
    listingId: BigInt(l.id),
    collection: l.collection,
    tokenId: BigInt(l.tokenId),
    seller: l.seller,
    price: BigInt(l.price),
    priceLabel: formatUnits(BigInt(l.price), 18),
  }));
}
```

Before a user buys a listing found in the subgraph, re-read `listings(id)` over
RPC (Flow 4 does this).

## Error reference

0xPixel V2 (`ZeroXPixelV2.sol:24-32`): `InvalidName`, `InvalidDescription`,
`InvalidUTF8`, `InvalidGrid`, `InvalidPixels`, `PixelOutOfBounds`,
`NonCanonicalPixels`, `ArtworkAlreadyExists`, `ReentrantCall`.

Marketplace (`NusdNftMarketplaceV2.sol:42-55`): `InvalidConfiguration`,
`CollectionNotAllowed`, `InvalidPrice`, `InvalidExpiry`, `Inactive`,
`Unauthorized`, `NotPurchasable`, `AlreadyListed`, `PriceChanged`,
`NonExactTransfer`, `NothingToWithdraw`, `InvalidPage`, `InsufficientProceeds`,
`WalletPaymentExceeded`. Also OpenZeppelin `EnforcedPause()` and
`ReentrancyGuardReentrantCall()`.

The web app's marketplace ABI (`apps/web/lib/nusdMarketplace.ts:37-43`) declares
only 7 of the 14 custom errors and no events. Use the full lists above so viem
can decode every revert.

Decoding with viem:

```ts
import { BaseError, ContractFunctionRevertedError } from "viem";

export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
}
```

## Safety checklist

- [ ] Addresses are loaded from `contracts/deployments/v3-core.json` and
      `apps/web/lib/nusdMarketplace.generated.json`, not typed in.
- [ ] Every write checks chain id `4441` first.
- [ ] Before trading: `nusd()` equals the NUSD address, `IMPLEMENTATION_ID()`
      equals `0xcacabae4...3739`, `collectionAllowed(collection)` is `true`, and
      `paused()` is `false` for list, reprice, buy, offer and accept.
- [ ] Mint: art is encoded canonically, name 1-64 bytes, description at most
      1,024 bytes, `checkOriginalPacked` is `true`, no `value` is sent, gas
      has headroom and fits the block.
- [ ] Buy: `expectedPrice` is the freshly read listing price; `maxWalletPayment`
      is `price - min(credits, price)` from a fresh `credits` read.
- [ ] Accept: `minimumSellerProceeds` comes from a fresh `quoteSale`.
- [ ] Offer: `expiresAt` is based on the latest block timestamp and is at most
      30 days ahead.
- [ ] NUSD approval is the exact wallet shortfall and only when allowance is
      lower. NFT approval is single-token (`approve`), not `setApprovalForAll`.
- [ ] Every write is simulated with the exact account and no `value` (all
      functions are nonpayable, so 0 zkLTC), then sent, then the receipt is
      awaited and `status === "success"` is required.
- [ ] Decimals: NUSD amounts use `parseUnits(x, 18)` and `formatUnits(x, 18)`;
      never JavaScript `number` for amounts or token ids.
- [ ] Subgraph data is never used as the pre-sign check; re-read on RPC.
- [ ] Users are told that proceeds and refunds become market credits and must be
      withdrawn with `withdrawNusd`.
- [ ] Contract wallets that buy, mint or receive transfers implement
      `onERC721Received`.
- [ ] No private keys, seed phrases or API keys in source, logs or the client
      bundle.
- [ ] NUSD is a testnet token. It is not a promise of a $1 exchange value.
