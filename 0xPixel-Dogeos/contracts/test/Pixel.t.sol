// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {DogeosPixel} from "../src/DogeosPixel.sol";
import {PixelMarket} from "../src/PixelMarket.sol";
interface Vm { function prank(address) external; function startPrank(address) external; function stopPrank() external; function deal(address,uint256) external; function warp(uint256) external; function expectRevert(bytes4) external; function expectRevert() external; }
contract RejectingBidder {
    PixelMarket public market;
    constructor(PixelMarket m) { market = m; }
    function offer(uint256 token, uint64 expiry) external payable { market.makeOffer{value:msg.value}(token,expiry); }
}
contract PixelTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DogeosPixel nft; PixelMarket market;
    address alice = address(0xA11CE); address bob = address(0xB0B); address carol = address(0xCA); address protocol = address(0xFEE);
    function setUp() public {
        vm.warp(1000); vm.deal(alice,1000 ether); vm.deal(bob,1000 ether); vm.deal(carol,1000 ether);
        nft = new DogeosPixel(); market = new PixelMarket(nft,protocol);
        vm.prank(alice); nft.mintPacked("Doge", "on-chain", 8, hex"000003f4c542");
    }
    function approveAlice() internal { vm.prank(alice); nft.approve(address(market),1); }
    function listAlice(uint256 price) internal { approveAlice(); vm.prank(alice); market.list(1,price,2000); }
    function testImmutableArtAndMetadata() public view {
        (string memory title,,uint256 grid,bytes memory pixels,address creator,,) = nft.tokenPackedData(1);
        require(keccak256(bytes(title))==keccak256("Doge") && grid==8 && creator==alice && pixels.length==6);
        require(bytes(nft.tokenURI(1)).length>400);
    }
    function testDuplicateRejected() public { vm.expectRevert(DogeosPixel.ArtworkAlreadyExists.selector); vm.prank(bob); nft.mintPacked("Copy","",8,hex"000003f4c542"); }
    function testNonCanonicalRejected() public { vm.expectRevert(DogeosPixel.NonCanonicalPixels.selector); vm.prank(alice); nft.mintPacked("Bad","",8,hex"000000ff0000010000ff0000"); }
    function testOutOfBoundsRejected() public { vm.expectRevert(DogeosPixel.PixelOutOfBounds.selector); vm.prank(alice); nft.mintPacked("Bad","",8,hex"070001ff0000"); }
    function testInvalidUTF8Rejected() public { bytes memory invalid=hex"c080"; vm.expectRevert(DogeosPixel.InvalidUTF8.selector); vm.prank(alice); nft.mintPacked(string(invalid),"",8,hex"000000ff0000"); }
    function testCollectionRequiresNFT() public { vm.expectRevert(DogeosPixel.MustOwnPixel.selector); vm.prank(bob); nft.createCollection("Fake",""); }
    function testCollectionOwnerControlsMembership() public {
        vm.prank(alice); uint256 id=nft.createCollection("Pack","Story");
        vm.prank(alice); nft.setTokenCollection(1,id); require(nft.tokenCollection(1)==id);
        vm.expectRevert(DogeosPixel.NotTokenOwner.selector); vm.prank(bob); nft.setTokenCollection(1,0);
        vm.expectRevert(DogeosPixel.NotCollectionOwner.selector); vm.prank(bob); nft.updateCollection(id,"fake","");
        vm.prank(alice); nft.updateCollection(id,"New","New story");
    }
    function testBuyerCanCreateOwnCollection() public {
        vm.prank(alice); nft.transferNFT(bob,1);
        vm.prank(bob); uint256 id=nft.createCollection("My pack","");
        vm.prank(bob); nft.setTokenCollection(1,id); require(nft.tokenCollection(1)==id);
    }
    function testCollectionCannotHijackOthers() public {
        vm.prank(alice); uint256 id=nft.createCollection("Pack","");
        vm.prank(alice); nft.transferNFT(bob,1);
        vm.expectRevert(DogeosPixel.NotCollectionOwner.selector); vm.prank(bob); nft.setTokenCollection(1,id);
    }
    function testCollectionNameBounds() public { vm.expectRevert(DogeosPixel.InvalidName.selector); vm.prank(alice); nft.createCollection("",""); }
    function testOwnerEnumerationAfterTransfer() public { vm.prank(alice); nft.transferNFT(bob,1); require(nft.tokensOfOwner(alice).length==0 && nft.tokensOfOwner(bob)[0]==1); }
    function testListRequiresApprovalAndOwner() public {
        vm.expectRevert(PixelMarket.ApprovalRequired.selector); vm.prank(alice); market.list(1,1 ether,2000);
        vm.expectRevert(PixelMarket.Unauthorized.selector); vm.prank(bob); market.list(1,1 ether,2000);
    }
    function testInvalidPriceAndExpiry() public {
        approveAlice(); vm.expectRevert(PixelMarket.InvalidTerms.selector); vm.prank(alice); market.list(1,0,2000);
        vm.expectRevert(PixelMarket.InvalidTerms.selector); vm.prank(alice); market.list(1,1,1000);
        vm.expectRevert(PixelMarket.InvalidTerms.selector); vm.prank(alice); market.list(1,1,type(uint64).max);
    }
    function testBuyAndPullPayments() public {
        listAlice(10 ether); vm.prank(bob); market.buy{value:10 ether}(1,1);
        require(nft.ownerOf(1)==bob && market.credits(alice)==9.9 ether && market.credits(protocol)==0.1 ether);
        require(market.totalCredits()==10 ether && !market.isListingActive(1));
        uint256 beforeBalance=alice.balance; vm.prank(alice); market.withdraw(payable(alice)); require(alice.balance==beforeBalance+9.9 ether);
    }
    function testSecondaryRoyalty() public {
        vm.prank(alice); nft.transferNFT(carol,1); vm.prank(carol); nft.approve(address(market),1);
        vm.prank(carol); market.list(1,10 ether,2000); vm.prank(bob); market.buy{value:10 ether}(1,1);
        require(market.credits(carol)==9.8 ether && market.credits(alice)==0.1 ether && market.credits(protocol)==0.1 ether);
    }
    function testPriceChangedCannotFillStaleQuote() public {
        listAlice(1 ether); vm.prank(alice); market.list(1,1 ether,2000);
        vm.expectRevert(PixelMarket.PriceChanged.selector); vm.prank(bob); market.buy{value:1 ether}(1,1);
        vm.expectRevert(PixelMarket.PriceChanged.selector); vm.prank(bob); market.buy{value:2 ether}(1,2);
    }
    function testRoundTripInvalidatesListing() public {
        listAlice(1 ether); vm.prank(alice); nft.transferNFT(bob,1); vm.prank(bob); nft.transferNFT(alice,1); approveAlice();
        require(!market.isListingActive(1)); vm.expectRevert(PixelMarket.ListingUnavailable.selector); vm.prank(bob); market.buy{value:1 ether}(1,1);
    }
    function testExpiryAndRevokedApproval() public {
        listAlice(1 ether); vm.prank(alice); nft.approve(address(0),1); require(!market.isListingActive(1));
        approveAlice(); vm.warp(2000); require(!market.isListingActive(1));
    }
    function testCancelListing() public { listAlice(1 ether); vm.prank(alice); market.cancelListing(1); require(!market.isListingActive(1)); }
    function testSelfBuyRejected() public { listAlice(1 ether); vm.expectRevert(PixelMarket.ListingUnavailable.selector); vm.prank(alice); market.buy{value:1 ether}(1,1); }
    function testEscrowOfferAccepted() public {
        listAlice(3 ether); vm.prank(bob); uint256 id=market.makeOffer{value:2 ether}(1,2000); require(market.totalOfferEscrow()==2 ether);
        vm.prank(alice); market.acceptOffer(id); require(nft.ownerOf(1)==bob && market.totalOfferEscrow()==0 && market.totalCredits()==2 ether && !market.isListingActive(1));
    }
    function testOfferCancellationAndExpiredRefund() public {
        vm.prank(bob); uint256 id=market.makeOffer{value:2 ether}(1,2000); vm.warp(2000);
        approveAlice(); vm.expectRevert(PixelMarket.OfferUnavailable.selector); vm.prank(alice); market.acceptOffer(id);
        vm.prank(bob); market.cancelOffer(id); require(market.credits(bob)==2 ether && market.totalOfferEscrow()==0);
        vm.prank(bob); market.withdraw(payable(bob)); require(address(market).balance==0);
    }
    function testUnauthorizedOfferCancelAndAccept() public {
        vm.prank(bob); uint256 id=market.makeOffer{value:2 ether}(1,2000);
        vm.expectRevert(PixelMarket.Unauthorized.selector); vm.prank(carol); market.cancelOffer(id);
        vm.expectRevert(PixelMarket.Unauthorized.selector); vm.prank(carol); market.acceptOffer(id);
    }
    function testReceiverRejectionRollsBackEscrowAndSale() public {
        RejectingBidder bidder=new RejectingBidder(market); vm.deal(address(this),2 ether); bidder.offer{value:2 ether}(1,2000); approveAlice();
        vm.expectRevert(); vm.prank(alice); market.acceptOffer(1);
        require(nft.ownerOf(1)==alice && market.totalOfferEscrow()==2 ether && market.totalCredits()==0);
    }
    function testFuzzConservation(uint96 amount) public {
        uint256 price=uint256(amount)+1; vm.deal(bob,price); listAlice(price); vm.prank(bob); market.buy{value:price}(1,1);
        require(market.credits(alice)+market.credits(protocol)==price && market.totalCredits()+market.totalOfferEscrow()==address(market).balance);
    }
}
