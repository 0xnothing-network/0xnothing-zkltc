// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NusdNftMarketplaceV2} from "../../src/0xpixel/NusdNftMarketplaceV2.sol";
import {ZeroXPixelV2} from "../../src/0xpixel/ZeroXPixelV2.sol";
import {IListingEpoch} from "../../src/0xpixel/ListingEpochERC721.sol";
import {MarketplaceBurnableNusdMock} from "../mocks/NusdMarketplaceMocks.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// Scenarios from the adversarial review of the E-01 fix of the 2026-11 audit (listings bound to
/// the listingEpoch of the collection): every way a token can leave and return, every way an
/// approval can come and go, and what third parties can and cannot do to a live listing.
contract AuditMarketplaceScenariosTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant OPERATOR = address(0x09E7A7);
    address private constant MALLORY = address(0xBAD);
    address private constant STRANGER = address(0x57A6E7);
    uint256 private constant PRICE = 100 ether;

    MarketplaceBurnableNusdMock private nusd;
    ZeroXPixelV2 private pixel;
    NusdNftMarketplaceV2 private market;
    uint256 private mintNonce;

    error ProbeResult(bool bought);

    event log_named_uint(string key, uint256 value);

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceBurnableNusdMock();
        pixel = new ZeroXPixelV2();
        address[] memory collections = new address[](1);
        collections[0] = address(pixel);
        market = new NusdNftMarketplaceV2(address(nusd), address(this), collections);
        _fund(MALLORY);
        _fund(BOB);
        _fund(ALICE);
    }

    // ------------------------------------------------------------------ helpers

    function _fund(address account) private {
        nusd.mint(account, 1_000_000 ether);
        vm.prank(account);
        nusd.approve(address(market), type(uint256).max);
    }

    function _mint(address owner) private returns (uint256 id) {
        uint256 n = mintNonce++;
        // One 1-pixel run at a position and colour no other mint used.
        bytes memory pixels = abi.encodePacked(uint8(n % 8), uint8((n / 8) % 8), uint8(0), bytes3(uint24(n + 1)));
        vm.prank(owner);
        id = pixel.mintPacked("art", "", 8, pixels);
    }

    /// mode 0: single-token approval, 1: approval for all, 2: both.
    function _grant(address owner, uint256 id, uint256 mode) private {
        if (mode != 0) {
            vm.prank(owner);
            pixel.setApprovalForAll(address(market), true);
        }
        if (mode != 1) {
            vm.prank(owner);
            pixel.approve(address(market), id);
        }
    }

    function _list(address owner, uint256 id) private returns (uint256 listingId) {
        vm.prank(owner);
        listingId = market.list(address(pixel), id, PRICE);
    }

    function _move(address from, address to, uint256 id, uint256 path) private {
        vm.prank(from);
        if (path == 0) pixel.safeTransferFrom(from, to, id);
        else if (path == 1) pixel.transferFrom(from, to, id);
        else pixel.transferNFT(to, id);
    }

    function _active(uint256 listingId) private view returns (bool active) {
        (,,,, active,) = market.listings(listingId);
    }

    function _storedEpoch(uint256 listingId) private view returns (uint256 epoch) {
        (,,,,, epoch) = market.listings(listingId);
    }

    function _marketApproved(address owner, uint256 id) private view returns (bool) {
        return pixel.getApproved(id) == address(market) || pixel.isApprovedForAll(owner, address(market));
    }

    /// Runs a real buy by MALLORY and rolls it back: tells whether the listing can be bought now.
    function probeBuy(uint256 listingId) external {
        require(msg.sender == address(this), "ONLY_SELF");
        vm.prank(MALLORY);
        try market.buy(listingId, PRICE, PRICE) {
            revert ProbeResult(true);
        } catch {
            revert ProbeResult(false);
        }
    }

    function _canBuy(uint256 listingId) private returns (bool bought) {
        try this.probeBuy(listingId) {
            revert("PROBE_DID_NOT_REVERT");
        } catch (bytes memory data) {
            require(data.length == 36, "BAD_PROBE");
            bytes4 selector;
            uint256 value;
            assembly ("memory-safe") {
                selector := mload(add(data, 0x20))
                value := mload(add(data, 0x24))
            }
            require(selector == ProbeResult.selector, "BAD_PROBE_SELECTOR");
            bought = value != 0;
        }
    }

    function _assertDeadForGood(uint256 listingId, address seller, uint256 id, string memory why) private {
        assertFalse(_canBuy(listingId), why);
        if (_active(listingId)) {
            vm.prank(seller);
            vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
            market.updateListingPrice(listingId, PRICE);
        }
        if (pixel.ownerOf(id) == seller) {
            assertGt(pixel.listingEpoch(id, address(market)), _storedEpoch(listingId), "the epoch is past the stored one");
        }
    }

    // ------------------------------------------------------------------ attack 1: resurrection

    /// The token leaves and returns through every transfer entry point, under every way the market
    /// can hold its approval. The old listing never sells again; a new listing does.
    function testAudit_E01_everyReturnPathLeavesTheListingDead() public {
        for (uint256 mode; mode < 3; ++mode) {
            for (uint256 path; path < 3; ++path) {
                vm.prank(ALICE);
                pixel.setApprovalForAll(address(market), false);
                uint256 id = _mint(ALICE);
                _grant(ALICE, id, mode);
                uint256 listingId = _list(ALICE, id);
                assertTrue(_canBuy(listingId), "live before the token moves");

                _move(ALICE, BOB, id, path);
                assertFalse(_canBuy(listingId), "dead while the token is away");
                _move(BOB, ALICE, id, path);
                if (mode == 0) {
                    vm.prank(ALICE);
                    pixel.approve(address(market), id); // the single approval was cleared by the transfer
                }
                assertTrue(_marketApproved(ALICE, id), "she owns and approves again");
                _assertDeadForGood(listingId, ALICE, id, "dead after the token returned");

                uint256 newId = _list(ALICE, id);
                assertFalse(_active(listingId), "the stale listing was replaced");
                assertTrue(_canBuy(newId), "only the new listing sells");
                assertFalse(_canBuy(listingId), "the old one stays dead next to it");
            }
        }
    }

    /// Approvals that come and go while the seller never loses the token.
    function testAudit_E01_approvalChurnLeavesTheListingDead() public {
        // (a) single approval cleared and granted again.
        uint256 id = _mint(ALICE);
        _grant(ALICE, id, 0);
        uint256 listingId = _list(ALICE, id);
        vm.startPrank(ALICE);
        pixel.approve(address(0), id);
        pixel.approve(address(market), id);
        vm.stopPrank();
        assertTrue(_marketApproved(ALICE, id), "approved again");
        _assertDeadForGood(listingId, ALICE, id, "approve(0) then approve(market)");

        // (b) single approval handed to someone else and back.
        id = _mint(ALICE);
        _grant(ALICE, id, 0);
        listingId = _list(ALICE, id);
        vm.startPrank(ALICE);
        pixel.approve(BOB, id);
        pixel.approve(address(market), id);
        vm.stopPrank();
        _assertDeadForGood(listingId, ALICE, id, "approve(other) then approve(market)");

        // (c) the approval for all stands the whole time; a single approval comes and goes. The
        //     market never stopped being approved, and the listing is dead all the same.
        id = _mint(ALICE);
        _grant(ALICE, id, 1);
        listingId = _list(ALICE, id);
        vm.prank(ALICE);
        pixel.approve(BOB, id);
        assertTrue(pixel.isApprovedForAll(ALICE, address(market)), "market approval never lapsed");
        _assertDeadForGood(listingId, ALICE, id, "a single approval to a third party");
        vm.prank(ALICE);
        pixel.approve(address(0), id);
        _assertDeadForGood(listingId, ALICE, id, "and its removal");

        // (d) both approvals at listing; the approval for all is switched off. The single approval
        //     still authorises the market.
        vm.prank(ALICE);
        pixel.setApprovalForAll(address(market), false);
        id = _mint(ALICE);
        _grant(ALICE, id, 2);
        listingId = _list(ALICE, id);
        vm.prank(ALICE);
        pixel.setApprovalForAll(address(market), false);
        assertEq(pixel.getApproved(id), address(market), "single approval still there");
        _assertDeadForGood(listingId, ALICE, id, "operator approval withdrawn, single approval kept");

        // (e) both approvals at listing; the single approval is cleared. The approval for all
        //     still authorises the market.
        id = _mint(ALICE);
        _grant(ALICE, id, 2);
        listingId = _list(ALICE, id);
        vm.prank(ALICE);
        pixel.approve(address(0), id);
        assertTrue(pixel.isApprovedForAll(ALICE, address(market)), "operator approval still there");
        _assertDeadForGood(listingId, ALICE, id, "single approval withdrawn, operator approval kept");
    }

    /// Sold through an offer, bought back: the listing was removed at the sale and stays removed.
    function testAudit_E01_acceptOfferThenBuyBack() public {
        uint256 id = _mint(ALICE);
        _grant(ALICE, id, 1);
        uint256 listingId = _list(ALICE, id);

        vm.prank(BOB);
        uint256 offerId = market.makeOffer(address(pixel), id, 50 ether, uint64(vm.getBlockTimestamp() + 1 days), 50 ether);
        vm.prank(ALICE);
        market.acceptOffer(offerId, 0);
        assertEq(pixel.ownerOf(id), BOB, "sold through the offer");
        assertFalse(_active(listingId), "her listing went with the sale");
        assertEq(market.tokenToListingId(address(pixel), id), 0, "no listing left for the token");

        // Bob lists it, Alice buys it back. Her approval for all still stands.
        _grant(BOB, id, 0);
        uint256 bobListing = _list(BOB, id);
        vm.prank(ALICE);
        market.buy(bobListing, PRICE, PRICE);
        assertEq(pixel.ownerOf(id), ALICE, "bought back");
        assertTrue(_marketApproved(ALICE, id), "and the market is approved for all her tokens");

        assertFalse(_canBuy(listingId), "the old listing is gone");
        vm.prank(MALLORY);
        vm.expectRevert(NusdNftMarketplaceV2.Inactive.selector);
        market.buy(listingId, PRICE, PRICE);
        assertFalse(_canBuy(bobListing), "the listing Bob made was consumed");
        assertEq(market.tokenToListingId(address(pixel), id), 0, "nothing is listed until she lists");
    }

    /// The same token listed by two sellers in turn. At most one listing is live at any time and
    /// an earlier one never returns.
    function testAudit_E01_twoSellersSameToken() public {
        uint256 id = _mint(ALICE);
        _grant(ALICE, id, 1);
        _grant(BOB, id, 1);
        uint256 first = _list(ALICE, id);

        _move(ALICE, BOB, id, 0);
        uint256 second = _list(BOB, id);
        assertFalse(_active(first), "the listing by Bob replaced the one by Alice");
        assertTrue(_canBuy(second), "the listing by Bob is live");

        _move(BOB, ALICE, id, 0);
        assertFalse(_canBuy(first), "her first listing does not return with the token");
        assertFalse(_canBuy(second), "his listing died when the token left him");
        assertTrue(_active(second), "it is still in storage");

        uint256 third = _list(ALICE, id);
        assertFalse(_active(second), "replaced");
        assertTrue(_canBuy(third), "her new listing is the only live one");

        _move(ALICE, BOB, id, 0);
        assertFalse(_canBuy(first), "first: dead");
        assertFalse(_canBuy(second), "second: dead although Bob owns and approves again");
        assertFalse(_canBuy(third), "third: dead");
        assertEq(market.tokenToListingId(address(pixel), id), third, "the token still points at the stale third listing");
        vm.prank(STRANGER);
        market.invalidateListing(third);
        assertEq(market.activeListingCount(), 0, "catalogue is clean");
    }

    // ------------------------------------------------------------------ attack 2: third parties

    /// Nobody but the seller and wallets she approved for all her tokens can move the epoch of her
    /// listing. A stranger, the buyer, another owner toggling his own approvals, an offer on the
    /// token, and even the wallet approved for that single token (which may only transfer it).
    function testAudit_E01_thirdPartiesCannotEndALiveListing() public {
        uint256 id = _mint(ALICE);
        uint256 other = _mint(BOB);
        // BOB holds the single-token approval; the market is approved for all.
        vm.startPrank(ALICE);
        pixel.approve(BOB, id);
        pixel.setApprovalForAll(address(market), true);
        vm.stopPrank();
        uint256 listingId = _list(ALICE, id);
        uint256 stored = _storedEpoch(listingId);

        // The single-token approved wallet cannot call approve().
        vm.prank(BOB);
        vm.expectRevert();
        pixel.approve(address(market), id);
        vm.prank(BOB);
        vm.expectRevert();
        pixel.approve(address(0), id);

        address[3] memory outsiders = [STRANGER, MALLORY, OPERATOR];
        for (uint256 i; i < outsiders.length; ++i) {
            address outsider = outsiders[i];
            vm.startPrank(outsider);
            pixel.setApprovalForAll(address(market), true); // their own counter
            pixel.setApprovalForAll(address(market), false);
            pixel.setApprovalForAll(ALICE, true);
            vm.stopPrank();
            vm.prank(outsider);
            vm.expectRevert();
            pixel.approve(address(market), id);
            vm.prank(outsider);
            vm.expectRevert();
            pixel.transferFrom(ALICE, outsider, id);
            vm.prank(outsider);
            vm.expectRevert();
            pixel.safeTransferFrom(ALICE, ALICE, id);
            vm.prank(outsider);
            vm.expectRevert(NusdNftMarketplaceV2.NotPurchasable.selector);
            market.invalidateListing(listingId);
            vm.prank(outsider);
            vm.expectRevert(NusdNftMarketplaceV2.Unauthorized.selector);
            market.cancelListing(listingId);
        }

        // Activity on other tokens, by her and by others, and offers on her token.
        vm.startPrank(BOB);
        pixel.approve(address(market), other);
        pixel.transferNFT(ALICE, other);
        vm.stopPrank();
        vm.prank(ALICE);
        pixel.approve(address(market), other);
        _list(ALICE, other);
        vm.prank(MALLORY);
        uint256 offerId = market.makeOffer(address(pixel), id, 1 ether, uint64(vm.getBlockTimestamp() + 1 days), 1 ether);
        vm.prank(MALLORY);
        market.cancelOffer(offerId);
        _mint(ALICE);

        assertEq(pixel.listingEpoch(id, address(market)), stored, "the epoch did not move");
        assertTrue(_canBuy(listingId), "the listing is still for sale");
    }

    /// The boundary of "third parties": a wallet the seller approved for that one token cannot call
    /// approve(), but it may transfer the token, and a transfer from the seller to the seller is
    /// enough to end the listing while she keeps the token. It is her own delegate, and it could
    /// have taken the token outright.
    function testAudit_E01_note_singleTokenDelegateEndsTheListingByTransferOnly() public {
        uint256 id = _mint(ALICE);
        vm.startPrank(ALICE);
        pixel.approve(BOB, id);
        pixel.setApprovalForAll(address(market), true);
        vm.stopPrank();
        uint256 listingId = _list(ALICE, id);
        assertTrue(_canBuy(listingId), "live");

        vm.prank(BOB);
        pixel.transferFrom(ALICE, ALICE, id);
        assertEq(pixel.ownerOf(id), ALICE, "she still owns it");
        assertTrue(pixel.isApprovedForAll(ALICE, address(market)), "and the market is still approved");
        assertEq(pixel.getApproved(id), address(0), "the delegate spent its approval");
        _assertDeadForGood(listingId, ALICE, id, "the listing ended");
    }

    // ------------------------------------------------------------------ attack 4: ERC-165 and overrides

    function testAudit_E01_erc165Answers() public view {
        assertTrue(pixel.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertTrue(pixel.supportsInterface(type(IERC721).interfaceId), "IERC721");
        assertTrue(pixel.supportsInterface(type(IERC721Metadata).interfaceId), "IERC721Metadata");
        assertTrue(pixel.supportsInterface(type(IERC2981).interfaceId), "IERC2981");
        assertTrue(pixel.supportsInterface(type(IListingEpoch).interfaceId), "IListingEpoch");
        assertEq(
            bytes32(type(IListingEpoch).interfaceId), bytes32(IListingEpoch.listingEpoch.selector), "one-function interface id"
        );
        assertEq(bytes32(type(IERC165).interfaceId), bytes32(bytes4(0x01ffc9a7)), "165 id");
        assertEq(bytes32(type(IERC721).interfaceId), bytes32(bytes4(0x80ac58cd)), "721 id");
        assertEq(bytes32(type(IERC721Metadata).interfaceId), bytes32(bytes4(0x5b5e139f)), "metadata id");
        assertEq(bytes32(type(IERC2981).interfaceId), bytes32(bytes4(0x2a55205a)), "2981 id");
        assertFalse(pixel.supportsInterface(0xffffffff), "the invalid id");
        assertFalse(pixel.supportsInterface(0x00000000), "zero id");
        assertFalse(pixel.supportsInterface(0x780e9d63), "ERC721Enumerable is not claimed");
        assertFalse(pixel.supportsInterface(0xd9b67a26), "ERC1155 is not claimed");
        assertFalse(pixel.supportsInterface(0xdeadbeef), "an unknown id");
        assertTrue(market.collectionAllowed(address(pixel)), "the market accepted it through ERC165Checker");
    }

    /// Cost of the counter on the paths users pay for.
    function testAudit_E01_gasOfTransfersAndApprovals() public {
        uint256 id = _mint(ALICE);
        vm.prank(ALICE);
        uint256 before = gasleft();
        pixel.approve(address(market), id);
        uint256 approveGas = before - gasleft();

        vm.prank(ALICE);
        before = gasleft();
        pixel.transferFrom(ALICE, BOB, id);
        uint256 firstTransferGas = before - gasleft();

        vm.prank(BOB);
        before = gasleft();
        pixel.transferFrom(BOB, ALICE, id);
        uint256 secondTransferGas = before - gasleft();

        vm.prank(ALICE);
        before = gasleft();
        pixel.setApprovalForAll(address(market), true);
        uint256 approveAllGas = before - gasleft();

        vm.prank(ALICE);
        uint256 listingId = market.list(address(pixel), id, PRICE);
        vm.prank(MALLORY);
        before = gasleft();
        market.buy(listingId, PRICE, PRICE);
        uint256 buyGas = before - gasleft();

        emit log_named_uint("approve gas", approveGas);
        emit log_named_uint("first transfer gas", firstTransferGas);
        emit log_named_uint("second transfer gas", secondTransferGas);
        emit log_named_uint("setApprovalForAll gas", approveAllGas);
        emit log_named_uint("market buy gas", buyGas);
        assertLe(approveGas, 100_000, "approve");
        assertLe(firstTransferGas, 200_000, "transfer");
        assertLe(secondTransferGas, 200_000, "transfer back");
        assertLe(approveAllGas, 100_000, "setApprovalForAll");
        assertLe(buyGas, 500_000, "buy");
    }

}
