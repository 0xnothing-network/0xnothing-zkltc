pragma solidity ^0.8.24;

import { TestBase } from "../TestBase.sol";
import { NusdNftMarketplace } from "../../src/0xpixel/NusdNftMarketplace.sol";
import { MarketplaceNusdMock, MarketplaceNftMock, MarketplaceNftBuyerMock } from "../mocks/NusdMarketplaceMocks.sol";
import { ZeroXPixelV2 } from "../../src/0xpixel/ZeroXPixelV2.sol";

contract NusdNftMarketplaceTest is TestBase {
    address private constant SELLER = address(0xA11CE);
    address private constant BUYER = address(0xB0B);
    address private constant CREATOR = address(0xCAFE);
    address private constant TREASURY = address(0xFEE);
    address private constant OTHER = address(0xC0FFEE);
    MarketplaceNusdMock private nusd;
    MarketplaceNftMock private nft;
    NusdNftMarketplace private market;

    function setUp() public {
        nusd = new MarketplaceNusdMock();
        nft = new MarketplaceNftMock(CREATOR);
        address[] memory collections = new address[](1);
        collections[0] = address(nft);
        market = new NusdNftMarketplace(address(nusd), address(this), TREASURY, 40, collections);
        nft.mint(SELLER, 1);
        nft.mint(OTHER, 2);
        nusd.mint(BUYER, 1000 ether);
        vm.prank(SELLER);
        nft.setApprovalForAll(address(market), true);
        vm.prank(OTHER);
        nft.setApprovalForAll(address(market), true);
        vm.prank(BUYER);
        nusd.approve(address(market), 1000 ether);
    }

    function _list(uint256 price) private returns (uint256 listingId) {
        vm.prank(SELLER);
        return market.list(address(nft), 1, price);
    }

    function _offer(uint256 price) private returns (uint256 offerId) {
        vm.prank(BUYER);
        return market.makeOffer(address(nft), 1, price, uint64(block.timestamp + 1 days), price);
    }

    function _solvent() private view {
        assertEq(nusd.balanceOf(address(market)), market.totalLiabilitiesNusd(), "LIABILITIES_NOT_BACKED");
        assertEq(market.totalLiabilitiesNusd(), market.escrowedNusd() + market.totalCreditsNusd(), "BAD_LIABILITY_SUM");
        assertEq(market.totalCreditsNusd(), market.credits(SELLER) + market.credits(BUYER) + market.credits(CREATOR) + market.credits(TREASURY) + market.credits(OTHER), "BAD_CREDIT_SUM");
    }

    function testBuySettlesAllFeesAndRoyaltyInNusdWithoutHoldingNft() public {
        nft.setRoyalty(CREATOR, 500);
        uint256 listingId = _list(100 ether);
        assertEq(nft.ownerOf(1), SELLER, "NFT_WAS_ESCROWED");
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        assertEq(nft.ownerOf(1), BUYER, "WRONG_NFT_OWNER");
        assertEq(market.credits(SELLER), 94.6 ether, "WRONG_NET_PROCEEDS");
        assertEq(market.credits(CREATOR), 5 ether, "WRONG_ROYALTY");
        assertEq(market.credits(TREASURY), 0.4 ether, "WRONG_PLATFORM_FEE");
        assertEq(market.totalSales(), 1, "WRONG_SALES");
        assertEq(market.totalVolumeNusd(), 100 ether, "WRONG_VOLUME");
        assertEq(market.activeListingCount(), 0, "SOLD_LISTING_ACTIVE");
        _solvent();
    }

    function testRecyclesSellerCreditsWithoutWithdrawOrTokenApproval() public {
        uint256 listingId = _list(100 ether);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        vm.prank(OTHER);
        uint256 secondId = market.list(address(nft), 2, 99.6 ether);
        vm.prank(SELLER);
        market.buy(secondId, 99.6 ether, 0);
        assertEq(nft.ownerOf(2), SELLER, "CREDIT_PURCHASE_FAILED");
        assertEq(nusd.allowance(SELLER, address(market)), 0, "CREDIT_ONLY_NEEDS_NO_APPROVAL");
        assertEq(nusd.balanceOf(SELLER), 0, "CREDIT_WAS_WITHDRAWN");
        _solvent();
    }

    function testUsesCreditsFirstAndOnlyPullsApprovedShortfall() public {
        uint256 listingId = _list(100 ether);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        vm.prank(OTHER);
        uint256 secondId = market.list(address(nft), 2, 150 ether);
        nusd.mint(SELLER, 50.4 ether);
        vm.prank(SELLER);
        nusd.approve(address(market), 50.4 ether);
        vm.prank(SELLER);
        market.buy(secondId, 150 ether, 50.4 ether);
        assertEq(nusd.balanceOf(SELLER), 0, "OVERPULLED_WALLET");
        assertEq(nusd.allowance(SELLER, address(market)), 0, "NOT_EXACT_APPROVAL");
        _solvent();
    }

    function testCreditChangeCannotIncreaseReviewedWalletPayment() public {
        uint256 listingId = _list(100 ether);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        vm.prank(OTHER);
        uint256 secondId = market.list(address(nft), 2, 150 ether);
        vm.prank(SELLER);
        market.withdrawNusd(SELLER);
        vm.expectRevert(NusdNftMarketplace.WalletPaymentExceeded.selector);
        vm.prank(SELLER);
        market.buy(secondId, 150 ether, 50.4 ether);
        assertEq(nft.ownerOf(2), OTHER, "SPENT_AFTER_CREDIT_CHANGED");
        _solvent();
    }

    function testOfferEscrowMovesToSellerCreditsWithoutDoubleCounting() public {
        uint256 offerId = _offer(100 ether);
        assertEq(market.escrowedNusd(), 100 ether, "OFFER_NOT_FUNDED");
        vm.prank(SELLER);
        market.acceptOffer(offerId, 99.6 ether);
        assertEq(market.escrowedNusd(), 0, "ESCROW_NOT_RELEASED");
        assertEq(nft.ownerOf(1), BUYER, "OFFER_NOT_SETTLED");
        assertEq(market.activeOfferCount(), 0, "OFFER_STILL_ACTIVE");
        _solvent();
    }

    function testCancellationRefundsAsReusableCreditsAndCannotRefundTwice() public {
        uint256 offerId = _offer(100 ether);
        vm.prank(BUYER);
        market.cancelOffer(offerId);
        assertEq(market.credits(BUYER), 100 ether, "REFUND_NOT_CREDITED");
        vm.expectRevert(NusdNftMarketplace.Inactive.selector);
        vm.prank(BUYER);
        market.cancelOffer(offerId);
        vm.prank(BUYER);
        market.makeOffer(address(nft), 1, 100 ether, uint64(block.timestamp + 1 days), 0);
        assertEq(nusd.balanceOf(BUYER), 900 ether, "RECYCLED_OFFER_PULLED_TWICE");
        _solvent();
    }

    function testAnyoneExpiresOfferButRefundOnlyBelongsToMaker() public {
        uint256 offerId = _offer(100 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(OTHER);
        market.expireOffer(offerId);
        assertEq(market.credits(BUYER), 100 ether, "WRONG_REFUND_ACCOUNT");
        assertEq(market.credits(OTHER), 0, "EXPIRER_STOLE_REFUND");
        _solvent();
    }

    function testRefundWithdrawalAndListingCancelRemainAvailableWhilePaused() public {
        uint256 listingId = _list(100 ether);
        uint256 offerId = _offer(100 ether);
        market.pause();
        vm.prank(SELLER);
        market.cancelListing(listingId);
        vm.prank(BUYER);
        market.cancelOffer(offerId);
        vm.prank(BUYER);
        market.withdrawNusd(OTHER);
        assertEq(nusd.balanceOf(OTHER), 100 ether, "PAUSE_LOCKED_REFUND");
        _solvent();
    }

    function testUnsupportedOrDisabledCollectionCannotTradeButCanRefund() public {
        uint256 offerId = _offer(100 ether);
        market.setCollectionAllowed(address(nft), false);
        vm.expectRevert(NusdNftMarketplace.CollectionNotAllowed.selector);
        vm.prank(SELLER);
        market.acceptOffer(offerId, 0);
        vm.prank(BUYER);
        market.cancelOffer(offerId);
        _solvent();
    }

    function testPriceUpdateRequiresExpectedPriceAndDoesNotTouchNft() public {
        uint256 listingId = _list(100 ether);
        vm.prank(SELLER);
        market.updateListingPrice(listingId, 101 ether);
        vm.expectRevert(NusdNftMarketplace.PriceChanged.selector);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        assertEq(nft.ownerOf(1), SELLER, "STALE_PRICE_BOUGHT_NFT");
        _solvent();
    }

    function testStaleOwnerListingCannotTakePaymentAndNewOwnerCanRelist() public {
        uint256 listingId = _list(100 ether);
        vm.prank(SELLER);
        nft.transferFrom(SELLER, OTHER, 1);
        vm.expectRevert(NusdNftMarketplace.NotPurchasable.selector);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        vm.prank(OTHER);
        market.list(address(nft), 1, 50 ether);
        assertEq(market.activeListingCount(), 1, "STALE_LISTING_NOT_REMOVED");
        _solvent();
    }

    function testRevokedNftApprovalCanBeInvalidatedWithoutSpendingNusd() public {
        uint256 listingId = _list(100 ether);
        vm.prank(SELLER);
        nft.setApprovalForAll(address(market), false);
        vm.prank(OTHER);
        market.invalidateListing(listingId);
        assertEq(market.activeListingCount(), 0, "REVOKED_LISTING_STILL_ACTIVE");
        _solvent();
    }

    function testBadRoyaltyRevertsInsteadOfSilentlySkippingCreatorPayment() public {
        uint256 listingId = _list(100 ether);
        nft.setRoyalty(CREATOR, 10_000);
        vm.expectRevert(NusdNftMarketplace.InvalidRoyalty.selector);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        assertEq(nft.ownerOf(1), SELLER, "BAD_ROYALTY_TRANSFERRED_NFT");
        assertEq(nusd.balanceOf(BUYER), 1000 ether, "BAD_ROYALTY_CHARGED_BUYER");
        nft.setRoyalty(address(market), 500);
        vm.expectRevert(NusdNftMarketplace.InvalidRoyalty.selector);
        market.quoteSale(address(nft), 1, 100 ether);
        _solvent();
    }

    function testBrokenRoyaltyFailsClosedAndNonRoyaltyCollectionStillWorks() public {
        uint256 listingId = _list(100 ether);
        nft.setRoyalties(true, true);
        vm.expectRevert();
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        nft.setRoyalties(false, true);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        _solvent();
    }

    function testAcceptOfferProtectsMinimumSellerProceeds() public {
        uint256 offerId = _offer(100 ether);
        nft.setRoyalty(CREATOR, 500);
        vm.expectRevert(NusdNftMarketplace.InsufficientProceeds.selector);
        vm.prank(SELLER);
        market.acceptOffer(offerId, 99.6 ether);
        assertEq(market.escrowedNusd(), 100 ether, "REVERT_LOST_ESCROW");
        _solvent();
    }

    function testFeeOnTransferDepositCannotUnderfundEscrow() public {
        nusd.setTaxed(true);
        vm.expectRevert(NusdNftMarketplace.NonExactTransfer.selector);
        vm.prank(BUYER);
        market.makeOffer(address(nft), 1, 100 ether, uint64(block.timestamp + 1 days), 100 ether);
        assertEq(market.offerCount(), 0, "UNDERFUNDED_OFFER_CREATED");
        assertEq(nusd.balanceOf(BUYER), 1000 ether, "FAILED_TRANSFER_NOT_ATOMIC");
        _solvent();
    }

    function testWithdrawalFailureKeepsCreditAndCannotBeWithdrawnByAnotherUser() public {
        uint256 offerId = _offer(100 ether);
        vm.prank(BUYER);
        market.cancelOffer(offerId);
        nusd.setRejectTransfer(true);
        vm.expectRevert();
        vm.prank(BUYER);
        market.withdrawNusd(BUYER);
        assertEq(market.credits(BUYER), 100 ether, "FAILED_WITHDRAW_LOST_CREDIT");
        vm.expectRevert(NusdNftMarketplace.NothingToWithdraw.selector);
        vm.prank(OTHER);
        market.withdrawNusd(BUYER);
        _solvent();
    }

    function testDonationIsNotLiabilityOrClaimableByOwner() public {
        nusd.mint(address(market), 1 ether);
        assertEq(market.totalLiabilitiesNusd(), 0, "DONATION_CREATED_USER_LIABILITY");
        vm.expectRevert(NusdNftMarketplace.NothingToWithdraw.selector);
        market.withdrawNusd(address(this));
    }

    function testBoundedPaginationHandlesMaxOffsetAndSwapRemoval() public {
        uint256 firstId = _offer(1 ether);
        _offer(2 ether);
        vm.prank(BUYER);
        market.cancelOffer(firstId);
        uint256[] memory ids = market.getActiveOffers(0, 100);
        assertEq(ids.length, 1, "BAD_OFFER_PAGE_LENGTH");
        assertEq(ids[0], 2, "SWAP_REMOVAL_LOST_OFFER");
        assertEq(market.getActiveOffers(type(uint256).max, 100).length, 0, "MAX_OFFSET_NOT_EMPTY");
        vm.expectRevert(NusdNftMarketplace.InvalidPage.selector);
        market.getActiveOffers(0, 101);
        _solvent();
    }

    function testExpiredOfferAndUnauthorizedCancellationFail() public {
        uint256 offerId = _offer(100 ether);
        vm.expectRevert(NusdNftMarketplace.Unauthorized.selector);
        vm.prank(OTHER);
        market.cancelOffer(offerId);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(NusdNftMarketplace.InvalidExpiry.selector);
        vm.prank(SELLER);
        market.acceptOffer(offerId, 0);
        _solvent();
    }

    function testRejectsNativePaymentAndInvalidConstructorFee() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(market).call{ value: 1 }("");
        assertFalse(success, "MARKET_ACCEPTED_NATIVE_CURRENCY");
        address[] memory collections = new address[](1);
        collections[0] = address(nft);
        vm.expectRevert(NusdNftMarketplace.InvalidConfiguration.selector);
        new NusdNftMarketplace(address(nusd), address(this), TREASURY, 501, collections);
    }

    function testFuzzSettlementConservesEveryNusd(uint256 rawPrice, uint256 rawRoyaltyBps) public {
        uint256 price = bound(rawPrice, 1, 1000 ether);
        uint256 royaltyBps = bound(rawRoyaltyBps, 0, 9000);
        nft.setRoyalty(CREATOR, royaltyBps);
        uint256 listingId = _list(price);
        vm.prank(BUYER);
        market.buy(listingId, price, price);
        _solvent();
        if (market.credits(SELLER) != 0) {
            vm.prank(SELLER);
            market.withdrawNusd(SELLER);
        }
        if (market.credits(CREATOR) != 0) {
            vm.prank(CREATOR);
            market.withdrawNusd(CREATOR);
        }
        if (market.credits(TREASURY) != 0) {
            vm.prank(TREASURY);
            market.withdrawNusd(TREASURY);
        }
        _solvent();
    }

    function testFuzzOfferRefundConservesEscrow(uint256 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, 1000 ether);
        uint256 offerId = _offer(amount);
        _solvent();
        vm.prank(BUYER);
        market.cancelOffer(offerId);
        _solvent();
        vm.prank(BUYER);
        market.withdrawNusd(BUYER);
        assertEq(nusd.balanceOf(BUYER), 1000 ether, "REFUND_NOT_EXACT");
        _solvent();
    }

    function testReceiverCannotReenterAndRejectedNftRollsBackPayment() public {
        MarketplaceNftBuyerMock receiver = new MarketplaceNftBuyerMock(market);
        nusd.mint(address(receiver), 100 ether);
        nft.setRoyalty(address(receiver), 500);
        uint256 listingId = _list(100 ether);
        receiver.setRejectNft(true);
        vm.expectRevert();
        receiver.buy(nusd, listingId, 100 ether);
        assertEq(nft.ownerOf(1), SELLER, "REJECTED_NFT_CHANGED_OWNER");
        assertEq(nusd.balanceOf(address(receiver)), 100 ether, "REJECTED_NFT_SPENT_NUSD");
        assertEq(market.activeListingCount(), 1, "REJECTED_NFT_REMOVED_LISTING");
        assertEq(market.totalLiabilitiesNusd(), 0, "REJECTED_NFT_ADDED_LIABILITY");
        receiver.setRejectNft(false);
        receiver.buy(nusd, listingId, 100 ether);
        assertTrue(receiver.reentryBlocked(), "REENTRY_NOT_BLOCKED");
        assertEq(market.credits(address(receiver)), 5 ether, "BUYER_ROYALTY_NOT_CREDITED");
        assertEq(nusd.balanceOf(address(market)), market.totalLiabilitiesNusd(), "REENTRY_BROKE_SOLVENCY");
    }

    function testTaxedWithdrawalRollsBackCreditAndTokenBalance() public {
        uint256 offerId = _offer(100 ether);
        vm.prank(BUYER);
        market.cancelOffer(offerId);
        nusd.setTaxed(true);
        vm.prank(BUYER);
        vm.expectRevert(NusdNftMarketplace.NonExactTransfer.selector);
        market.withdrawNusd(BUYER);
        assertEq(market.credits(BUYER), 100 ether, "TAXED_WITHDRAWAL_SPENT_CREDIT");
        assertEq(nusd.balanceOf(BUYER), 900 ether, "TAXED_WITHDRAWAL_CHANGED_BALANCE");
        _solvent();
    }

    function testCreatorAndSellerCreditsCombineWithoutDoubleCounting() public {
        nft.setRoyalty(SELLER, 100);
        uint256 listingId = _list(100 ether);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        assertEq(market.credits(SELLER), 99.6 ether, "OVERLAPPING_ROYALTY_NOT_COMBINED");
        _solvent();
    }

    function testRealPixelV2SalePreservesCreatorRoyaltyAndOwnerInventory() public {
        ZeroXPixelV2 pixel = new ZeroXPixelV2();
        market.setCollectionAllowed(address(pixel), true);
        vm.prank(CREATOR);
        uint256 tokenId = pixel.mintPacked("NUSD art", "", 8, hex"000000ffffff");
        vm.prank(CREATOR);
        pixel.transferFrom(CREATOR, SELLER, tokenId);
        vm.prank(SELLER);
        pixel.approve(address(market), tokenId);
        vm.prank(SELLER);
        uint256 listingId = market.list(address(pixel), tokenId, 100 ether);
        vm.prank(BUYER);
        market.buy(listingId, 100 ether, 100 ether);
        assertEq(market.credits(CREATOR), 1 ether, "REAL_CREATOR_ROYALTY_MISSING");
        assertEq(market.credits(SELLER), 98.6 ether, "REAL_SELLER_PROCEEDS_WRONG");
        assertEq(pixel.tokensOfOwner(SELLER).length, 0, "SELLER_INVENTORY_STALE");
        assertEq(pixel.tokensOfOwner(BUYER)[0], tokenId, "BUYER_INVENTORY_MISSING");
        _solvent();
    }

    function testFuzzRefundAndReuseSequenceAlwaysBacksCredits(uint256 seed) public {
        for (uint256 step; step < 24; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 price = seed % (30 ether) + 1;
            uint256 offerId = _offer(price);
            _solvent();
            if (seed % 3 == 0) {
                vm.warp(block.timestamp + 1 days);
                vm.prank(OTHER);
                market.expireOffer(offerId);
            } else {
                vm.prank(BUYER);
                market.cancelOffer(offerId);
            }
            _solvent();
            if (seed % 4 == 0) {
                vm.prank(BUYER);
                market.withdrawNusd(BUYER);
                _solvent();
            }
        }
        if (market.credits(BUYER) != 0) {
            vm.prank(BUYER);
            market.withdrawNusd(BUYER);
        }
        assertEq(nusd.balanceOf(BUYER), 1000 ether, "SEQUENCE_LOST_NUSD");
        _solvent();
    }
}
