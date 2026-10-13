// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { TestBase } from "../TestBase.sol";
import { NusdNftMarketplace } from "../../src/0xpixel/NusdNftMarketplace.sol";

/// Operator smoke test of the DEPLOYED NUSD marketplace on a local LiteForge fork.
/// Runs only when LITVM_RPC_URL is set; nothing is broadcast. Exercises every
/// flow in docs/NUSD_NFT_MARKETPLACE.md (list, edit, cancel, buy, royalty and fee
/// credits, withdraw, offer, cancel, credit reuse, accept, expiry, pause) with
/// impersonated wallets against the real NUSD token and both 0xPixel collections.
contract NusdMarketplaceSmokeForkTest is TestBase {
    NusdNftMarketplace private constant MARKET = NusdNftMarketplace(0x188eACB8e05691aD5Ca6b31703DA97B13b2cf377);
    IERC20 private constant NUSD = IERC20(0x5317e21aba902c6c7087a84457bc02fFe99604d1);
    address private constant PIXEL_V1 = 0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988;
    address private constant PIXEL_V2 = 0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB;
    address private constant OWNER = 0x58633401dCc383F010688e950878000000000000;
    // 0xFi contracts holding NUSD; impersonated only inside the local fork to fund test wallets.
    address private constant LENDING_POOL = 0x7CB638F8e10f1bd200A3c5C3fD014C3FD97BA914;
    address private constant WZKLTC_NUSD_PAIR = 0x8dd79c3966c8392b08b609FAEce029c3329f9E9E;

    address private constant BUYER = address(0xB0B5);
    address private constant BIDDER = address(0xB1D);

    function _fork() private returns (bool) {
        string memory rpcUrl = vm.envOr("LITVM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return false;
        vm.createSelectFork(rpcUrl);
        return true;
    }

    function _fund(address account, uint256 amount) private {
        address source = NUSD.balanceOf(LENDING_POOL) >= amount ? LENDING_POOL : WZKLTC_NUSD_PAIR;
        assertGe(NUSD.balanceOf(source), amount, "no NUSD source on fork");
        vm.prank(source);
        NUSD.transfer(account, amount);
        vm.deal(account, 1 ether);
    }

    /// First token in [1, 400] held by an EOA and not already listed on the NUSD market.
    function _unlistedEoaToken(address collection, address exclude) private view returns (uint256 tokenId, address holder) {
        for (uint256 id = 1; id <= 400; id++) {
            try IERC721(collection).ownerOf(id) returns (address owner) {
                if (owner.code.length == 0 && owner != exclude && MARKET.tokenToListingId(collection, id) == 0) return (id, owner);
            } catch {}
        }
        revert("no EOA-held token found");
    }

    function _solvent() private view {
        assertGe(NUSD.balanceOf(address(MARKET)), MARKET.escrowedNusd() + MARKET.totalCreditsNusd(), "market insolvent");
    }

    function testForkDeployedIdentity() public {
        if (!_fork()) return;
        assertEq(MARKET.IMPLEMENTATION_ID(), keccak256("0xpixel.nusd.marketplace.v1"), "implementation");
        assertEq(address(MARKET.nusd()), address(NUSD), "nusd");
        assertEq(uint256(MARKET.platformFeeBps()), 40, "fee");
        assertEq(MARKET.feeRecipient(), OWNER, "treasury");
        assertEq(MARKET.owner(), OWNER, "owner");
        assertTrue(MARKET.collectionAllowed(PIXEL_V1) && MARKET.collectionAllowed(PIXEL_V2), "collections");
        _solvent();
    }

    function testForkListEditCancelBuyWithdraw() public {
        if (!_fork()) return;
        (uint256 tokenId, address seller) = _unlistedEoaToken(PIXEL_V2, address(0));
        vm.startPrank(seller);
        IERC721(PIXEL_V2).approve(address(MARKET), tokenId);
        uint256 first = MARKET.list(PIXEL_V2, tokenId, 10 ether);
        MARKET.updateListingPrice(first, 12 ether);
        MARKET.cancelListing(first);
        uint256 listingId = MARKET.list(PIXEL_V2, tokenId, 12 ether);
        vm.stopPrank();

        (uint256 fee, address royaltyReceiver, uint256 royalty, uint256 proceeds) = MARKET.quoteSale(PIXEL_V2, tokenId, 12 ether);
        assertEq(fee + royalty + proceeds, 12 ether, "quote sums to price");
        uint256 sellerCredit = MARKET.credits(seller);
        uint256 treasuryCredit = MARKET.credits(OWNER);
        uint256 royaltyCredit = royaltyReceiver == address(0) ? 0 : MARKET.credits(royaltyReceiver);

        _fund(BUYER, 12 ether);
        vm.startPrank(BUYER);
        NUSD.approve(address(MARKET), 12 ether);
        vm.expectRevert(NusdNftMarketplace.PriceChanged.selector);
        MARKET.buy(listingId, 11 ether, 12 ether);
        MARKET.buy(listingId, 12 ether, 12 ether);
        vm.stopPrank();
        assertEq(IERC721(PIXEL_V2).ownerOf(tokenId), BUYER, "nft delivered");
        assertEq(NUSD.balanceOf(BUYER), 0, "buyer paid exactly the price");

        // Overlapping recipients (seller == royalty receiver or treasury) accumulate without double counting.
        uint256 credited = MARKET.credits(seller) - sellerCredit;
        if (seller != OWNER) credited += MARKET.credits(OWNER) - treasuryCredit;
        if (royaltyReceiver != address(0) && royaltyReceiver != seller && royaltyReceiver != OWNER) credited += MARKET.credits(royaltyReceiver) - royaltyCredit;
        assertEq(credited, 12 ether, "all proceeds credited");
        _solvent();

        uint256 before = NUSD.balanceOf(seller);
        uint256 owed = MARKET.credits(seller);
        vm.prank(seller);
        MARKET.withdrawNusd(seller);
        assertEq(NUSD.balanceOf(seller) - before, owed, "withdrawal pays the full credit");
        assertEq(MARKET.credits(seller), 0, "credit cleared");
        _solvent();
    }

    function testForkOffersRefundReuseAcceptAndExpire() public {
        if (!_fork()) return;
        (uint256 tokenId, address holder) = _unlistedEoaToken(PIXEL_V1, address(0));
        _fund(BIDDER, 5 ether);
        vm.startPrank(BIDDER);
        NUSD.approve(address(MARKET), 5 ether);
        uint256 cancelled = MARKET.makeOffer(PIXEL_V1, tokenId, 5 ether, uint64(block.timestamp + 1 hours), 5 ether);
        MARKET.cancelOffer(cancelled);
        assertEq(MARKET.credits(BIDDER), 5 ether, "refund becomes credit");
        // Credit-funded offer: no wallet NUSD and no allowance are needed.
        NUSD.approve(address(MARKET), 0);
        uint256 offerId = MARKET.makeOffer(PIXEL_V1, tokenId, 5 ether, uint64(block.timestamp + 1 hours), 0);
        vm.stopPrank();
        assertEq(MARKET.credits(BIDDER), 0, "credit reused");
        _solvent();

        (,,, uint256 proceeds) = MARKET.quoteSale(PIXEL_V1, tokenId, 5 ether);
        vm.startPrank(holder);
        IERC721(PIXEL_V1).approve(address(MARKET), tokenId);
        vm.expectRevert(NusdNftMarketplace.InsufficientProceeds.selector);
        MARKET.acceptOffer(offerId, proceeds + 1);
        MARKET.acceptOffer(offerId, proceeds);
        vm.stopPrank();
        assertEq(IERC721(PIXEL_V1).ownerOf(tokenId), BIDDER, "offer settled");
        _solvent();

        // Expiry: anyone can trigger it, but the refund belongs to the offerer.
        _fund(BUYER, 2 ether);
        vm.startPrank(BUYER);
        NUSD.approve(address(MARKET), 2 ether);
        uint256 expiring = MARKET.makeOffer(PIXEL_V1, tokenId, 2 ether, uint64(block.timestamp + 1 hours), 2 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(address(0xD00D));
        MARKET.expireOffer(expiring);
        assertEq(MARKET.credits(BUYER), 2 ether, "expired refund credited to the offerer");
        assertEq(MARKET.credits(address(0xD00D)), 0, "caller gains nothing");
        _solvent();
    }

    function testForkPauseKeepsExitsOpen() public {
        if (!_fork()) return;
        (uint256 tokenId, address seller) = _unlistedEoaToken(PIXEL_V2, address(0));
        vm.startPrank(seller);
        IERC721(PIXEL_V2).approve(address(MARKET), tokenId);
        uint256 listingId = MARKET.list(PIXEL_V2, tokenId, 3 ether);
        vm.stopPrank();
        _fund(BIDDER, 1 ether);
        vm.startPrank(BIDDER);
        NUSD.approve(address(MARKET), 1 ether);
        uint256 offerId = MARKET.makeOffer(PIXEL_V2, tokenId, 1 ether, uint64(block.timestamp + 1 hours), 1 ether);
        vm.stopPrank();

        vm.prank(OWNER);
        MARKET.pause();
        _fund(BUYER, 3 ether);
        vm.startPrank(BUYER);
        NUSD.approve(address(MARKET), 3 ether);
        vm.expectRevert();
        MARKET.buy(listingId, 3 ether, 3 ether);
        vm.stopPrank();
        vm.prank(seller);
        MARKET.cancelListing(listingId);
        vm.startPrank(BIDDER);
        MARKET.cancelOffer(offerId);
        MARKET.withdrawNusd(BIDDER);
        vm.stopPrank();
        assertEq(NUSD.balanceOf(BIDDER), 1 ether, "refund withdrawn while paused");
        vm.prank(OWNER);
        MARKET.unpause();
        _solvent();
    }
}
