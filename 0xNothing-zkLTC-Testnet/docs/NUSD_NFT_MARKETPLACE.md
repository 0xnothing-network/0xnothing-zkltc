# NUSD utility for 0xPixel

## Status and separation

`contracts/src/0xpixel/NusdNftMarketplace.sol` is a new, non-upgradeable ERC-721 marketplace. It settles in the LiteForge `4441` NUSD from PR #6, `0x677D63c78E77E0b1971530e1494Caee4Bd7d631e`. The implementation marker is `0xpixel.nusd.marketplace.v2`. This branch does **not** broadcast a deployment.

The earlier v1 market at `0x188eACB8e05691aD5Ca6b31703DA97B13b2cf377` settled the pre-PR#6 NUSD `0x5317e21aba902c6c7087a84457bc02fFe99604d1`. That receipt is kept as `deployments/liteforge-testnet/nusd-marketplace.v1-superseded-nusd.json` and is not the live NUSD marketplace. After you deploy v2, write the confirmed public record to `deployments/liteforge-testnet/nusd-marketplace.json` and `apps/web/lib/nusdMarketplace.generated.json`. Until then the generated file has a null address, so the UI and APIs stay explicitly unconfigured (`NUSD marketplace not deployed / configured`) unless `NEXT_PUBLIC_PIXEL_NUSD_MARKETPLACE_ADDRESS` is a valid nonzero override.

`/0xpixel/marketplace` renders the NUSD dashboard. `/0xpixel/marketplace/nusd` redirects to that route. Gallery's sell action opens the NUSD form with the selected NFT. The immutable platform fee is 40 bps (0.4%). The Node deploy tool reads the supplied root `.env.local` in memory only; no private key is logged, copied into public configuration, or modified.

The former native-zkLTC trading UI and Gallery signer controls are removed. Old `/0xpixel/marketplace/legacy` bookmarks redirect to the NUSD marketplace. The legacy native marketplace at `0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4` remains onchain; its listings, offers and balances are not moved, re-priced or relabelled. Users with assets in that contract need to interact with its original ABI independently. The V1 index is retained only for NFT discovery and metadata. Gallery discards indexed native listings and attaches listings verified against the NUSD contract at a pinned block.

The English-only interface preserves collection-aware artwork, search by name/token/address, price sorting, wallet filters, pagination, listing, purchase, price edits, cancellation, offers and transaction history. Up to 1,000 active listings form a pinned catalogue; larger markets use page-local filtering. Metadata batches contain at most 20 tokens with four concurrent requests. The activity feed reads NUSD events and Pixel NFT mints since the configured market launch (block 0 until a confirmed record is published), never native sales. Both `/api/marketplace/listings` and `/api/marketplace/activity` serve only the NUSD market.

Settlement uses the same 18-decimal NUSD as the PR #6 0xFi / Pump redeploy: `0x677D63c78E77E0b1971530e1494Caee4Bd7d631e`, on LiteForge chain `4441`. zkLTC is only the network gas asset. NUSD is a testnet token, not a guarantee of a $1 exchange value or external redemption.

## Three useful flows

1. **Buy and sell NFTs in NUSD.** The seller keeps the NFT until purchase. Listing and `buy` require a **token-level** `approve` of that NFT to the market. Operator approval (`setApprovalForAll`) is not enough to list or keep a listing live. ERC-721 clears the token approval on every transfer, so a listing cannot silently become purchasable again at its old price when the NFT later returns to the seller. The buyer approves only the wallet NUSD shortfall and calls `buy(listingId, expectedPrice, maxWalletPayment)`. Changed prices or a missing token-level NFT approval revert without spending payment. The UI approves one NFT when necessary, never `setApprovalForAll`.
2. **Escrow NUSD offers.** `makeOffer` locks the complete price for 1–720 hours. The current NFT owner can accept before expiry with an explicit minimum net proceeds. Accepting an offer still allows operator approval, because the seller is the caller. The maker can cancel at any time; anyone can trigger expiry. Refunds always belong to the maker, never the expiry caller.
3. **Recycle sale proceeds and refunds.** Seller proceeds, creator royalties, platform fees and cancelled/expired offer deposits become withdrawable NUSD credits. Credits are used before wallet tokens. If credits cover the full price, no ERC-20 approval is needed. `maxWalletPayment` prevents a changed credit balance from unexpectedly increasing wallet spending.

Credits are not automatically staked, lent, rewarded, or invested. Users withdraw their entire credit to a chosen nonzero recipient with `withdrawNusd`. The UI withdraws to the connected wallet.

## Accounting, royalties and permissions

