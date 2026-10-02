// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DogeosPixel} from "../src/DogeosPixel.sol";
import {PixelMarket} from "../src/PixelMarket.sol";
import {PixelRenderer} from "../src/PixelRenderer.sol";
import {PixelBase64} from "../src/PixelBase64.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

interface AuditVm {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
}

contract CodecHarness {
    function encode(bytes memory data) external pure returns (string memory result) {
        bytes32 original = keccak256(data);
        result = PixelBase64.encode(data);
        require(keccak256(data) == original, "encoder mutated input");
        // Verify scratch/free-memory changes cannot corrupt a subsequent allocation.
        string memory second = PixelBase64.encode(data);
        require(keccak256(bytes(result)) == keccak256(bytes(second)), "memory corrupted");
    }

    function baseline(bytes memory data) external pure returns (string memory) { return Base64.encode(data); }
    function render(bytes memory data, uint256 grid) external pure returns (string memory) { return PixelRenderer.svg(data, grid); }
    function legacy(bytes memory data) external pure returns (string memory) { return PixelRenderer.legacyHex(data); }
    function escape(string memory data) external pure returns (string memory) { return PixelRenderer.escapeJSON(data); }
}

/// @dev Exercises callbacks with fully initialized art/enumeration, blocked nested
/// mint/market actions, and a legitimate onward transfer by the new NFT owner.
contract CallbackReceiver is IERC721Receiver {
    DogeosPixel immutable nft;
    PixelMarket immutable market;
    bool immutable reject;
    address immutable forwardTo;
    bool public mintBlocked;
    bool public marketBlocked;
    bool public metadataReady;

    constructor(DogeosPixel n, PixelMarket m, bool r, address forward) {
        nft = n; market = m; reject = r; forwardTo = forward;
    }

    function mint(bytes calldata pixels) external { nft.mintPacked("Receiver", "", 8, pixels); }
    function buy(uint256 id, uint256 quote) external payable { market.buy{value:msg.value}(id, quote); }
    function bid(uint256 id) external payable { market.makeOffer{value:msg.value}(id, uint64(block.timestamp + 1000)); }

    function onERC721Received(address, address from, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(nft), "unexpected callback");
        metadataReady = nft.ownerOf(id) == address(this) && nft.tokensOfOwner(address(this)).length == 1 && bytes(nft.tokenURI(id)).length > 0;
        if (from == address(0)) {
            try nft.mintPacked("Nested", "", 8, hex"010000123456") { mintBlocked = false; }
            catch (bytes memory reason) {
                bytes4 selector;
                assembly { selector := mload(add(reason, 32)) }
                mintBlocked = selector == DogeosPixel.ReentrantCall.selector;
            }
        } else {
            try market.makeOffer{value:1}(id, uint64(block.timestamp + 1000)) { marketBlocked = false; }
            catch (bytes memory reason) {
                bytes4 selector;
                assembly { selector := mload(add(reason, 32)) }
                marketBlocked = selector == bytes4(keccak256("ReentrancyGuardReentrantCall()"));
            }
        }
        if (forwardTo != address(0)) nft.transferNFT(forwardTo, id);
        return reject ? bytes4(0) : IERC721Receiver.onERC721Received.selector;
    }
    receive() external payable {}
}

contract ForcedValue {
    constructor(address payable target) payable { selfdestruct(target); }
}

