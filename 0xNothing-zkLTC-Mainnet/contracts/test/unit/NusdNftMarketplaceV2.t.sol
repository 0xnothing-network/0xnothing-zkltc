pragma solidity ^0.8.24;

import { TestBase } from "../TestBase.sol";
import { NusdNftMarketplaceV2 } from "../../src/0xpixel/NusdNftMarketplaceV2.sol";
import { MarketplaceBurnableNusdMock, MarketplaceNftMock } from "../mocks/NusdMarketplaceMocks.sol";
import { ZeroXPixelV2 } from "../../src/0xpixel/ZeroXPixelV2.sol";
import { DIAOracleAdapter } from "../../src/oracle/DIAOracleAdapter.sol";
import { OracleNUSDv2 } from "../../src/nusd/OracleNUSDv2.sol";
import { IPriceOracle } from "../../src/oracle/IPriceOracle.sol";
import { MockDIAFeed } from "../mocks/MockDIAFeed.sol";

contract NusdNftMarketplaceV2Test is TestBase {
    address private constant SELLER = address(0xA11CE);
    address private constant BUYER = address(0xB0B);
    address private constant CREATOR = address(0xCAFE);
    MarketplaceBurnableNusdMock private nusd;
    MarketplaceNftMock private nft;
    NusdNftMarketplaceV2 private market;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceBurnableNusdMock();
        nft = new MarketplaceNftMock(CREATOR);
        address[] memory collections = new address[](1);
        collections[0] = address(nft);
        market = new NusdNftMarketplaceV2(address(nusd), address(this), collections);
        nft.mint(SELLER, 1);
        nusd.mint(BUYER, 1000 ether);
        vm.prank(SELLER);
        nft.setApprovalForAll(address(market), true);
        vm.prank(BUYER);
        nusd.approve(address(market), type(uint256).max);
    }

    function _list(uint256 price) private returns (uint256 listingId) {
        vm.prank(SELLER);
        return market.list(address(nft), 1, price);
    }

    function _buy(uint256 listingId, uint256 price) private {
        vm.prank(BUYER);
        market.buy(listingId, price, price);
    }

    function _solvent() private view {
        assertEq(nusd.balanceOf(address(market)), market.totalLiabilitiesNusd(), "LIABILITIES_NOT_BACKED");
        assertEq(market.totalLiabilitiesNusd(), market.escrowedNusd() + market.totalCreditsNusd(), "BAD_LIABILITY_SUM");
        assertEq(market.totalCreditsNusd(), market.credits(SELLER) + market.credits(BUYER) + market.credits(CREATOR), "BAD_CREDIT_SUM");
    }

    function testSaleBurnsTenBpsAndPaysCreatorFortyBps() public {
        uint256 supplyBefore = nusd.totalSupply();
        _buy(_list(100 ether), 100 ether);

        assertEq(nft.ownerOf(1), BUYER, "NFT_NOT_DELIVERED");
        assertEq(market.credits(SELLER), 99.5 ether, "SELLER_PROCEEDS");
        assertEq(market.credits(CREATOR), 0.4 ether, "CREATOR_FEE");
        assertEq(supplyBefore - nusd.totalSupply(), 0.1 ether, "NOT_BURNED");
        assertEq(nusd.balanceOf(address(0xdead)), 0, "SENT_TO_DEAD_INSTEAD_OF_BURNED");
        assertEq(market.totalVolumeNusd(), 100 ether, "VOLUME");
        _solvent();
    }

    function testRoyaltyRateIsIgnoredOnlyTheCreatorAddressCounts() public {
        nft.setRoyalty(CREATOR, 1_000);
        _buy(_list(100 ether), 100 ether);
        assertEq(market.credits(CREATOR), 0.4 ether, "FIXED_CREATOR_FEE");
        assertEq(market.credits(SELLER), 99.5 ether, "SELLER_PROCEEDS");
        _solvent();
    }

    function testSellerKeepsCreatorShareWhenNoCreatorCanBeNamed() public {
        nft.setRoyalties(false, false);
        (uint256 burnAmount, address creator, uint256 creatorFee, uint256 proceeds) = market.quoteSale(address(nft), 1, 100 ether);
        assertEq(creator, address(0), "NO_CREATOR");
        assertEq(burnAmount + creatorFee + proceeds, 100 ether, "QUOTE_SUM");
        _buy(_list(100 ether), 100 ether);
        assertEq(market.credits(SELLER), 99.9 ether, "SELLER_KEEPS_CREATOR_SHARE");
        _solvent();
    }

    function testBrokenOrSelfRoyaltyStillSettles() public {
        nft.setRoyalties(true, true);
        uint256 listingId = _list(100 ether);
        _buy(listingId, 100 ether);
        assertEq(market.credits(SELLER), 99.9 ether, "BROKEN_ROYALTY_BLOCKED_SALE");

        nft.setRoyalties(true, false);
        nft.setRoyalty(address(market), 0);
        nft.mint(SELLER, 2);
        vm.prank(SELLER);
        uint256 second = market.list(address(nft), 2, 10 ether);
        _buy(second, 10 ether);
        assertEq(market.credits(address(market)), 0, "CREDIT_STUCK_ON_MARKET");
        assertEq(market.credits(SELLER), 99.9 ether + 9.99 ether, "SELF_ROYALTY_TO_SELLER");
        _solvent();
    }

    function testCreatorSellingOwnWorkGetsBothShares() public {
        nft.mint(CREATOR, 3);
        vm.prank(CREATOR);
        nft.setApprovalForAll(address(market), true);
        vm.prank(CREATOR);
        uint256 listingId = market.list(address(nft), 3, 100 ether);
        _buy(listingId, 100 ether);
        assertEq(market.credits(CREATOR), 99.9 ether, "CREATOR_SELLER_TOTAL");
        _solvent();
    }

    function testAcceptedOfferBurnsFromEscrow() public {
        vm.prank(BUYER);
        uint256 offerId = market.makeOffer(address(nft), 1, 50 ether, uint64(vm.getBlockTimestamp() + 1 days), 50 ether);
        assertEq(market.escrowedNusd(), 50 ether, "ESCROWED");
        uint256 supplyBefore = nusd.totalSupply();

        vm.prank(SELLER);
        vm.expectRevert(NusdNftMarketplaceV2.InsufficientProceeds.selector);
        market.acceptOffer(offerId, 49.75 ether + 1);
        vm.prank(SELLER);
        market.acceptOffer(offerId, 49.75 ether);

        assertEq(market.escrowedNusd(), 0, "ESCROW_RELEASED");
        assertEq(market.credits(SELLER), 49.75 ether, "SELLER_PROCEEDS");
        assertEq(market.credits(CREATOR), 0.2 ether, "CREATOR_FEE");
        assertEq(supplyBefore - nusd.totalSupply(), 0.05 ether, "NOT_BURNED");
        _solvent();
    }

    function testRealNusdV2AndPixelV2SaleShrinksSupply() public {
        MockDIAFeed feed = new MockDIAFeed(18);
        feed.setRound(1, 50 ether, vm.getBlockTimestamp(), 1);
        OracleNUSDv2 realNusd = new OracleNUSDv2(
            IPriceOracle(address(new DIAOracleAdapter(address(feed), "Mock LTC/USD", 90 minutes, 1 ether, 1_000_000 ether))), address(this), 1_000_000 ether
        );
        ZeroXPixelV2 pixel = new ZeroXPixelV2();
        address[] memory collections = new address[](1);
        collections[0] = address(pixel);
        NusdNftMarketplaceV2 realMarket = new NusdNftMarketplaceV2(address(realNusd), address(this), collections);

        vm.prank(CREATOR);
        uint256 tokenId = pixel.mintPacked("NUSD art", "", 8, hex"000000ffffff");
        vm.prank(CREATOR);
        pixel.transferFrom(CREATOR, SELLER, tokenId);
        vm.prank(SELLER);
        pixel.approve(address(realMarket), tokenId);
        vm.prank(SELLER);
        uint256 listingId = realMarket.list(address(pixel), tokenId, 100 ether);

        vm.deal(BUYER, 2 ether);
        vm.prank(BUYER);
        realNusd.mintAtOracle{ value: 2 ether }(100 ether, BUYER);
        vm.prank(BUYER);
        realNusd.approve(address(realMarket), 100 ether);
        vm.prank(BUYER);
        realMarket.buy(listingId, 100 ether, 100 ether);

        assertEq(realNusd.totalSupply(), 99.9 ether, "REAL_SUPPLY_NOT_BURNED");
        assertEq(realMarket.credits(CREATOR), 0.4 ether, "REAL_CREATOR_FEE");
        assertEq(realMarket.credits(SELLER), 99.5 ether, "REAL_SELLER_PROCEEDS");
        assertEq(realNusd.balanceOf(address(realMarket)), 99.9 ether, "REAL_LIABILITIES");
        assertEq(pixel.ownerOf(tokenId), BUYER, "REAL_NFT_NOT_DELIVERED");
    }

    function testConstructorRejectsBadWiring() public {
        address[] memory none = new address[](0);
        vm.expectRevert(NusdNftMarketplaceV2.InvalidConfiguration.selector);
        new NusdNftMarketplaceV2(address(nusd), address(this), none);
        address[] memory collections = new address[](1);
        collections[0] = address(nft);
        vm.expectRevert(NusdNftMarketplaceV2.InvalidConfiguration.selector);
        new NusdNftMarketplaceV2(address(0xDEAD), address(this), collections);
    }

    /// price = seller proceeds + creator fee + burn; the burn leaves supply; every credit is backed.
    function testFuzzSaleConservesEveryNusd(uint256 rawPrice, bool withCreator) public {
        uint256 price = bound(rawPrice, 1, 1000 ether);
        nft.setRoyalties(withCreator, false);
        (uint256 burnAmount,, uint256 creatorFee, uint256 proceeds) = market.quoteSale(address(nft), 1, price);
        assertEq(burnAmount + creatorFee + proceeds, price, "QUOTE_SUM");
        assertEq(burnAmount, price / 1000, "BURN_RATE");
        assertEq(creatorFee, price * 4 / 1000, "CREATOR_RATE");

        uint256 supplyBefore = nusd.totalSupply();
        _buy(_list(price), price);
        assertEq(supplyBefore - nusd.totalSupply(), burnAmount, "SUPPLY_DELTA");
        assertEq(market.credits(SELLER) + market.credits(CREATOR), price - burnAmount, "CREDITS");
        _solvent();

        if (market.credits(SELLER) != 0) {
            vm.prank(SELLER);
            market.withdrawNusd(SELLER);
        }
        if (market.credits(CREATOR) != 0) {
            vm.prank(CREATOR);
            market.withdrawNusd(CREATOR);
        }
        _solvent();
        assertEq(nusd.balanceOf(address(market)), 0, "DUST_LEFT");
    }
}
