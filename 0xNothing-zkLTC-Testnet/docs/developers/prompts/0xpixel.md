# 0xPixel: prompts for coding agents

Ready-to-paste prompts for Claude Code, Cursor, Codex or any other coding
agent. Each prompt stands on its own: paste one into a fresh session in your
project. Every prompt assumes the agent can read this repository (or that you
paste in the files it names). The full reference is
[../0xpixel.md](../0xpixel.md).

None of these prompts needs a secret. If an agent asks for a private key, seed
phrase or API key, refuse: users sign in their own wallet.

Prompts:

1. [Mint studio](#1-mint-studio)
2. [Gallery and token viewer](#2-gallery-and-token-viewer)
3. [Marketplace: list and buy](#3-marketplace-list-and-buy)
4. [Marketplace: offers](#4-marketplace-offers)
5. [Credits and activity feed](#5-credits-and-activity-feed)

## 1. Mint studio

```text
Build a "0xPixel mint studio" page in my Next.js (App Router) + TypeScript app using viem and wagmi. Users draw pixel art and mint it to the 0xPixel V2 NFT contract on LitVM LiteForge testnet.

CHAIN
- Define the chain with viem defineChain: id 4441, name "LitVM LiteForge", native currency zkLTC (18 decimals).
- RPC http: "https://liteforge.rpc.caldera.xyz/infra-partner-http", fallback "https://liteforge.rpc.caldera.xyz/http". WebSocket: "wss://liteforge.rpc.caldera.xyz/infra-partner-ws". Explorer: "https://liteforge.explorer.caldera.xyz". Multicall3: 0xca11bde05977b3631167028862be2a173976ca11. These come from 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts.

ADDRESSES
- Load the collection address from 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json key "pixelV2" (check "chainId" is 4441). Copy that JSON into my repo as config/0xnothing/v3-core.json and import it. Do not hard-code the address in components.

ABI (copy exactly; source 0xNothing-zkLTC-Testnet/contracts/src/0xpixel/ZeroXPixelV2.sol)
- function mintPacked(string artName, string description, uint256 grid, bytes pixels) returns (uint256)
- function checkOriginalPacked(bytes pixels, uint256 grid) view returns (bool)
- event Minted(address indexed creator, uint256 indexed tokenId, string name)
- errors: InvalidName(), InvalidDescription(), InvalidUTF8(), InvalidGrid(), InvalidPixels(), PixelOutOfBounds(), NonCanonicalPixels(), ArtworkAlreadyExists(), ReentrantCall()

ENCODING (the contract rejects anything else)
- Grid sizes: 8, 16, 32, 64, 128, 256. Cells are "#rrggbb" or transparent.
- pixels = raw bytes, 6 per horizontal run: [x, y, countMinusOne, r, g, b]. Width = countMinusOne + 1.
- Row-major: rows by y ascending, runs by x ascending, no overlap. Adjacent cells of the same colour in a row MUST be merged into one run. Transparent cells produce no bytes.
- At least 1 run, at most 4,096 runs (24,576 bytes). Count runs live and block minting above the limit.
- Write packPixels(rows, grid): Hex as a pure function with unit tests: merging, transparency gaps, a full 256-wide row (countMinusOne = 255), empty canvas throws, 4,097 runs throws.

FLOW for "Mint"
1. Require a connected wallet. If chainId !== 4441, show "Switch to LiteForge" and call switchChain; do not continue until it is 4441.
2. Validate with TextEncoder: trimmed name 1-64 bytes, description 0-1,024 bytes.
3. Pack. Read checkOriginalPacked(pixels, BigInt(grid)) fresh (debounce while drawing, and again right before signing). false => "Already minted". A revert => encoding bug, show it.
4. simulateContract mintPacked with the connected account and no value field (mintPacked is nonpayable, so the mint sends 0 zkLTC; viem's types reject `value` on nonpayable functions). No token approvals exist for this flow.
5. estimateContractGas, gas = est + est/5n + 100_000n; read latest block and refuse if gas > 90% of block.gasLimit ("Too detailed for one block").
6. writeContract with the simulated request and that gas. waitForTransactionReceipt. Require receipt.status === "success". Parse the Minted log for tokenId (bigint) and link to the explorer tx.
7. Decode reverts with viem's ContractFunctionRevertedError and map each error name to a plain message.

UI STATES
- Canvas editor with grid-size picker, colour picker, eraser (transparent), clear; live run counter "N / 4,096".
- Checking originality, original, already minted, encoding error.
- Wrong network, not connected, simulating, waiting for wallet signature, pending (tx hash link), success (token id + link), failed (decoded error), user rejected.
- Disable the Mint button while any request is in flight; prevent double submit.

ACCEPTANCE CHECKLIST
- [ ] No address literal in components; it comes from the copied v3-core.json.
- [ ] Every amount, grid argument and token id is a bigint at the contract boundary.
- [ ] packPixels unit tests pass, including merge and 256-wide-row cases.
- [ ] Chain id 4441 is checked before simulate and before write.
- [ ] Originality is re-read right before signing; simulate runs with the exact account and no value field (0 zkLTC).
- [ ] Receipt status is checked; success is only shown after status === "success".
- [ ] All 9 contract errors decode to readable messages.
- [ ] No private keys, API keys or .env secrets anywhere; typecheck and lint pass.
```

## 2. Gallery and token viewer

```text
Build a read-only "0xPixel gallery" in my Next.js (App Router) + TypeScript app with viem. It shows a wallet's 0xPixel V2 tokens and a detail page per token. No transactions.

CHAIN
- viem defineChain: id 4441, "LitVM LiteForge", zkLTC 18 decimals, RPC "https://liteforge.rpc.caldera.xyz/infra-partner-http" with fallback "https://liteforge.rpc.caldera.xyz/http", Multicall3 0xca11bde05977b3631167028862be2a173976ca11 (from 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts). Use a public client with batch.multicall enabled.

ADDRESSES
- Copy 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json into config/0xnothing/v3-core.json. V2 collection = "pixelV2", Classic (legacy, read-only) = "pixelV1". Assert chainId 4441.

ABI (copy exactly; source 0xNothing-zkLTC-Testnet/contracts/src/0xpixel/ZeroXPixelV2.sol and PixelERC721.sol)
- function tokensOfOwner(address owner) view returns (uint256[])
- function tokenPackedData(uint256 tokenId) view returns (string artName, string description, uint256 grid, bytes pixels, address creator, uint256 mintedAt, bytes32 artworkHash)
- function tokenURI(uint256 tokenId) view returns (string)
- function ownerOf(uint256 tokenId) view returns (address)
- function totalSupply() view returns (uint256)
- function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 amount)

FLOW
1. Address input (or connected wallet) -> tokensOfOwner(address) on V2.
2. For each id (batched): tokenPackedData and tokenURI. tokenURI is "data:application/json;base64,<json>"; decode base64 as UTF-8 bytes (not plain atob to string) and JSON.parse. Fields: name, description, image (SVG data URI), artwork_hash, attributes.
3. Render image only via <img src={image}> (never dangerouslySetInnerHTML). Use CSS image-rendering: pixelated.
4. Detail page /pixel/[tokenId]: owner (ownerOf), creator, grid, minted date (mintedAt is unix seconds, bigint), artwork hash, royalty (royaltyInfo(id, 10000n) -> show basis points; it is 1%).
5. Reads for a nonexistent token revert: show "Token not found", not a crash.
6. Optional: render pixels yourself from tokenPackedData.pixels (6-byte runs [x, y, countMinusOne, r, g, b]) to a canvas, and check it matches the SVG.

UI STATES
- Empty address, invalid address (viem isAddress), loading skeletons, no tokens, list, RPC error with retry, token not found.

ACCEPTANCE CHECKLIST
- [ ] Addresses come from the copied manifest, not literals.
- [ ] Token ids and timestamps stay bigint until formatting.
- [ ] Metadata decoding handles non-ASCII names (UTF-8) correctly.
- [ ] SVG is shown with <img>, never injected as HTML.
- [ ] Reads are batched through Multicall3; no per-token waterfall of sequential awaits.
- [ ] No writes, no wallet required to browse; no secrets; typecheck and lint pass.
```

## 3. Marketplace: list and buy

```text
Build a "0xPixel NUSD marketplace" listing/buying panel in my Next.js (App Router) + TypeScript app using viem + wagmi. Contract: NusdNftMarketplaceV2 on LitVM LiteForge testnet. Prices are in NUSD (ERC-20, 18 decimals). zkLTC pays gas only; no call sends value.

CHAIN
- defineChain id 4441, "LitVM LiteForge", zkLTC 18 decimals, RPC "https://liteforge.rpc.caldera.xyz/infra-partner-http" (fallback "https://liteforge.rpc.caldera.xyz/http"), Multicall3 0xca11bde05977b3631167028862be2a173976ca11 (from 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts).

ADDRESSES
- Copy 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json (keys "nusdMarketplace", "nusd", "pixelV1", "pixelV2") and 0xNothing-zkLTC-Testnet/apps/web/lib/nusdMarketplace.generated.json (keys "address", "nusd", "implementation", "collections", "deploymentBlock") into config/0xnothing/. At start-up assert both have chainId 4441 and agree on market and NUSD addresses; otherwise disable trading.

ABI (copy exactly; source 0xNothing-zkLTC-Testnet/contracts/src/0xpixel/NusdNftMarketplaceV2.sol)
Market:
- function IMPLEMENTATION_ID() view returns (bytes32)
- function nusd() view returns (address)
- function paused() view returns (bool)
- function collectionAllowed(address) view returns (bool)
- function credits(address) view returns (uint256)
- function tokenToListingId(address collection, uint256 tokenId) view returns (uint256)
- function listings(uint256) view returns (address collection, uint256 tokenId, uint256 price, address seller, bool active)
- function getActiveListings(uint256 offset, uint256 limit) view returns (uint256[])   (limit <= 100)
- function activeListingCount() view returns (uint256)
- function quoteSale(address collection, uint256 tokenId, uint256 price) view returns (uint256 burnAmount, address creator, uint256 creatorFee, uint256 sellerProceeds)
- function list(address collection, uint256 tokenId, uint256 price) returns (uint256)
- function updateListingPrice(uint256 listingId, uint256 price)
- function cancelListing(uint256 listingId)
- function buy(uint256 listingId, uint256 expectedPrice, uint256 maxWalletPayment)
- event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 price)
- event SaleSettled(address indexed seller, address indexed buyer, address indexed collection, uint256 tokenId, uint256 price, uint256 burned, address creator, uint256 creatorFee)
- errors: InvalidConfiguration(), CollectionNotAllowed(), InvalidPrice(), InvalidExpiry(), Inactive(), Unauthorized(), NotPurchasable(), AlreadyListed(), PriceChanged(), NonExactTransfer(), NothingToWithdraw(), InvalidPage(), InsufficientProceeds(), WalletPaymentExceeded(), EnforcedPause(), ReentrancyGuardReentrantCall()
ERC-20 (NUSD): balanceOf(address), allowance(address,address), approve(address,uint256) returns (bool)
ERC-721 (collections): ownerOf(uint256), getApproved(uint256), isApprovedForAll(address,address), approve(address,uint256)

RULES
- Fees: 0.1% burned (BURN_BPS 10), 0.4% to the creator (CREATOR_BPS 40), no platform fee. Show the quoteSale breakdown on every price input.
- Proceeds are NOT sent to the seller's wallet: they become credits(seller) inside the market and must be withdrawn later. Say so in the UI.
- Buying spends credits first: walletPayment = price - min(credits, price).
- Price: parseUnits(input, 18); require 0 < price <= 2^128 - 1.

GUARDS FOR EVERY WRITE
1. Wallet connected and chainId === 4441 (else switchChain and stop).
2. Fresh reads at the latest block: nusd() equals the manifest NUSD, IMPLEMENTATION_ID() equals the manifest "implementation", paused() is false. If paused: disable list/reprice/buy but keep cancel available.
3. simulateContract with the exact connected account and no value field (every market function is nonpayable, so 0 zkLTC; viem rejects `value` on nonpayable functions), then writeContract(request), then waitForTransactionReceipt and require status === "success". Only then refresh data and show success.
4. Decode reverts with ContractFunctionRevertedError into plain messages.

FLOW: list / reprice
1. Read collectionAllowed(collection), ownerOf(tokenId) (must be the user), tokenToListingId(collection, tokenId) and that listing.
2. If an active listing by the user exists: updateListingPrice(id, price) (skip if same price). Else list(collection, tokenId, price).
3. NFT approval branch before list/reprice: if !isApprovedForAll(user, market) && getApproved(tokenId) !== market, send approve(market, tokenId) first (single token; never setApprovalForAll), wait for its receipt.
4. Read the listing id from the Listed event.

FLOW: buy
1. Re-read listings(id) right before signing: must be active, seller !== user. Use this fresh price as expectedPrice (this is the slippage guard; PriceChanged means re-quote and ask again).
2. Read credits(user); walletPayment = price - min(credits, price). Check NUSD balanceOf(user) >= walletPayment.
3. Allowance branch: if walletPayment > 0 and allowance(user, market) < walletPayment, approve(market, walletPayment) exactly, wait for receipt.
4. buy(id, price, walletPayment) — maxWalletPayment = walletPayment caps wallet spend.

FLOW: cancel listing — cancelListing(id), seller only, works while paused.

UI STATES
- Listing grid (page size 24 via getActiveListings + listings(id) multicall), sort by price, filter by collection.
- Per action: idle, wrong network, paused, checking, needs NFT approval, approving, needs NUSD approval, approving, simulating, awaiting signature, pending (explorer link), success, failed (decoded error), user rejected.
- Show "pay from credits X / from wallet Y" before buying.
- Lock buttons while a transaction is pending; re-read state after every receipt.

ACCEPTANCE CHECKLIST
- [ ] Addresses and implementation marker come from the copied manifests; trading disabled if they disagree or the on-chain identity check fails.
- [ ] All amounts bigint; parseUnits/formatUnits with 18 decimals.
- [ ] Chain check, fresh read, simulate, write, receipt-status check on every write.
- [ ] buy uses the freshly read price as expectedPrice and exact walletPayment as maxWalletPayment.
- [ ] NUSD approval is exact and only when allowance is short; NFT approval is single-token and only when missing.
- [ ] Paused market blocks list/reprice/buy but not cancel.
- [ ] All 14 custom errors plus EnforcedPause decode to readable messages.
- [ ] No private keys or API keys; typecheck and lint pass.
```

## 4. Marketplace: offers

```text
Build an "offers" panel for the 0xPixel NUSD marketplace (NusdNftMarketplaceV2) in my Next.js (App Router) + TypeScript app with viem + wagmi. Users make escrowed NUSD offers on any token of an allowed collection; owners accept them.

CHAIN
- defineChain id 4441, "LitVM LiteForge", zkLTC 18 decimals, RPC "https://liteforge.rpc.caldera.xyz/infra-partner-http" (fallback "https://liteforge.rpc.caldera.xyz/http"), Multicall3 0xca11bde05977b3631167028862be2a173976ca11 (from 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts).

ADDRESSES
- Copy 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json ("nusdMarketplace", "nusd", "pixelV1", "pixelV2") and 0xNothing-zkLTC-Testnet/apps/web/lib/nusdMarketplace.generated.json ("implementation") into config/0xnothing/. Assert chainId 4441 and matching addresses.

ABI (copy exactly; source 0xNothing-zkLTC-Testnet/contracts/src/0xpixel/NusdNftMarketplaceV2.sol)
- function IMPLEMENTATION_ID() view returns (bytes32)
- function nusd() view returns (address)
- function paused() view returns (bool)
- function collectionAllowed(address) view returns (bool)
- function credits(address) view returns (uint256)
- function offers(uint256) view returns (address collection, uint256 tokenId, address offerer, uint256 price, uint64 expiresAt, bool active)
- function getActiveOffers(uint256 offset, uint256 limit) view returns (uint256[])   (limit <= 100)
- function activeOfferCount() view returns (uint256)
- function quoteSale(address collection, uint256 tokenId, uint256 price) view returns (uint256 burnAmount, address creator, uint256 creatorFee, uint256 sellerProceeds)
- function makeOffer(address collection, uint256 tokenId, uint256 price, uint64 expiresAt, uint256 maxWalletPayment) returns (uint256)
- function acceptOffer(uint256 offerId, uint256 minimumSellerProceeds)
- function cancelOffer(uint256 offerId)
- function expireOffer(uint256 offerId)
- event OfferCreated(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address offerer, uint256 price, uint64 expiresAt)
- event OfferCancelled(uint256 indexed offerId, address indexed offerer, uint256 refund)
- event OfferAccepted(uint256 indexed offerId, address indexed seller, address indexed buyer, uint256 price)
- errors: InvalidConfiguration(), CollectionNotAllowed(), InvalidPrice(), InvalidExpiry(), Inactive(), Unauthorized(), NotPurchasable(), AlreadyListed(), PriceChanged(), NonExactTransfer(), NothingToWithdraw(), InvalidPage(), InsufficientProceeds(), WalletPaymentExceeded(), EnforcedPause(), ReentrancyGuardReentrantCall()
ERC-20 (NUSD): balanceOf, allowance, approve. ERC-721: ownerOf, getApproved, isApprovedForAll, approve.

GUARDS FOR EVERY WRITE
- chainId === 4441; fresh nusd()/IMPLEMENTATION_ID() identity check against the manifests; paused() false for makeOffer/acceptOffer (cancel/expire still allowed while paused); simulateContract with exact account and no value field (nonpayable, 0 zkLTC); writeContract; waitForTransactionReceipt and require status === "success"; decode reverts.

FLOW: make offer
1. Inputs: collection (select V2 / Classic), token id (bigint), price (parseUnits 18, 0 < price <= 2^128-1), duration in hours (1-720).
2. Read collectionAllowed(collection) and ownerOf(tokenId) (revert = token does not exist; owner === user = cannot offer on your own token).
3. expiresAt = latest block timestamp + hours * 3600n (bigint, uint64). Max 30 days.
4. walletPayment = price - min(credits(user), price). Check NUSD balance.
5. Allowance branch: approve(market, walletPayment) exactly, only if allowance < walletPayment; wait for receipt.
6. makeOffer(collection, tokenId, price, expiresAt, walletPayment). Read offerId from OfferCreated.
Explain in the UI that the full price is escrowed and refunds go to market credits, not the wallet.

FLOW: accept offer (token owner)
1. Re-read offers(id): active, latest block timestamp < expiresAt, offerer !== user, ownerOf(tokenId) === user.
2. minimumSellerProceeds = quoteSale(collection, tokenId, price).sellerProceeds read right before signing (slippage guard; InsufficientProceeds => re-quote).
3. NFT approval branch: if neither isApprovedForAll(user, market) nor getApproved(tokenId) === market, approve(market, tokenId) and wait.
4. acceptOffer(id, minimumSellerProceeds). Note: this also cancels the token's active listing.

FLOW: cancel / expire
- cancelOffer(id): offerer only.
- expireOffer(id): anyone, only when block timestamp >= expiresAt; refund goes to the offerer's credits. Show an "Expire" button on expired offers that are still active.

UI STATES
- Offers on a token, my offers, offers on my tokens; countdown to expiry; expired-but-active badge.
- Per action: wrong network, paused, checking, needs NUSD approval, needs NFT approval, approving, simulating, awaiting signature, pending (explorer link), success, failed (decoded error), user rejected.
- Show quoteSale breakdown (0.1% burn, 0.4% creator, seller net) before accept.

ACCEPTANCE CHECKLIST
- [ ] Addresses from the copied manifests; identity check before writes.
- [ ] expiresAt from chain time, not Date.now(); validated 1-720 hours.
- [ ] maxWalletPayment = exact wallet shortfall; minimumSellerProceeds from a fresh quoteSale.
- [ ] Allowance and NFT approval branches run only when needed, and wait for their receipts.
- [ ] Every write: chain check, simulate, write, receipt status check.
- [ ] All bigint; no secrets; typecheck and lint pass.
```

## 5. Credits and activity feed

```text
Build a "NUSD credits and market activity" section for the 0xPixel NUSD marketplace in my Next.js (App Router) + TypeScript app with viem + wagmi. It shows the user's withdrawable market credits with a Withdraw button, and a public activity feed from the Goldsky subgraph.

CHAIN
- defineChain id 4441, "LitVM LiteForge", zkLTC 18 decimals, RPC "https://liteforge.rpc.caldera.xyz/infra-partner-http" (fallback "https://liteforge.rpc.caldera.xyz/http") (from 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts).

ADDRESSES AND ENDPOINT
- Market and NUSD: copy 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json ("nusdMarketplace", "nusd") and 0xNothing-zkLTC-Testnet/apps/web/lib/nusdMarketplace.generated.json ("implementation") into config/0xnothing/.
- Subgraph URL: copy the value of "nusdMarketGoldskyEndpoint" from 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json (it is the public Goldsky endpoint for pixel-nusd-market/1.1.0). Do not call the 0xNothing web app's own HTTP routes; they are internal, not a public API.

ABI (copy exactly; source 0xNothing-zkLTC-Testnet/contracts/src/0xpixel/NusdNftMarketplaceV2.sol)
- function IMPLEMENTATION_ID() view returns (bytes32)
- function nusd() view returns (address)
- function credits(address) view returns (uint256)
- function withdrawNusd(address recipient)
- event NusdWithdrawn(address indexed account, address indexed recipient, uint256 amount)
- errors: InvalidConfiguration(), NothingToWithdraw(), NonExactTransfer(), ReentrancyGuardReentrantCall()

CREDITS FLOW
1. Read credits(user) over RPC; show formatUnits(credits, 18) NUSD. Explain: sale proceeds, creator fees and offer refunds land here, not in the wallet; buys and offers spend credits first.
2. Withdraw: chainId === 4441; identity check (nusd(), IMPLEMENTATION_ID() match the manifests); re-read credits (0 => disable, "Nothing to withdraw"); recipient = connected address (never zero, never the market); simulateContract withdrawNusd(recipient) with the exact account and no value field (nonpayable, 0 zkLTC); writeContract; waitForTransactionReceipt; require status === "success"; read the amount from NusdWithdrawn. Withdraw works even while the market is paused. No approval is needed.

ACTIVITY FEED (subgraph, read-only)
- POST GraphQL to the subgraph URL. Example:
  query Feed($first: Int!, $skip: Int!) {
    nusdMarketStats(id: "global") { listings sales volume offers burned }
    nusdActivities(orderBy: sortKey, orderDirection: desc, first: $first, skip: $skip) {
      id type collection tokenId actor other price timestamp transactionHash
    }
  }
- type is one of MINTED, LISTED, UPDATED, BOUGHT, CANCELLED, OFFER_CREATED, OFFER_REFUNDED. For BOUGHT, actor = seller and other = buyer (covers both purchases and accepted offers).
- BigInt fields are decimal strings: convert with BigInt(); prices via formatUnits(x, 18); timestamp is unix seconds.
- History starts at block 61141428; say "activity since the marketplace launch".
- Check the response for "errors" and HTTP status; show a retry state. Never use subgraph data to decide whether a transaction is safe — re-read on RPC before any write.

UI STATES
- Credits: not connected, wrong network, loading, zero, positive, withdrawing (simulating / awaiting signature / pending with explorer link), success, failed (decoded error), user rejected.
- Feed: loading, empty, list with pagination ("Load more"), subgraph error with retry. Market totals (sales, volume, burned) at the top.

ACCEPTANCE CHECKLIST
- [ ] Addresses and subgraph URL come from the copied manifest files.
- [ ] No calls to the 0xNothing web app's own HTTP routes or WebSocket plumbing; only RPC and the subgraph.
- [ ] Withdraw: chain check, fresh credits read, simulate, write, receipt status check.
- [ ] BigInt parsing for all numeric subgraph fields; no Number() on amounts.
- [ ] Subgraph is display-only; no write depends on it.
- [ ] No private keys or API keys; typecheck and lint pass.
```
