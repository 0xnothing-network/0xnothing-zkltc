# NUSD marketplace — internal review (2026-10-13)

Scope: `contracts/src/0xpixel/NusdNftMarketplace.sol` as deployed at `0x188eACB8e05691aD5Ca6b31703DA97B13b2cf377` (LiteForge 4441), plus the retired native marketplace `0x13337cadA78d53C90E3c0EcE44C17c467C1a86F4`. This is an internal review by the development assistant, **not a third-party audit**. The deployed contract is immutable; findings below are mitigated off-chain or by operators, not by code changes.

## Verification performed

- Unit, fuzz and randomized suites: `forge test --match-contract NusdNftMarketplaceTest`.
- Fork smoke test against the deployed bytecode, real NUSD and both 0xPixel collections, nothing broadcast: `LITVM_RPC_URL=<rpc> forge test --match-contract NusdMarketplaceSmokeForkTest -vv` (identity, list/edit/cancel/buy, fee and royalty credits, withdraw, offer/cancel/credit reuse/accept, minimum proceeds, expiry by a third party, pause with exits open, solvency after every step).
- Manual read of every external function, accounting path and owner power.

## Properties confirmed

- Solvency: `balanceOf(market) >= escrowedNusd + totalCreditsNusd`; every sale credits exactly `price` (fee + royalty + proceeds), refunds move escrow to the offerer's credit, and transfers are balance-delta checked (fee-on-transfer NUSD reverts).
- Buyer protection: `expectedPrice` and `maxWalletPayment` bound what a pending purchase can cost; sellers accepting offers are protected by `minimumSellerProceeds` against royalty changes.
- Exits survive owner actions: `cancelListing`, `cancelOffer`, `expireOffer` and `withdrawNusd` work while paused or after a collection is disallowed. The owner cannot move user funds, change fees or the treasury.
- Every state-changing function is `nonReentrant`; the only external callbacks are the ERC-721 transfer to the buyer and view calls to allowed collections.

## Findings

| # | Severity | Finding | Mitigation |
| --- | --- | --- | --- |
| 1 | High (operational, old contract) | 566 of 567 listings on the **retired native marketplace** are still purchasable at old zkLTC prices (226 sellers, measured on-chain 2026-10-13); it is not paused, and settlement pulls the NFT from the seller's wallet while approval remains. | Gallery now shows each wallet its still-active old listings with a cancel action. The old contract's owner can `pause()` it to stop all purchases immediately; sellers can still revoke approval while paused (its `cancelListing` is `whenNotPaused`). |
| 2 | Medium | **Listing resurrection.** A listing stays `active` when the seller transfers the NFT away. If the seller later re-acquires it while an operator-wide approval (`setApprovalForAll`) is still set, the old listing becomes buyable again at its old price. | The web UI only grants single-token approvals, which ERC-721 clears on transfer. Anyone can call `invalidateListing` on a stale listing. Operators can invalidate stale listings periodically; a future version should key listings to an ownership nonce. |
| 3 | Low | Catalogue entries whose seller no longer owns or approves the NFT remain in `getActiveListings`; buying them reverts with `NotPurchasable` after simulation. | Pre-signing simulation stops the transaction; `invalidateListing` cleans them. |
| 4 | Low | Contract wallets without `onERC721Received` cannot receive NFTs; offers from them can never be accepted. Funds stay refundable through cancel or expiry. | Documented; no loss of funds. |
| 5 | Info | Owner and treasury are a single EOA. | Use a multisig before any mainnet deployment. |

No finding allows loss of escrowed NUSD or credits.

## Before mainnet

A third-party audit of a version addressing finding 2, a multisig owner/treasury, official network values (chain ID, RPC, explorer, NUSD/oracle, DEX), and a dry-run of the fork smoke test against the mainnet deployment.
