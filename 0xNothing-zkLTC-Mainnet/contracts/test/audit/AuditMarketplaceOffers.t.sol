// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NusdNftMarketplaceV2} from "../../src/0xpixel/NusdNftMarketplaceV2.sol";
import {ZeroXPixelV2} from "../../src/0xpixel/ZeroXPixelV2.sol";
import {MarketplaceBurnableNusdMock} from "../mocks/NusdMarketplaceMocks.sol";

/// Tests for finding R2-M-01 of the second review of the 2026-11 audit (docs/AUDIT_2026-11.md).
///
/// As reviewed, a bid was bound to nothing but its expiry. A bidder who then bought the same token
/// from its listing kept a live, escrowed bid on a token he now owned. When he resold below that
/// forgotten bid, the buyer put the token straight back to him at the bid, in one transaction and
/// without risk: buy at 450, accept at 500. An account now has at most one live bid on a token, and
/// a sale through the market ends the bid its buyer or its seller still had on that token (the
/// buyer's escrow pays for the purchase).
contract AuditMarketplaceOffersTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);
    address private constant MALLORY = address(0xBAD);

    MarketplaceBurnableNusdMock private nusd;
    ZeroXPixelV2 private pixel;
    NusdNftMarketplaceV2 private market;
    uint256 private id;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceBurnableNusdMock();
        pixel = new ZeroXPixelV2();
        address[] memory collections = new address[](1);
        collections[0] = address(pixel);
        market = new NusdNftMarketplaceV2(address(nusd), address(this), collections);
        address[3] memory buyers = [BOB, CAROL, MALLORY];
        for (uint256 i; i < buyers.length; ++i) {
            nusd.mint(buyers[i], 1_000 ether);
            vm.prank(buyers[i]);
            nusd.approve(address(market), type(uint256).max);
        }
        vm.prank(ALICE);
        id = pixel.mintPacked("art", "", 8, hex"000000ff0000");
    }

    function _bid(address bidder, uint256 price) private returns (uint256 offerId) {
        vm.prank(bidder);
        offerId = market.makeOffer(address(pixel), id, price, uint64(vm.getBlockTimestamp() + 30 days), price);
    }

    function _offerActive(uint256 offerId) private view returns (bool active) {
        (,,,,, active) = market.offers(offerId);
    }

    function _assertSolvent() private view {
        assertEq(nusd.balanceOf(address(market)), market.totalLiabilitiesNusd(), "the market holds exactly what it owes");
    }

    /// The scenario of the finding: bid, buy the listing instead, resell below the old bid.
    function testAudit_R2M01_buyingTheTokenRefundsTheBuyersOwnBid() public {
        vm.startPrank(ALICE);
        pixel.approve(address(market), id);
        uint256 aliceListing = market.list(address(pixel), id, 480 ether);
        vm.stopPrank();

        uint256 offerId = _bid(BOB, 500 ether);
        assertEq(market.offerIdOf(address(pixel), id, BOB), offerId, "his one bid on the token");
        vm.prank(BOB);
        market.buy(aliceListing, 480 ether, 480 ether);
        assertEq(pixel.ownerOf(id), BOB, "Bob owns the token he bid on");
        assertFalse(_offerActive(offerId), "and the purchase ended his bid on it");
        assertEq(market.offerIdOf(address(pixel), id, BOB), 0, "no bid left");
        assertEq(market.escrowedNusd(), 0, "nothing escrowed");
        assertEq(nusd.balanceOf(BOB), 500 ether, "the escrow of the bid paid for the purchase, not the wallet");
        assertEq(market.credits(BOB), 20 ether, "and the 20 it had over is credit");
        _assertSolvent();

        // He resells below the old bid. The buyer has nothing to put the token back into.
        vm.startPrank(BOB);
        pixel.approve(address(market), id);
        uint256 bobListing = market.list(address(pixel), id, 450 ether);
        vm.stopPrank();
        vm.startPrank(MALLORY);
        market.buy(bobListing, 450 ether, 450 ether);
        pixel.approve(address(market), id);
        vm.expectRevert(NusdNftMarketplaceV2.Inactive.selector);
        market.acceptOffer(offerId, 0);
        vm.stopPrank();
        assertEq(pixel.ownerOf(id), MALLORY, "an ordinary sale");
        assertEq(market.credits(BOB), 20 ether + 447.75 ether, "his 20, and 450 minus 0.5%");
        _assertSolvent();
    }

    /// The bidder gets the token outside the market, where the market cannot see it. His bid ends
    /// when he sells the token through a listing.
    function testAudit_R2M01_sellingTheTokenRefundsTheSellersOwnBid() public {
        uint256 offerId = _bid(BOB, 500 ether);
        vm.prank(ALICE);
        pixel.transferFrom(ALICE, BOB, id);
        assertTrue(_offerActive(offerId), "a plain transfer does not end the bid");

        vm.startPrank(BOB);
        pixel.approve(address(market), id);
        uint256 listingId = market.list(address(pixel), id, 450 ether);
        vm.stopPrank();
        vm.startPrank(MALLORY);
        market.buy(listingId, 450 ether, 450 ether);
        assertFalse(_offerActive(offerId), "the sale ended the seller's own bid");
        pixel.approve(address(market), id);
        vm.expectRevert(NusdNftMarketplaceV2.Inactive.selector);
        market.acceptOffer(offerId, 0);
        vm.stopPrank();
        assertEq(pixel.ownerOf(id), MALLORY, "an ordinary sale");
        assertEq(market.credits(BOB), 500 ether + 447.75 ether, "his refund, and 450 minus 0.5%");
        assertEq(market.escrowedNusd(), 0, "nothing escrowed");
        _assertSolvent();
    }

    /// The same when he sells into somebody else's bid.
    function testAudit_R2M01_acceptingABidRefundsTheSellersOwnBid() public {
        uint256 bobOffer = _bid(BOB, 500 ether);
        uint256 carolOffer = _bid(CAROL, 520 ether);
        vm.prank(ALICE);
        pixel.transferFrom(ALICE, BOB, id);

        vm.startPrank(BOB);
        pixel.approve(address(market), id);
        market.acceptOffer(carolOffer, 0);
        vm.stopPrank();
        assertEq(pixel.ownerOf(id), CAROL, "sold to Carol at 520");
        assertFalse(_offerActive(bobOffer), "his own bid ended with the sale");
        assertEq(market.offerIdOf(address(pixel), id, BOB), 0, "no bid of Bob's left");
        assertEq(market.offerIdOf(address(pixel), id, CAROL), 0, "nor of Carol's");
        assertEq(market.escrowedNusd(), 0, "nothing escrowed");
        assertEq(market.credits(BOB), 500 ether + 517.4 ether, "his refund, and 520 minus 0.5%");

        vm.startPrank(CAROL);
        pixel.approve(address(market), id);
        vm.expectRevert(NusdNftMarketplaceV2.Inactive.selector);
        market.acceptOffer(bobOffer, 0);
        vm.stopPrank();
        _assertSolvent();
    }

    /// One live bid per account and token: a new bid replaces the old one, and the old escrow pays
    /// for it before the wallet does.
    function testAudit_R2M01_aNewBidReplacesTheOldOne() public {
        uint256 first = _bid(BOB, 500 ether);
        vm.prank(BOB);
        uint256 second = market.makeOffer(address(pixel), id, 300 ether, uint64(vm.getBlockTimestamp() + 1 days), 0);
        assertFalse(_offerActive(first), "the first bid is gone");
        assertTrue(_offerActive(second), "the second stands");
        assertEq(market.offerIdOf(address(pixel), id, BOB), second, "one bid per token");
        assertEq(market.activeOfferCount(), 1, "one live offer");
        assertEq(market.escrowedNusd(), 300 ether, "the escrow follows the live bid");
        assertEq(market.credits(BOB), 200 ether, "the difference is credit");
        assertEq(nusd.balanceOf(BOB), 500 ether, "lowering a bid takes nothing from the wallet");
        _assertSolvent();

        vm.prank(BOB);
        uint256 third =
            market.makeOffer(address(pixel), id, 700 ether, uint64(vm.getBlockTimestamp() + 1 days), 200 ether);
        assertEq(market.offerIdOf(address(pixel), id, BOB), third, "the third is the live one");
        assertEq(market.escrowedNusd(), 700 ether, "escrow");
        assertEq(market.credits(BOB), 0, "raising it used the credit first");
        assertEq(nusd.balanceOf(BOB), 300 ether, "and 200 from the wallet");

        // Another account's bid on the same token is its own.
        uint256 carolOffer = _bid(CAROL, 100 ether);
        assertTrue(_offerActive(third), "Bob's bid stands");
        assertTrue(_offerActive(carolOffer), "next to Carol's");
        assertEq(market.activeOfferCount(), 2, "two bidders, two bids");

        vm.startPrank(ALICE);
        pixel.approve(address(market), id);
        vm.expectRevert(NusdNftMarketplaceV2.Inactive.selector);
        market.acceptOffer(first, 0);
        market.acceptOffer(third, 0);
        vm.stopPrank();
        assertEq(pixel.ownerOf(id), BOB, "sold at 700");
        assertEq(market.offerIdOf(address(pixel), id, BOB), 0, "nothing left of his");
        assertTrue(_offerActive(carolOffer), "Carol's bid on his token stands, as it should");
        _assertSolvent();
    }

    /// Cancelling and expiring clear the slot, and an expired bid nobody has expired yet does not
    /// stand in the way of a new one.
    function testAudit_R2M01_cancelAndExpiryFreeTheSlot() public {
        uint256 offerId = _bid(BOB, 500 ether);
        vm.prank(BOB);
        market.cancelOffer(offerId);
        assertEq(market.offerIdOf(address(pixel), id, BOB), 0, "cancelled");

        offerId = _bid(BOB, 100 ether);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(BOB);
        uint256 newer = market.makeOffer(address(pixel), id, 50 ether, uint64(vm.getBlockTimestamp() + 1 days), 0);
        assertFalse(_offerActive(offerId), "the expired bid was refunded on the way");
        assertEq(market.offerIdOf(address(pixel), id, BOB), newer, "and replaced");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(MALLORY);
        market.expireOffer(newer);
        assertEq(market.offerIdOf(address(pixel), id, BOB), 0, "expired by anyone");
        assertEq(market.credits(BOB), 500 ether, "all of it is credit again");
        assertEq(market.escrowedNusd(), 0, "nothing escrowed");
        assertEq(market.activeOfferCount(), 0, "no live offer");
        _assertSolvent();
    }

    /// Accepted, and stated in the report: the market only sees sales made through it. A bidder who
    /// receives the token and passes it on outside the market still has a live bid, and the next
    /// owner can fill it. Cancelling that bid is the bidder's own step.
    function testAudit_R2M01_accepted_aBidOutlivesMovesOutsideTheMarket() public {
        uint256 offerId = _bid(BOB, 500 ether);
        vm.prank(ALICE);
        pixel.transferFrom(ALICE, BOB, id);
        vm.prank(BOB);
        pixel.transferFrom(BOB, CAROL, id);
        assertTrue(_offerActive(offerId), "still live");

        vm.startPrank(CAROL);
        pixel.approve(address(market), id);
        market.acceptOffer(offerId, 0);
        vm.stopPrank();
        assertEq(pixel.ownerOf(id), BOB, "back with Bob at his own bid");
        assertEq(market.credits(CAROL), 497.5 ether, "500 minus 0.5%");
        _assertSolvent();
    }
}
