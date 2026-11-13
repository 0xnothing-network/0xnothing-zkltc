// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NusdNftMarketplaceV2} from "../../src/0xpixel/NusdNftMarketplaceV2.sol";
import {ZeroXPixelV2} from "../../src/0xpixel/ZeroXPixelV2.sol";
import {MarketplaceBurnableNusdMock} from "../mocks/NusdMarketplaceMocks.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// A buyer / offerer contract that attacks the market from onERC721Received, the only callback the
/// market hands to an untrusted party (through the collection, in _settle).
contract ReviewMarketHostileReceiver is IERC721Receiver {
    NusdNftMarketplaceV2 public immutable market;
    ZeroXPixelV2 public immutable pixel;

    /// 0: try every entry point, then accept. 1: revert. 2: accept and send the token back.
    uint256 public mode;
    uint256 public otherListingId;
    uint256 public ownOfferId;

    uint256 public callbacks;
    uint256 public blockedByGuard;
    uint256 public failedOtherwise;
    uint256 public succeeded;
    // What the market reported while the hook ran.
    uint256 public seenSellerCredits;
    uint256 public seenLiabilities;
    uint256 public seenBalance;
    uint256 public seenEscrow;
    uint256 public seenEpoch;
    address public seenOwner;

    constructor(NusdNftMarketplaceV2 market_, ZeroXPixelV2 pixel_, MarketplaceBurnableNusdMock nusd_) {
        market = market_;
        pixel = pixel_;
        nusd_.approve(address(market_), type(uint256).max);
    }

    function configure(uint256 mode_, uint256 otherListingId_, uint256 ownOfferId_) external {
        mode = mode_;
        otherListingId = otherListingId_;
        ownOfferId = ownOfferId_;
    }

    function buy(uint256 listingId, uint256 price) external {
        market.buy(listingId, price, price);
    }

    function offer(uint256 tokenId, uint256 price, uint64 expiresAt) external returns (uint256) {
        return market.makeOffer(address(pixel), tokenId, price, expiresAt, price);
    }

    function cancelOffer(uint256 offerId) external {
        market.cancelOffer(offerId);
    }

    function withdraw() external {
        market.withdrawNusd(address(this));
    }

    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        ++callbacks;
        if (mode == 1) revert("RECEIVER_SAYS_NO");

        IERC20Like nusd = IERC20Like(address(market.nusd()));
        seenSellerCredits = market.credits(from);
        seenLiabilities = market.totalLiabilitiesNusd();
        seenBalance = nusd.balanceOf(address(market));
        seenEscrow = market.escrowedNusd();
        seenOwner = pixel.ownerOf(tokenId);

        // The token is ours already, so we can approve the market and try to list it at once.
        pixel.approve(address(market), tokenId);
        seenEpoch = pixel.listingEpoch(tokenId, address(market));

        _try(abi.encodeCall(market.buy, (otherListingId, 100 ether, 100 ether)));
        _try(abi.encodeCall(market.list, (address(pixel), tokenId, 1 ether)));
        _try(abi.encodeCall(market.updateListingPrice, (otherListingId, 1)));
        _try(abi.encodeCall(market.cancelListing, (otherListingId)));
        _try(abi.encodeCall(market.invalidateListing, (otherListingId)));
        _try(
            abi.encodeCall(
                market.makeOffer, (address(pixel), tokenId + 1, 1 ether, uint64(block.timestamp + 1 days), 1 ether)
            )
        );
        _try(abi.encodeCall(market.acceptOffer, (ownOfferId, 0)));
        _try(abi.encodeCall(market.cancelOffer, (ownOfferId)));
        _try(abi.encodeCall(market.expireOffer, (ownOfferId)));
        _try(abi.encodeCall(market.withdrawNusd, (address(this))));

        if (mode == 2) pixel.transferFrom(address(this), from, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }

    function _try(bytes memory data) private {
        (bool ok, bytes memory returned) = address(market).call(data);
        if (ok) {
            ++succeeded;
        } else if (returned.length == 4 && bytes4(returned) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector) {
            ++blockedByGuard;
        } else {
            ++failedOtherwise;
        }
    }
}

interface IERC20Like {
    function balanceOf(address account) external view returns (uint256);
}