contract ContractAuditTest {
    event log_named_uint(string key, uint256 value);
    AuditVm constant vm = AuditVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant alice = address(0xA11CE);
    address constant bob = address(0xB0B);
    address constant carol = address(0xCA);
    address constant protocol = address(0xFEE);
    DogeosPixel nft;
    PixelMarket market;
    CodecHarness codec;

    function setUp() public {
        vm.warp(1000);
        vm.deal(alice, 1000 ether); vm.deal(bob, 1000 ether); vm.deal(carol, 1000 ether); vm.deal(address(this), 100 ether);
        nft = new DogeosPixel(); market = new PixelMarket(nft, protocol); codec = new CodecHarness();
        vm.prank(alice); nft.mintPacked("First", "", 8, hex"000000f4c542");
    }

    function _list(uint256 price) private {
        vm.prank(alice); nft.approve(address(market), 1);
        vm.prank(alice); market.list(1, price, 2000);
    }

    function _assertOwner(address owner, uint256 id, uint256 length) private view {
        require(nft.ownerOf(id) == owner && nft.balanceOf(owner) == length, "owner/balance mismatch");
        uint256[] memory tokens = nft.tokensOfOwner(owner);
        require(tokens.length == length, "enumeration count mismatch");
        for (uint256 i; i < tokens.length; ++i) require(nft.ownerOf(tokens[i]) == owner && nft.userTokenIndex(tokens[i]) == i, "enumeration index mismatch");
    }

    function testSelfTransferClearsApprovalWithoutNonceOrEnumerationChange() public {
        uint256 nonce = nft.ownershipNonce(1);
        vm.prank(alice); nft.approve(bob, 1);
        vm.prank(bob); nft.transferFrom(alice, alice, 1);
        require(nft.getApproved(1) == address(0) && nft.ownershipNonce(1) == nonce, "self transfer state");
        _assertOwner(alice, 1, 1);
    }

    function testOperatorCanApproveAndTransferButSingleApprovalCannotReapprove() public {
        vm.prank(alice); nft.approve(bob, 1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidApprover.selector, bob)); vm.prank(bob); nft.approve(carol, 1);
        vm.prank(alice); nft.setApprovalForAll(bob, true);
        vm.prank(bob); nft.approve(carol, 1);
        vm.prank(carol); nft.transferFrom(alice, bob, 1);
        require(nft.getApproved(1) == address(0), "approval survived ownership change");
        _assertOwner(bob, 1, 1);
    }

    function testIncorrectFromAndZeroReceiverRollBackAllState() public {
        uint256 nonce = nft.ownershipNonce(1);
        vm.prank(alice); nft.approve(bob, 1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, carol, 1, alice)); vm.prank(bob); nft.transferFrom(carol, bob, 1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0))); vm.prank(alice); nft.transferNFT(address(0), 1);
        require(nft.getApproved(1) == bob && nft.ownershipNonce(1) == nonce, "failed transfer changed state");
        _assertOwner(alice, 1, 1);
    }

    function testSwapPopEnumerationUpdatesMovedIndex() public {
        vm.prank(alice); nft.mintPacked("Second", "", 8, hex"010000f4c542");
        vm.prank(alice); nft.mintPacked("Third", "", 8, hex"020000f4c542");
        vm.prank(alice); nft.transferNFT(bob, 2);
        uint256[] memory owned = nft.tokensOfOwner(alice);
        require(owned[0] == 1 && owned[1] == 3 && nft.userTokenIndex(3) == 1, "swap/pop failed");
        vm.prank(alice); nft.transferNFT(bob, 3);
        _assertOwner(alice, 1, 1); _assertOwner(bob, 2, 2);
    }

    function testMintCallbackSeesMetadataAndBlocksReentrancy() public {
        CallbackReceiver receiver = new CallbackReceiver(nft, market, false, bob);
        receiver.mint(hex"030000f4c542");
        require(receiver.metadataReady() && receiver.mintBlocked(), "mint callback state");
        require(nft.totalSupply() == 2 && nft.ownershipNonce(2) == 2, "nested mint/forward nonce");
        _assertOwner(bob, 2, 1);
    }

    function testRejectingMintRollsBackRegistrySupplyAndEnumeration() public {
        CallbackReceiver receiver = new CallbackReceiver(nft, market, true, address(0));
        bytes memory pixels = hex"030000f4c542";
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(receiver))); receiver.mint(pixels);
        require(nft.totalSupply() == 1 && nft.checkOriginalPacked(pixels, 8), "failed mint retained artwork");
        require(nft.balanceOf(address(receiver)) == 0 && nft.tokensOfOwner(address(receiver)).length == 0, "failed mint retained owner");
    }

    function testBuyCallbackBlocksMarketReentryAndAllowsOwnerForwarding() public {
        _list(1 ether);
        CallbackReceiver receiver = new CallbackReceiver(nft, market, false, bob);
        vm.deal(address(receiver), 1);
        receiver.buy{value:1 ether}(1, 1);
        require(receiver.marketBlocked() && receiver.metadataReady(), "sale callback guard");
        require(nft.ownerOf(1) == bob && nft.ownershipNonce(1) == 3, "onward transfer lost");
        require(market.totalCredits() == 1 ether && address(market).balance == 1 ether, "sale accounting");
    }

    function testRejectingBuyRollsBackListingCreditsNonceAndPayment() public {
        _list(1 ether);
        CallbackReceiver receiver = new CallbackReceiver(nft, market, true, address(0));
        uint256 nonce = nft.ownershipNonce(1);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(receiver))); receiver.buy{value:1 ether}(1, 1);
        require(nft.ownerOf(1) == alice && nft.ownershipNonce(1) == nonce && nft.getApproved(1) == address(market), "failed buy transfer state");
        require(market.isListingActive(1) && market.totalCredits() == 0 && address(market).balance == 0, "failed buy funds/listing");
    }

    function testCollectionMembershipPersistsButOnlyBuyerCanRemoveAfterSale() public {
        vm.prank(alice); uint256 collection = nft.createCollection("Pack", "");
        vm.prank(alice); nft.setTokenCollection(1, collection);
        _list(1 ether); vm.prank(bob); market.buy{value:1 ether}(1, 1);
        require(nft.tokenCollection(1) == collection, "collection provenance lost");
        vm.expectRevert(DogeosPixel.NotTokenOwner.selector); vm.prank(alice); nft.setTokenCollection(1, 0);
        vm.prank(bob); nft.setTokenCollection(1, 0);
        // Collection authority belongs to its creator even after their last NFT sale.
        vm.prank(alice); nft.updateCollection(collection, "Renamed", "");
        require(nft.tokenCollection(1) == 0, "buyer could not remove membership");
    }

    function testOfferCanBeAcceptedByNewOwnerAndUnrelatedEscrowSurvives() public {
        vm.prank(bob); uint256 first = market.makeOffer{value:2 ether}(1, 2000);
        vm.prank(carol); uint256 second = market.makeOffer{value:3 ether}(1, 2000);
        vm.prank(alice); nft.transferNFT(carol, 1);
        vm.prank(carol); nft.approve(address(market), 1);
        vm.prank(carol); market.acceptOffer(first);
        require(market.totalOfferEscrow() == 3 ether && market.totalCredits() == 2 ether, "other offer changed");
        vm.prank(carol); market.cancelOffer(second);
        require(market.credits(carol) == 4.96 ether && market.totalOfferEscrow() == 0, "refund/secondary payout wrong");
        require(market.totalCredits() == 5 ether && address(market).balance == 5 ether, "mixed liability conservation");
    }

    function testDurationBoundaryAndExactExpiryRefund() public {
        vm.prank(alice); nft.approve(address(market), 1);
        uint64 maxExpiry = uint64(block.timestamp + market.MAX_DURATION());
        vm.prank(alice); market.list(1, 1, maxExpiry);
        vm.expectRevert(PixelMarket.InvalidTerms.selector); vm.prank(alice); market.list(1, 1, maxExpiry + 1);
        vm.prank(bob); uint256 offer = market.makeOffer{value:1}(1, maxExpiry);
        vm.warp(maxExpiry);
        require(!market.isListingActive(1), "deadline listing active");
        vm.expectRevert(PixelMarket.OfferUnavailable.selector); vm.prank(alice); market.acceptOffer(offer);
        vm.prank(bob); market.cancelOffer(offer);
        require(market.credits(bob) == 1, "expired offer not refundable");
    }

    function testZeroWithdrawalRecipientAndForcedValuePreserveSolvency() public {
        vm.prank(bob); uint256 offer = market.makeOffer{value:1 ether}(1, 2000);
        vm.prank(bob); market.cancelOffer(offer);
        vm.expectRevert(PixelMarket.InvalidTerms.selector); vm.prank(bob); market.withdraw(payable(address(0)));
        require(market.credits(bob) == 1 ether, "zero recipient destroyed credit");
        new ForcedValue{value:123}(payable(address(market)));
        vm.prank(bob); market.withdraw(payable(carol));
        require(market.totalCredits() == 0 && market.totalOfferEscrow() == 0 && address(market).balance == 123, "forced value affected liabilities");
    }

    function testAliasedCreatorSellerAndFeeRecipientCreditsDoNotLoseRoundingDust() public {
        PixelMarket aliased = new PixelMarket(nft, alice);
        vm.prank(alice); nft.approve(address(aliased), 1);
        vm.prank(alice); aliased.list(1, 199, 2000);
        vm.prank(bob); aliased.buy{value:199}(1, 1);
        require(aliased.credits(alice) == 199 && aliased.totalCredits() == 199, "aliased payout incorrect");
    }

    function testRoyaltyAtMaximumUintAndInterfaceIds() public view {
        (address creator, uint256 amount) = nft.royaltyInfo(1, type(uint256).max);
        require(creator == alice && amount == type(uint256).max / 100, "royalty overflow/rounding");
        require(nft.supportsInterface(0x01ffc9a7) && nft.supportsInterface(0x80ac58cd) && nft.supportsInterface(0x5b5e139f) && nft.supportsInterface(0x2a55205a), "missing standard interface");
        require(!nft.supportsInterface(0xffffffff) && !nft.supportsInterface(0x780e9d63), "unsupported enumeration claimed");
    }

    function testUTF8BoundarySequencesAndJSONControlEscaping() public {
        bytes[12] memory invalid = [bytes(hex"80"),hex"c080",hex"c1bf",hex"c2",hex"e08080",hex"eda080",hex"f0808080",hex"f4908080",hex"f5808080",hex"e282",hex"e24180",hex"ff"];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(DogeosPixel.InvalidUTF8.selector); vm.prank(alice);
            nft.mintPacked(string(invalid[i]), "", 8, hex"010000123456");
        }
        vm.prank(alice); nft.mintPacked(string(hex"c280e0a080ed9fbff0908080f48fbfbf"), string(hex"00221f5c"), 8, hex"010000123456");
        require(keccak256(bytes(codec.escape(string(hex"00221f5c")))) == keccak256(bytes('\\u0000\\"\\u001f\\\\')), "JSON control escape");
    }

    function testMetadataByteLimitsAndUnknownTokenReads() public {
        vm.expectRevert(DogeosPixel.InvalidName.selector); vm.prank(alice); nft.mintPacked("", "", 8, hex"010000123456");
        vm.expectRevert(DogeosPixel.InvalidName.selector); vm.prank(alice); nft.mintPacked(string(new bytes(65)), "", 8, hex"010000123456");
        vm.expectRevert(DogeosPixel.InvalidDescription.selector); vm.prank(alice); nft.mintPacked("Valid", string(new bytes(1025)), 8, hex"010000123456");
        vm.prank(alice); nft.mintPacked(string(new bytes(64)), string(new bytes(1024)), 8, hex"010000123456");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99)); nft.tokenURI(99);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99)); nft.tokenPackedData(99);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99)); market.makeOffer{value:1}(99, 2000);
    }

    function testCanonicalRunsRejectOverlapUnsortedAndUnmergedColor() public {
        bytes[4] memory invalid = [bytes(hex"010100ff0000000100ffffff"),hex"000001ff0000010000ffffff",hex"000000ff0000010000ff0000",hex"000100ff0000000000ffffff"];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(DogeosPixel.NonCanonicalPixels.selector); nft.checkOriginalPacked(invalid[i], 8);
        }
        vm.expectRevert(DogeosPixel.InvalidPixels.selector); nft.checkOriginalPacked(hex"00", 8);
        vm.expectRevert(DogeosPixel.InvalidPixels.selector); nft.checkOriginalPacked(hex"", 8);
        vm.expectRevert(DogeosPixel.InvalidGrid.selector); nft.checkOriginalPacked(hex"000000ffffff", 7);
        vm.expectRevert(DogeosPixel.PixelOutOfBounds.selector); nft.checkOriginalPacked(hex"0100ffffffff", 256);
        require(nft.checkOriginalPacked(hex"000000ff000001000000ff00", 8), "adjacent distinct colors rejected");
    }

    function testFullWidth256RunLegacySplitAndGridHashIsolation() public {
        bytes memory run = hex"0000ffabcdef";
        vm.prank(alice); uint256 id = nft.mintPacked("Full row", "", 256, run);
        (,,string memory legacy,,,) = nft.tokenData(id);
        require(keccak256(bytes(legacy)) == keccak256("0x0000ffabcdefff0001abcdef"), "legacy 256 split");
        require(nft.getCreatorPacked(run, 256) == alice && !nft.checkOriginalPacked(run, 256), "registry lookup");
        require(nft.getCreatorPacked(hex"000000abcdef", 8) == address(0), "unminted creator");
        vm.prank(alice); nft.mintPacked("Dimension A", "", 8, hex"000000abcdef");
        require(nft.checkOriginalPacked(hex"000000abcdef", 16), "grid omitted from art hash");
    }

    function testMaximumRunsStorageSplitReadAndMetadataRemainBounded() public {
        bytes memory pixels = new bytes(nft.MAX_PACKED_DATA_LENGTH());
        for (uint256 i; i < 4096; ++i) {
            uint256 at = i * 6;
            pixels[at] = bytes1(uint8((i % 16) * 16)); pixels[at + 1] = bytes1(uint8(i / 16));
            pixels[at + 2] = bytes1(uint8(15));
            pixels[at + 3] = bytes1(uint8(i >> 16)); pixels[at + 4] = bytes1(uint8(i >> 8)); pixels[at + 5] = bytes1(uint8(i));
        }
        uint256 mintStart = gasleft();
        vm.prank(alice); uint256 id = nft.mintPacked("Maximum runs", "", 256, pixels);
        uint256 mintGas = mintStart - gasleft();
        (,,,bytes memory stored,,,) = nft.tokenPackedData(id);
        require(keccak256(stored) == keccak256(pixels), "code storage split lost bytes");
        uint256 uriStart = gasleft();
        string memory uri = nft.tokenURI(id);
        uint256 uriGas = uriStart - gasleft();
        require(bytes(uri).length > 200_000, "large metadata missing");
        require(mintGas < 10_000_000 && uriGas < 35_000_000, "bounded artwork gas regressed");
        emit log_named_uint("4096-run mint gas", mintGas);
        emit log_named_uint("4096-run tokenURI gas", uriGas);
        emit log_named_uint("4096-run tokenURI bytes", bytes(uri).length);
        vm.expectRevert(DogeosPixel.InvalidPixels.selector); nft.checkOriginalPacked(bytes.concat(pixels, hex"001000ffffff"), 256);
    }

    function testBase64KnownVectorsAndOptimizedPathBoundary() public view {
        require(keccak256(bytes(codec.encode(hex""))) == keccak256(""), "empty Base64");
        require(keccak256(bytes(codec.encode("f"))) == keccak256("Zg=="), "one byte padding");
        require(keccak256(bytes(codec.encode("fo"))) == keccak256("Zm8="), "two byte padding");
        require(keccak256(bytes(codec.encode("foo"))) == keccak256("Zm9v"), "three bytes");
        uint256[7] memory lengths = [uint256(16383), 16384, 16385, 16386, 16400, 16416, 32768];
        for (uint256 j; j < lengths.length; ++j) {
            bytes memory data = new bytes(lengths[j]);
            for (uint256 i; i < data.length; ++i) data[i] = bytes1(uint8(i * 197 + 43));
            require(keccak256(bytes(codec.encode(data))) == keccak256(bytes(codec.baseline(data))), "optimized Base64 differs from reference");
        }
    }

    function testFuzzBase64PreservesInput(bytes memory data) public view {
        if (data.length > 512) return;
        require(keccak256(bytes(codec.encode(data))) == keccak256(bytes(codec.baseline(data))), "Base64 fuzz reference");
    }

    function testLargeBase64LookupCoversEvery12BitTableEntry() public view {
        bytes memory data = new bytes(24576);
        for (uint256 i; i < 8192; ++i) {
            uint256 index = i % 4096;
            uint256 pair = (index << 12) | (4095 - index);
            data[i * 3] = bytes1(uint8(pair >> 16));
            data[i * 3 + 1] = bytes1(uint8(pair >> 8));
            data[i * 3 + 2] = bytes1(uint8(pair));
        }
        require(keccak256(bytes(codec.encode(data))) == keccak256(bytes(codec.baseline(data))), "12-bit table entry mismatch");
    }

    function testFuzzRendererMatchesIndependentSVG(uint8 gridSeed, uint8 row, uint8 start, uint8 width, uint24 color) public view {
        uint256 grid = uint256(8) << (gridSeed % 6);
        uint256 x = uint256(start) % grid;
        uint256 y = uint256(row) % grid;
        uint256 count = uint256(width) % (grid - x) + 1;
        bytes memory pixels = abi.encodePacked(bytes1(uint8(x)), bytes1(uint8(y)), bytes1(uint8(count - 1)), bytes3(color));
        string memory dimension = Strings.toString(grid);
        string memory expected = string(abi.encodePacked('<svg xmlns="http://www.w3.org/2000/svg" width="', dimension, '" height="', dimension, '" viewBox="0 0 ', dimension, " ", dimension, '" shape-rendering="crispEdges"><path fill="#', _hexColor(color), '" d="M', Strings.toString(x), " ", Strings.toString(y), "h", Strings.toString(count), "v1h-", Strings.toString(count), 'z"/></svg>'));
        require(keccak256(bytes(codec.render(pixels, grid))) == keccak256(bytes(expected)), "SVG mismatch");
    }

    function _hexColor(uint24 color) private pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory result = new bytes(6);
        for (uint256 i; i < 6; ++i) result[5 - i] = digits[(uint256(color) >> (i * 4)) & 15];
        return string(result);
    }

    function testFuzzSecondarySaleAndUnrelatedOfferConserveWei(uint128 saleSeed, uint128 offerSeed) public {
        uint256 salePrice = uint256(saleSeed) % 100 ether + 1;
        uint256 offerValue = uint256(offerSeed) % 100 ether + 1;
        vm.prank(alice); nft.transferNFT(carol, 1);
        vm.prank(carol); nft.approve(address(market), 1);
        vm.prank(carol); market.list(1, salePrice, 2000);
        vm.prank(bob); uint256 offer = market.makeOffer{value:offerValue}(1, 2000);
        vm.prank(bob); market.buy{value:salePrice}(1, 1);
        uint256 share = salePrice / 100;
        require(market.credits(alice) == share && market.credits(protocol) == share && market.credits(carol) == salePrice - 2 * share, "secondary rounding");
        require(market.totalCredits() + market.totalOfferEscrow() == address(market).balance, "escrow before refund");
        vm.prank(bob); market.cancelOffer(offer);
        require(market.credits(bob) == offerValue && market.totalOfferEscrow() == 0, "offer refund after becoming owner");
        require(market.totalCredits() == salePrice + offerValue, "combined payout conservation");
    }
}