- `nusd.balanceOf(marketplace) >= escrowedNusd + totalCreditsNusd`. Without unsolicited donations, the amounts are equal. Deposits and withdrawals require exact token transfers; fee-on-transfer NUSD is rejected.
- Sale proceeds plus platform fee plus royalty exactly equal the price. Overlapping recipients accumulate credit without double counting.
- The deployment script uses an immutable 40 bps platform fee (0.4%) and an explicitly configured treasury. The constructor caps fees at 500 bps (5%); no owner can change fees or treasury after deployment.
- ERC-2981 royalties above **10% of the sale price** (`MAX_ROYALTY_BPS = 1000`) revert. `buy` has no seller-side minimum-proceeds argument, so this cap is what stops a collection from raising its royalty after listing and taking almost the entire sale. Invalid or market-address royalty recipients also revert instead of skipping creator payment.
- Collections are owner-allowlisted and must implement ERC-721/ERC-165. Royalties are computed on the sale price and credited in NUSD, as required by [ERC-2981](https://eips.ethereum.org/EIPS/eip-2981).
- The owner can allow/disable collections, pause trading and transfer ownership through a two-step process. Cancellation, offer expiry and NUSD withdrawals remain available during pause or collection disablement. There is no owner withdrawal of user balances, mint authority, token rescue or arbitrary call function.
- Credits belong to the credited address. A smart-contract seller, royalty receiver or treasury must be able to call `withdrawNusd` or market actions itself.
- All financial actions have reentrancy protection and use [OpenZeppelin SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20). A failed NFT receiver reverts the complete sale.
- Active-listing/offer insertion and removal are O(1). Reads use offset/limit, capped at 100 contract-side and 24 UI-side. Concurrent changes can move entries between pages; refresh before signing.
- Frontend reads pin to a mined block and validate chain, immutable token and the v2 implementation marker. Signing is blocked on stale reads, pause or wallet/account/connector changes. The marker is a compatibility check, not cryptographic authentication of the code.
- Transactions use the existing confirmed-receipt flow, exact approvals and simulation. No automatic transaction retries.

## Deployment preparation

Do **not** broadcast from this PR. From `0xFi/`, `node scripts/deploy-nusd-marketplace.mjs` simulates first; `--broadcast` is an explicit operator action after you have reviewed bytecode, owner, treasury, NUSD `0x677D…631e`, both Pixel collections, and the v2 marker. Transaction hashes and public nonce/gas parameters are recorded before sending. An interrupted prepared transaction requires explicit `--submit-prepared`; `--replace-underpriced` only changes gas price after checking that the original transaction is not known and the nonce is unchanged.

Run from `contracts/` with Foundry installed:

```powershell
forge test --match-contract NusdNftMarketplaceTest -vv
forge build --sizes --skip DeployTestnet
$env:PIXEL_NUSD_MARKET_OWNER = '<reviewed owner address>'
$env:PIXEL_NUSD_MARKET_TREASURY = '<reviewed treasury address>'
$env:LITVM_RPC_URL = 'https://liteforge.rpc.caldera.xyz/infra-partner-http'
forge script script/DeployNusdMarketplace.s.sol:DeployNusdMarketplace --rpc-url $env:LITVM_RPC_URL
```

The last command is a dry run without `--broadcast`. The script pins the PR #6 NUSD, 0xPixel V1/V2 collections and a 40 bps fee; it refuses other chains. Use an encrypted keystore via Foundry's `--account` when you later deploy; never put keys in public environment variables, logs, command history or frontend files.

After a separately authorized, confirmed deployment:

1. Verify contract source and constructor inputs; confirm chain `4441`, `nusd() == 0x677D…631e`, `IMPLEMENTATION_ID()` is the v2 marker, owner, treasury, `platformFeeBps()`, and `collectionAllowed()` for both collections. Do not configure a predicted dry-run address.
2. Publish the confirmed public deployment metadata into `deployments/liteforge-testnet/nusd-marketplace.json` and `apps/web/lib/nusdMarketplace.generated.json`, then restart/rebuild Next.js. `NEXT_PUBLIC_PIXEL_NUSD_MARKETPLACE_ADDRESS=<confirmed address>` is an optional public override; empty values use the versioned deployment, while invalid/zero nonempty values disable trading. Do not replace the legacy native marketplace address in native ABIs.
3. Smoke-test with small testnet amounts and two controlled wallets: list (token approve only), edit price, cancel, buy, creator credit, withdraw, offer, cancel, re-use refund, accept and expiry. Confirm both NFT collection generations and Gallery deep links work. Exercise pause while checking cancellation/refunds/withdrawals remain available.
4. The main UI reads directly from RPC and the owned-NFT API; activity uses the NUSD-only API. The old subgraph does not index the new contract.

## Validation and limits

The contract suite covers NUSD accounting, 512-run price/refund/royalty-cap/fee-split fuzz tests, 24-step randomized refund/reuse sequences, real 0xPixel V2 royalties and inventory, stale listings, token-level listing approval (including NFT leave-and-return), exact transfer enforcement, credit races, cancel/relist/buy and offer/listing races, minimum proceeds, pause, pagination and callback reentrancy/atomic failure. Frontend tests cover strict amounts, bounded pinned reads, pending vs confirmed deployment gating, funding shortfalls, wallet changes, NFT approvals, offer acceptance, paused withdrawals/refunds and duplicate-click locking. These tests are not a third-party audit or live deployment validation.

This version does not add ERC-1155, auctions, lending against NFTs, bridging, automatic staking, speculative volume rewards, off-chain credit or automatic cross-market listing migration.
