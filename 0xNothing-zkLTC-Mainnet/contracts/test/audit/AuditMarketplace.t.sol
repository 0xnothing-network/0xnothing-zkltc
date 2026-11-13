// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NusdNftMarketplaceV2} from "../../src/0xpixel/NusdNftMarketplaceV2.sol";
import {ZeroXPixelV2} from "../../src/0xpixel/ZeroXPixelV2.sol";
import {PixelERC721} from "../../src/0xpixel/PixelERC721.sol";
import {MarketplaceBurnableNusdMock} from "../mocks/NusdMarketplaceMocks.sol";

/// An ERC-721 that cannot tell a marketplace whether a token moved since it was listed.
contract PlainNft is PixelERC721 {
    constructor() PixelERC721("Plain", "PLAIN") {}
}

/// Regression tests for finding E-01 of the 2026-11 audit (docs/AUDIT_2026-11.md).
///
/// As audited, a listing that had stopped being purchasable was purchasable again, at its old price,
/// as soon as its seller owned and approved the token again: after the token went to another wallet
/// and came back, or after the seller revoked the market's approval and later granted it again. In
/// both cases a stranger bought a 5,000 NUSD token for the 100 NUSD of a forgotten listing, and the
/// seller's own new listing was refused with AlreadyListed. A listing is now bound to the
/// collection's listingEpoch, which moves on every transfer and approval change.
contract AuditMarketplaceTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant VAULT = address(0x7A017);
    address private constant MALLORY = address(0xBAD);

    MarketplaceBurnableNusdMock private nusd;
    ZeroXPixelV2 private pixel;
    NusdNftMarketplaceV2 private market;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceBurnableNusdMock();
        pixel = new ZeroXPixelV2();
        address[] memory collections = new address[](1);
        collections[0] = address(pixel);
        market = new NusdNftMarketplaceV2(address(nusd), address(this), collections);
        nusd.mint(MALLORY, 10_000 ether);
        vm.prank(MALLORY);
        nusd.approve(address(market), type(uint256).max);
    }

    function _mint(address owner, bytes memory pixels) private returns (uint256 id) {
        vm.prank(owner);
        id = pixel.mintPacked("art", "", 8, pixels);
    }

    function _active(uint256 listingId) private view returns (bool active) {
        (,,,, active,) = market.listings(listingId);
    }

    /// Single-token approvals only, as the web app grants them.
    function testAudit_E01_transferAwayAndBackDoesNotReviveTheListing() public {
        uint256 id = _mint(ALICE, hex"000000ff0000");
        vm.startPrank(ALICE);
        pixel.approve(address(market), id);
        uint256 listingId = market.list(address(pixel), id, 100 ether);
        pixel.transferNFT(VAULT, id); // the approval is cleared; the listing stays in storage
        vm.stopPrank();

        // Much later the token comes back and is worth 5,000 NUSD. To list it she must approve first.
        vm.prank(VAULT);
        pixel.transferNFT(ALICE, id);
        vm.prank(ALICE);
        pixel.approve(address(market), id);

        // The old listing can be neither bought nor repriced ...
        vm.prank(MALLORY);
        vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
        market.buy(listingId, 100 ether, 100 ether);
        vm.prank(ALICE);
        vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
        market.updateListingPrice(listingId, 5_000 ether);

        // ... and her new listing replaces it instead of being refused.
        vm.prank(ALICE);
        uint256 newId = market.list(address(pixel), id, 5_000 ether);
        assertFalse(_active(listingId), "the stale listing was removed");
        assertEq(market.tokenToListingId(address(pixel), id), newId, "the token points at the new listing");

        vm.prank(MALLORY);
        market.buy(newId, 5_000 ether, 5_000 ether);
        assertEq(pixel.ownerOf(id), MALLORY, "sold at the price she asked");
        assertEq(market.credits(ALICE), 4_995 ether, "5,000 NUSD minus the 0.1% burn (she is also the creator)");
    }

    /// With an approval for all tokens no second approval is needed: the listing used to be live
    /// again in the block the token returned.
    function testAudit_E01_operatorApprovalDoesNotReviveTheListingEither() public {
        uint256 id = _mint(ALICE, hex"000000ff0000");
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), true);
        uint256 listingId = market.list(address(pixel), id, 100 ether);
        pixel.transferNFT(VAULT, id);
        vm.stopPrank();
        vm.prank(VAULT);
        pixel.transferNFT(ALICE, id);

        vm.prank(MALLORY);
        vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
        market.buy(listingId, 100 ether, 100 ether);

        // Anyone may remove it from the catalogue.
        vm.prank(MALLORY);
        market.invalidateListing(listingId);
        assertFalse(_active(listingId), "removed");
        assertEq(pixel.ownerOf(id), ALICE, "she still owns the token");
    }

    /// Revoking the approval instead of cancelling, then approving again for another listing.
    function testAudit_E01_revokeAndReapproveDoesNotReviveOldListings() public {
        uint256 first = _mint(ALICE, hex"000000ff0000");
        uint256 second = _mint(ALICE, hex"00000000ff00");
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), true);
        uint256 listingId = market.list(address(pixel), first, 100 ether);
        pixel.setApprovalForAll(address(market), false); // "delisted" by revoking
        vm.stopPrank();

        // Later she approves the market again to list the other token.
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), true);
        uint256 secondListing = market.list(address(pixel), second, 300 ether);
        vm.stopPrank();

        vm.prank(MALLORY);
        vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
        market.buy(listingId, 100 ether, 100 ether);
        assertEq(pixel.ownerOf(first), ALICE, "the forgotten listing stayed dead");

        // The listing made under the new approval is an ordinary one.
        vm.prank(MALLORY);
        market.buy(secondListing, 300 ether, 300 ether);
        assertEq(pixel.ownerOf(second), MALLORY, "the new listing sells");
    }

    /// Repeating an approval that is already in place changes nothing and ends nothing. The first
    /// version of the fix counted every call, so one repeated setApprovalForAll(market, true) ended
    /// every listing of the wallet (review finding R-M-01). An approval that really changes still
    /// ends the listing, even when it is changed straight back.
    function testAudit_E01_onlyARealApprovalChangeEndsAListing() public {
        bytes[5] memory art =
            [bytes(hex"000000ff0000"), hex"00000000ff00", hex"0000000000ff", hex"000000ffff00", hex"000000ff00ff"];
        uint256[5] memory ids;
        uint256[5] memory listingIds;
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), true);
        for (uint256 i; i < 5; ++i) {
            ids[i] = pixel.mintPacked("art", "", 8, art[i]);
            listingIds[i] = market.list(address(pixel), ids[i], 100 ether);
        }

        // The same approval for all once more, and "no approved address" set again on a token.
        pixel.setApprovalForAll(address(market), true);
        pixel.approve(address(0), ids[0]);
        vm.expectRevert(NusdNftMarketplaceV2.AlreadyListed.selector);
        market.list(address(pixel), ids[1], 200 ether); // a live listing is repriced, not replaced
        market.updateListingPrice(listingIds[1], 150 ether);
        vm.stopPrank();
        vm.prank(MALLORY);
        market.buy(listingIds[0], 100 ether, 100 ether);
        assertEq(pixel.ownerOf(ids[0]), MALLORY, "the listing outlived both repeated approvals");

        // Approving another address and withdrawing it again is a change: that listing ends.
        vm.startPrank(ALICE);
        pixel.approve(VAULT, ids[1]);
        pixel.approve(address(0), ids[1]);
        vm.stopPrank();
        vm.prank(MALLORY);
        vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
        market.buy(listingIds[1], 150 ether, 150 ether);
        vm.prank(ALICE);
        uint256 relisted = market.list(address(pixel), ids[1], 150 ether);
        vm.prank(MALLORY);
        market.buy(relisted, 150 ether, 150 ether);
        assertEq(pixel.ownerOf(ids[1]), MALLORY, "sold through the new listing");

        // Withdrawing the approval for all and granting it again ends the other three.
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), false);
        pixel.setApprovalForAll(address(market), true);
        vm.stopPrank();
        for (uint256 i = 2; i < 5; ++i) {
            vm.prank(MALLORY);
            vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
            market.buy(listingIds[i], 100 ether, 100 ether);
        }
    }

    /// The epoch itself: it moves on transfers and approval changes and on nothing else.
    function testAudit_E01_listingEpochMovesOnTransfersAndApprovals() public {
        uint256 id = _mint(ALICE, hex"000000ff0000");
        uint256 other = _mint(ALICE, hex"00000000ff00");
        uint256 epoch = pixel.listingEpoch(id, address(market));
        uint256 otherEpoch = pixel.listingEpoch(other, address(market));

        vm.prank(ALICE);
        pixel.approve(address(market), id);
        assertGt(pixel.listingEpoch(id, address(market)), epoch, "a single-token approval");
        assertEq(pixel.listingEpoch(other, address(market)), otherEpoch, "leaves other tokens alone");
        epoch = pixel.listingEpoch(id, address(market));

        vm.prank(ALICE);
        pixel.setApprovalForAll(address(market), true);
        assertGt(pixel.listingEpoch(id, address(market)), epoch, "an approval for all, for that operator");
        assertGt(pixel.listingEpoch(other, address(market)), otherEpoch, "on every token of the owner");
        epoch = pixel.listingEpoch(id, address(market));

        vm.prank(ALICE);
        pixel.setApprovalForAll(MALLORY, true);
        assertEq(pixel.listingEpoch(id, address(market)), epoch, "another operator's approval is not ours");

        vm.prank(ALICE);
        pixel.transferNFT(VAULT, id);
        vm.prank(VAULT);
        pixel.transferNFT(ALICE, id);
        assertGt(pixel.listingEpoch(id, address(market)), epoch, "a transfer away and back");

        vm.expectRevert();
        pixel.listingEpoch(999, address(market));

        // A repeated approval and a mint are not counted; a failed call counts nothing.
        epoch = pixel.listingEpoch(id, address(market));
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), true);
        pixel.approve(address(0), id);
        vm.stopPrank();
        vm.prank(address(0x5757)); // a wallet with no right over the token
        vm.expectRevert();
        pixel.approve(address(0x5757), id);
        assertEq(pixel.listingEpoch(id, address(market)), epoch, "nothing changed, nothing counted");
        uint256 fresh = _mint(VAULT, hex"0000000000ff");
        assertEq(pixel.listingEpoch(fresh, address(market)), 0, "a mint is not counted");
    }

    /// A collection that cannot report the epoch cannot be listed here at all.
    function testAudit_E01_onlyCollectionsWithAnEpochAreAllowed() public {
        PlainNft plain = new PlainNft();
        vm.expectRevert(NusdNftMarketplaceV2.InvalidConfiguration.selector);
        market.setCollectionAllowed(address(plain), true);

        address[] memory collections = new address[](1);
        collections[0] = address(plain);
        vm.expectRevert(NusdNftMarketplaceV2.InvalidConfiguration.selector);
        new NusdNftMarketplaceV2(address(nusd), address(this), collections);

        market.setCollectionAllowed(address(plain), false); // disallowing never needs it
    }
}