/// Attack 3: re-entrancy and ordering in buy() and acceptOffer() with a hostile receiver, now that
/// both paths also read listingEpoch from the collection. Disposable evidence; every test passes.
contract AuditMarketplaceReentrancyTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant MALLORY = address(0xBAD);
    uint256 private constant PRICE = 100 ether;

    MarketplaceBurnableNusdMock private nusd;
    ZeroXPixelV2 private pixel;
    NusdNftMarketplaceV2 private market;
    ReviewMarketHostileReceiver private hostile;
    uint256 private first;
    uint256 private second;
    uint256 private firstListing;
    uint256 private secondListing;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceBurnableNusdMock();
        pixel = new ZeroXPixelV2();
        address[] memory collections = new address[](1);
        collections[0] = address(pixel);
        market = new NusdNftMarketplaceV2(address(nusd), address(this), collections);
        hostile = new ReviewMarketHostileReceiver(market, pixel, nusd);
        nusd.mint(address(hostile), 1_000 ether);
        nusd.mint(MALLORY, 1_000 ether);
        vm.prank(MALLORY);
        nusd.approve(address(market), type(uint256).max);

        vm.startPrank(ALICE);
        first = pixel.mintPacked("first", "", 8, hex"000000ff0000");
        second = pixel.mintPacked("second", "", 8, hex"00000000ff00");
        pixel.setApprovalForAll(address(market), true);
        firstListing = market.list(address(pixel), first, PRICE);
        secondListing = market.list(address(pixel), second, PRICE);
        vm.stopPrank();
    }

    function _active(uint256 listingId) private view returns (bool active) {
        (,,,, active,) = market.listings(listingId);
    }

    function _offerActive(uint256 offerId) private view returns (bool active) {
        (,,,,, active) = market.offers(offerId);
    }

    function _solvent() private view {
        assertEq(nusd.balanceOf(address(market)), market.totalLiabilitiesNusd(), "every liability is backed");
        assertEq(market.totalLiabilitiesNusd(), market.escrowedNusd() + market.totalCreditsNusd(), "liability sum");
    }

    /// buy(): from the hook the buyer tries all ten state-changing entry points. Each one is refused
    /// by the guard, and the state it can read is already the final one.
    function testAudit_E01_buyerCannotReenterFromTheReceiverHook() public {
        // An offer of its own on the second token, so cancelOffer/expireOffer have a real target.
        uint256 offerId = hostile.offer(second, 10 ether, uint64(vm.getBlockTimestamp() + 1 days));
        hostile.configure(0, secondListing, offerId);

        uint256 balanceBefore = nusd.balanceOf(address(hostile));
        hostile.buy(firstListing, PRICE);

        assertEq(hostile.callbacks(), 1, "one hook");
        assertEq(hostile.blockedByGuard(), 10, "all ten re-entrant calls hit the guard");
        assertEq(hostile.succeeded(), 0, "none went through");
        assertEq(hostile.failedOtherwise(), 0, "none failed for another reason");

        assertEq(pixel.ownerOf(first), address(hostile), "the buyer got the token");
        assertEq(balanceBefore - nusd.balanceOf(address(hostile)), PRICE, "and paid the price once");
        assertFalse(_active(firstListing), "listing consumed");
        assertTrue(_active(secondListing), "the other listing was not touched");
        assertTrue(_offerActive(offerId), "its own offer is still escrowed");
        assertEq(market.credits(address(hostile)), 0, "no credit appeared for the buyer");
        assertEq(market.credits(ALICE), 99.9 ether, "seller and creator share, minus the 0.1% burn");

        // Read-only re-entrancy: what the hook saw is what is true after the call.
        assertEq(hostile.seenOwner(), address(hostile), "token already delivered");
        assertEq(hostile.seenSellerCredits(), market.credits(ALICE), "credits already final in the hook");
        assertEq(hostile.seenLiabilities(), market.totalLiabilitiesNusd(), "liabilities already final");
        assertEq(hostile.seenBalance(), nusd.balanceOf(address(market)), "burn already done");
        assertEq(hostile.seenEscrow(), market.escrowedNusd(), "escrow already final");
        _solvent();

        // The approval the hook wrote is an ordinary one: the buyer can list afterwards.
        assertEq(pixel.listingEpoch(first, address(market)), hostile.seenEpoch(), "nothing moved after the hook");
        vm.prank(MALLORY);
        market.buy(secondListing, PRICE, PRICE); // the untouched listing still sells
        _solvent();
    }

    /// acceptOffer(): the offerer receives the token and tries to take its escrow back in the hook.
    function testAudit_E01_offererCannotReenterWhenItsOfferIsAccepted() public {
        uint256 offerId = hostile.offer(first, 50 ether, uint64(vm.getBlockTimestamp() + 1 days));
        hostile.configure(0, secondListing, offerId);
        assertEq(market.escrowedNusd(), 50 ether, "escrowed");

        vm.prank(ALICE);
        market.acceptOffer(offerId, 0);

        assertEq(hostile.callbacks(), 1, "one hook");
        assertEq(hostile.blockedByGuard(), 10, "cancelOffer, expireOffer, withdraw and the rest hit the guard");
        assertEq(hostile.succeeded(), 0, "none went through");
        assertEq(hostile.failedOtherwise(), 0, "none failed for another reason");
        assertEq(pixel.ownerOf(first), address(hostile), "token delivered");
        assertFalse(_offerActive(offerId), "offer consumed");
        assertFalse(_active(firstListing), "the listing of the sold token went with it");
        assertEq(market.escrowedNusd(), 0, "escrow released exactly once");
        assertEq(market.credits(address(hostile)), 0, "the offerer was not refunded as well");
        assertEq(market.credits(ALICE), 49.95 ether, "50 minus the 0.1% burn");
        assertEq(hostile.seenEscrow(), 0, "escrow was already released in the hook");
        _solvent();

        vm.expectRevert(NusdNftMarketplaceV2.Inactive.selector);
        hostile.cancelOffer(offerId);
        vm.expectRevert(NusdNftMarketplaceV2.NothingToWithdraw.selector);
        hostile.withdraw();
    }

    /// A receiver that refuses the token: both paths revert as a whole. Nothing is charged, the
    /// listing and the offer are as they were, and the offerer can still take its escrow back.
    function testAudit_E01_refusingReceiverLeavesEverythingInPlace() public {
        uint256 offerId = hostile.offer(second, 50 ether, uint64(vm.getBlockTimestamp() + 1 days));
        hostile.configure(1, secondListing, offerId);
        uint256 balanceBefore = nusd.balanceOf(address(hostile));
        uint256 storedEpoch = pixel.listingEpoch(first, address(market));

        vm.expectRevert(bytes("RECEIVER_SAYS_NO"));
        hostile.buy(firstListing, PRICE);
        assertEq(nusd.balanceOf(address(hostile)), balanceBefore, "the wallet payment came back with the revert");
        assertTrue(_active(firstListing), "listing still there");
        assertEq(pixel.ownerOf(first), ALICE, "token still with the seller");
        assertEq(pixel.listingEpoch(first, address(market)), storedEpoch, "the failed sale did not move the epoch");

        vm.prank(ALICE);
        vm.expectRevert(bytes("RECEIVER_SAYS_NO"));
        market.acceptOffer(offerId, 0);
        assertTrue(_offerActive(offerId), "offer still active");
        assertTrue(_active(secondListing), "the listing acceptOffer would have removed is back");
        assertEq(market.escrowedNusd(), 50 ether, "escrow intact");
        _solvent();

        // The refused listing still sells to an ordinary buyer, and the escrow can be recovered.
        vm.prank(MALLORY);
        market.buy(firstListing, PRICE, PRICE);
        assertEq(pixel.ownerOf(first), MALLORY, "sold to someone who accepts it");
        hostile.cancelOffer(offerId);
        hostile.withdraw();
        assertEq(nusd.balanceOf(address(hostile)), balanceBefore + 50 ether, "every NUSD of the offer returned");
        assertEq(nusd.balanceOf(address(hostile)), 1_000 ether, "the hostile wallet is where it started");
        _solvent();
    }

    /// The buyer hands the token straight back to the seller inside the hook. The sale stands, the
    /// consumed listing does not come back although the seller owns and approves the token again.
    function testAudit_E01_tokenReturnedInsideTheHook() public {
        hostile.configure(2, secondListing, 0);
        hostile.buy(firstListing, PRICE);

        assertEq(pixel.ownerOf(first), ALICE, "the token is back with the seller");
        assertTrue(pixel.isApprovedForAll(ALICE, address(market)), "and the market is still approved");
        assertFalse(_active(firstListing), "the listing was consumed by the sale");
        assertEq(market.tokenToListingId(address(pixel), first), 0, "the token is not listed");
        assertEq(market.credits(ALICE), 99.9 ether, "she was paid");
        vm.prank(MALLORY);
        vm.expectRevert(NusdNftMarketplaceV2.Inactive.selector);
        market.buy(firstListing, PRICE, PRICE);
        _solvent();
    }
}
