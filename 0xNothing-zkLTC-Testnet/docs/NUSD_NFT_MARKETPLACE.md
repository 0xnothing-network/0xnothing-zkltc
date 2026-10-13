# NUSD utility for 0xPixel

## Status and separation

`contracts/src/0xpixel/NusdNftMarketplace.sol` is a new, non-upgradeable ERC-721 marketplace. It is deployed on LiteForge `4441` at `0x188eACB8e05691aD5Ca6b31703DA97B13b2cf377`, in block `57196199`, transaction `0x91cc4213eac712015ff6f1410c944ca7aa0b22c2e2170f8d312db3a02911e4e1`. The deployment receipt, runtime bytecode against the compiled artifact, NUSD, implementation marker, owner, treasury, fee and both collection allowlists were checked.

`/0xpixel/marketplace` now renders the NUSD dashboard by default. `/0xpixel/marketplace/nusd` redirects to the main route. Gallery's default sell action opens the NUSD form with the selected NFT. The generated public configuration in `apps/web/lib/nusdMarketplace.generated.json` activates the confirmed address without requiring a local environment override. Owner and fee recipient are the explicitly authorized deployment wallet; the immutable platform fee is 40 bps (0.4%). The deployment tooling reads the supplied root `.env.local` in memory only; no private key is logged, copied into public configuration, or modified.

The former trading UI and Gallery's native-token signer controls are removed. Old `/0xpixel/marketplace/legacy` bookmarks redirect to the NUSD marketplace. The deployed old contract remains onchain; its listings, offers and balances are not moved, re-priced or relabelled. Users with assets in that contract need to interact with its original ABI independently; the NUSD UI cannot recover or cancel them. The V1 index is retained only for NFT discovery and metadata. Gallery discards indexed native listings and attaches listings verified against the NUSD contract at a pinned block.

The English-only interface preserves collection-aware artwork, search by name/token/address, price sorting, wallet filters, pagination, listing, purchase, price edits, cancellation, offers and transaction history. Its compact layout keeps 0xPixel's dark/mint palette, Departure Mono typography and flat pixel surfaces. Up to 1,000 active listings form a pinned catalogue, with sorting and filtering before display pagination; larger markets use explicitly labelled page-local filtering to keep RPC work bounded. Metadata batches contain at most 20 tokens with four concurrent requests. The activity feed reads NUSD events and Pixel NFT mints since the NUSD market launch, never native sales, using bounded log windows and block/log-index cursors. Both `/api/marketplace/listings` and `/api/marketplace/activity` now serve only the NUSD market and reject incorrect identities instead of falling back to old prices.

Settlement uses the same 18-decimal NUSD as 0xFi and Pump: `0x5317e21aba902c6c7087a84457bc02fFe99604d1`, on LiteForge chain `4441`. zkLTC is only the network gas asset. NUSD is a testnet token, not a guarantee of a $1 exchange value or external redemption.

## Three useful flows

1. **Buy and sell NFTs in NUSD.** The seller keeps the NFT until purchase. The buyer approves only the wallet shortfall and calls `buy(listingId, expectedPrice, maxWalletPayment)`. Changed prices or insufficient NFT approval revert without spending payment. The UI approves one NFT when necessary, not the entire collection.
2. **Escrow NUSD offers.** `makeOffer` locks the complete price for 1–720 hours. The current NFT owner can accept before expiry with an explicit minimum net proceeds. The maker can cancel at any time; anyone can trigger expiry. Refunds always belong to the maker, never the expiry caller. Offers can be made on any enabled existing NFT through the contract; the UI selects from the loaded listing catalogue.
3. **Recycle sale proceeds and refunds.** Seller proceeds, creator royalties, platform fees and cancelled/expired offer deposits become withdrawable NUSD credits. Credits are used before wallet tokens for purchases and offers. A user receiving 100 NUSD can spend it again without a withdraw/deposit round trip. If credits cover the full price, no ERC-20 approval is needed. `maxWalletPayment` prevents a changed credit balance from unexpectedly increasing wallet spending.

Credits are not automatically staked, lent, rewarded, or invested. Users can withdraw their entire credit to a chosen nonzero recipient with `withdrawNusd`. The UI withdraws to the connected wallet. Escrow only moves to a recipient's credit after sale or refund; it is not available for unrelated spending.

## Accounting, royalties and permissions

- `nusd.balanceOf(marketplace) >= escrowedNusd + totalCreditsNusd`. Without unsolicited donations, the amounts are equal. Deposits and withdrawals require exact token transfers; fee-on-transfer NUSD is rejected.
- Sale proceeds plus platform fee plus royalty exactly equal the price. Overlapping recipients accumulate credit without double counting.
- The deployment script uses an immutable 40 bps platform fee (0.4%) and explicitly configured treasury. The contract constructor caps fees at 500 bps (5%); no owner can change fees or treasury after deployment.
- Collections are owner-allowlisted and must implement ERC-721/ERC-165. Supported ERC-2981 royalty failures or excessive/invalid recipients revert instead of silently skipping creator payment. Royalties are computed on the sale price and credited in NUSD, the same settlement currency, as required by [ERC-2981](https://eips.ethereum.org/EIPS/eip-2981).
- The owner can allow/disable collections, pause trading and transfer ownership through a two-step process. Cancellation, offer expiry and NUSD withdrawals remain available during pause or collection disablement. There is no owner withdrawal of user balances, mint authority, token rescue or arbitrary call function.
- Credits belong to the credited address. A smart-contract seller, royalty receiver or treasury must be able to call `withdrawNusd` or market actions itself; an ERC-20-only payment splitter without arbitrary execution cannot claim these pull-payment credits. Review royalty recipients before allowing collections; use an executable treasury wallet. There is no permissionless forced withdrawal that could disrupt another user's planned credit-funded purchase.
- All financial actions have reentrancy protection and use [OpenZeppelin SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20). A failed NFT receiver reverts the complete sale.
- Active-listing/offer insertion and removal are O(1). Reads use offset/limit, capped at 100 contract-side and 24 UI-side. Pagination does not scan historical IDs. Concurrent changes can move entries between pages; refresh before signing.
- Frontend reads pin to a mined block and validate chain, immutable token and implementation marker. Signing is blocked on stale reads, pause or wallet/account/connector changes. The marker is a compatibility check, not cryptographic authentication of the code: configure only an independently verified deployment.
- Transactions use the existing confirmed-receipt flow, exact approvals and simulation. No automatic transaction retries. A replaced/cancelled transaction is not reported as a successful NFT trade.

## Deployment preparation

The approved deployment is already recorded in `deployments/liteforge-testnet/nusd-marketplace.json`. From `0xFi/`, `node scripts/deploy-nusd-marketplace.mjs` now verifies that existing receipt and code without broadcasting a second deployment. For an undeployed environment it simulates first; `--broadcast` explicitly authorizes submission. Transaction hashes and public nonce/gas parameters are recorded before sending. An interrupted prepared transaction requires explicit `--submit-prepared`; `--replace-underpriced` only changes gas price after checking that the original transaction is not known and the nonce is unchanged. It reconstructs and verifies the original signed hash before replacing its preparation. These flags are operator recovery actions, not automatic retries. Neither the deployment record nor generated web configuration contains a private key.

Run from `contracts/` in PowerShell with Foundry installed:

```powershell
forge test --match-contract NusdNftMarketplaceTest -vv
forge build --sizes --skip DeployTestnet
$env:PIXEL_NUSD_MARKET_OWNER = '<reviewed owner address>'
$env:PIXEL_NUSD_MARKET_TREASURY = '<reviewed treasury address>'
$env:LITVM_RPC_URL = 'https://liteforge.rpc.caldera.xyz/infra-partner-http'
forge script script/DeployNusdMarketplace.s.sol:DeployNusdMarketplace --rpc-url $env:LITVM_RPC_URL
```

The last command is a dry run without `--broadcast`. The script pins the current canonical NUSD, 0xPixel V1/V2 collections and fee; it refuses other chains. It uses Foundry's configured sender, not a private-key value embedded in source. Review bytecode, ownership, treasury, allowed collections, deployment simulation, and the NUSD/royalty interfaces before authorizing any broadcast. Use an encrypted keystore via Foundry's `--account` when subsequently deploying; never put keys in public environment variables, logs, command history or frontend files.

After a separately authorized, confirmed deployment:

1. Verify contract source and constructor inputs; confirm chain `4441`, `nusd()`, `IMPLEMENTATION_ID()`, owner, treasury, `platformFeeBps()`, and `collectionAllowed()` for both collections. Do not configure a predicted dry-run address.
2. Publish the confirmed public deployment metadata into `apps/web/lib/nusdMarketplace.generated.json`, then restart/rebuild Next.js. The existing confirmed metadata is already configured. `NEXT_PUBLIC_PIXEL_NUSD_MARKETPLACE_ADDRESS=<confirmed address>` is an optional public override; empty values use the versioned deployment, while invalid/zero nonempty values disable trading. Do not replace the legacy contract address in native ABIs or APIs.
3. Smoke-test with small testnet amounts and two controlled wallets: list, edit price, cancel, buy, creator credit, withdraw, offer, cancel, re-use refund, accept and expiry. Confirm both NFT collection generations and Gallery deep links work. Exercise pause while checking cancellation/refunds/withdrawals remain available. These are operator actions, not transactions automatically broadcast by a UI redesign.
4. The main UI reads directly from RPC and the existing owned-NFT API; activity uses the new NUSD-only API. The old subgraph does not index the new contract. `subgraphs/0xpixel-nusd-market` is a separate NUSD-only indexer (listings, offers, activity and mints since block 57196199; never merged with native trades). After deploying it with `npm run deploy` there, set the server-only `PIXEL_NUSD_SUBGRAPH_URL`; `/api/marketplace/activity` then serves complete history from it and falls back to the bounded RPC scan when it is unset, more than 1,200 blocks behind, reports indexing errors or returns malformed data. Listing prices, credits and pre-signing checks stay on RPC. Deploying the onchain contract does not publish the web application to a remote host; publish the tested web changes through the normal hosting pipeline when ready.

## Validation and limits

The contract suite covers NUSD accounting, 512-run price/refund fuzz tests, 24-step randomized refund/reuse sequences, real 0xPixel V2 royalties and inventory, stale listings, exact transfer enforcement, credit races, minimum proceeds, pause, pagination and callback reentrancy/atomic failure. Frontend tests cover strict amounts, bounded pinned reads, deployment gating, funding shortfalls, wallet changes, NFT approvals, offer acceptance, paused withdrawals/refunds and duplicate-click locking. These tests are not a third-party audit or live deployment validation.

This version does not add ERC-1155, auctions, lending against NFTs, bridging, automatic staking, speculative volume rewards, off-chain credit or automatic cross-market listing migration. Those require separate economic/security review rather than coupling user escrow to new risks.
