// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {ZeroXPixelV2} from "../src/0xpixel/ZeroXPixelV2.sol";
import {PixelData} from "../src/0xpixel/PixelData.sol";
import {PixelRenderer} from "../src/0xpixel/PixelRenderer.sol";
import {PixelBase64} from "../src/0xpixel/PixelBase64.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface PixelVm {
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
}

contract PixelStorageHarness {
    function write(bytes calldata data) external returns (address first, address second) { return PixelData.write(data); }
    function read(address first, address second, uint256 length) external view returns (bytes memory) {
        return PixelData.read(first, second, length);
    }
}

contract PixelReceiver is IERC721Receiver {
    ZeroXPixelV2 public immutable nft;
    address public immutable forwardTo;
    bool public reentryRejected;

    constructor(ZeroXPixelV2 token, address recipient) { nft = token; forwardTo = recipient; }

    function mint(bytes calldata pixels) external returns (uint256) {
        return nft.mintPacked("receiver", "", 8, pixels);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        try nft.mintPacked("nested", "", 8, hex"010100ffffff") returns (uint256) {
            revert("reentrant mint succeeded");
        } catch (bytes memory errorData) {
            bytes4 selector;
            assembly ("memory-safe") { selector := mload(add(errorData, 0x20)) }
            reentryRejected = selector == ZeroXPixelV2.ReentrantCall.selector;
        }
        if (forwardTo != address(0)) nft.transferFrom(address(this), forwardTo, id);
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract PixelNonReceiver {
    function mint(ZeroXPixelV2 nft) external { nft.mintPacked("unsafe", "", 8, hex"000000ff0000"); }
}

contract ZeroXPixelV2Test is TestBase, IERC721Receiver {
    ZeroXPixelV2 private nft;
    address private constant ALICE = address(0xa11ce);
    address private constant BOB = address(0xb0b);
    PixelVm private constant jsonVm = PixelVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event log_named_uint(string key, uint256 value);

    function setUp() public { nft = new ZeroXPixelV2(); }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function testAllGridsAndPackedRoundTrip() public {
        uint256[6] memory grids = [uint256(8), 16, 32, 64, 128, 256];
        for (uint256 i; i < grids.length; ++i) {
            bytes memory data = abi.encodePacked(uint8(0), uint8(grids[i] - 1), uint8(grids[i] - 1), hex"ff00a5");
            vm.prank(ALICE);
            uint256 id = nft.mintPacked(unicode"Bức tranh", unicode"Điểm ảnh", grids[i], data);
            (string memory name, string memory description, uint256 grid, bytes memory actual,
                address creator, uint256 mintedAt, bytes32 hash) = nft.tokenPackedData(id);
            assertEq(keccak256(bytes(name)), keccak256(bytes(unicode"Bức tranh")), "unicode name");
            assertEq(keccak256(bytes(description)), keccak256(bytes(unicode"Điểm ảnh")), "unicode description");
            assertEq(grid, grids[i], "grid preserved");
            assertEq(keccak256(actual), keccak256(data), "packed bytes preserved");
            assertEq(creator, ALICE, "creator preserved");
            assertEq(mintedAt, block.timestamp, "timestamp preserved");
            assertEq(hash, keccak256(abi.encodePacked(uint16(grid), data)), "canonical hash");
            assertFalse(nft.checkOriginalPacked(data, grid), "registered artwork");
            assertEq(nft.getCreatorPacked(data, grid), ALICE, "creator lookup");
        }
        assertEq(nft.totalSupply(), 6, "six grids minted");
    }

    function test256WideRunHasLegacyCompatibilityAndExactSVG() public {
        uint256 id = nft.mintPacked("wide", "transparent canvas", 256, hex"00ffffff1234");
        (, uint256 grid, string memory legacy,,,) = nft.tokenData(id);
        assertEq(grid, 256, "grid does not truncate to zero");
        assertEq(keccak256(bytes(legacy)), keccak256(bytes("0x00ffffff1234ffff01ff1234")), "256 row splits into 255 plus 1");
        string memory svg = _image(_json(id));
        assertTrue(_contains(bytes(svg), bytes('<path fill="#ff1234" d="M0 255h256v1h-256z"/>')), "256 wide SVG exact");
    }

    function testCoordinates255AndMetadataJSON() public {
        string memory name = string(abi.encodePacked(unicode"Ảnh", bytes1(0), '\"', "\\", bytes1(uint8(10))));
        string memory description = string(abi.encodePacked(unicode"Mô tả", bytes1(uint8(31)), "/"));
        uint256 id = nft.mintPacked(name, description, 256, hex"ffff00abcdef");
        string memory json = _json(id);
        assertEq(keccak256(bytes(jsonVm.parseJsonString(json, ".name"))), keccak256(bytes(name)), "name JSON roundtrip");
        assertEq(keccak256(bytes(jsonVm.parseJsonString(json, ".description"))), keccak256(bytes(description)), "description JSON roundtrip");
        assertEq(jsonVm.parseJsonUint(json, ".attributes[0].value"), 256, "metadata grid");
        assertEq(jsonVm.parseJsonUint(json, ".attributes[3].value"), 1, "metadata run count");
        assertEq(jsonVm.parseJsonUint(json, ".attributes[4].value"), 2, "metadata version");
        string memory svg = _image(json);
        assertTrue(_contains(bytes(svg), bytes('<path fill="#abcdef" d="M255 255h1v1h-1z"/>')), "boundary pixel SVG");
        assertFalse(_contains(bytes(svg), bytes("background")), "transparent unpainted background");
    }

    function testDescriptionAndNameLimits() public {
        vm.expectRevert(ZeroXPixelV2.InvalidName.selector);
        nft.mintPacked("", "", 8, hex"000000ffffff");
        vm.expectRevert(ZeroXPixelV2.InvalidName.selector);
        nft.mintPacked(string(new bytes(65)), "", 8, hex"000000ffffff");
        vm.expectRevert(ZeroXPixelV2.InvalidDescription.selector);
        nft.mintPacked("name", string(new bytes(1025)), 8, hex"000000ffffff");
        uint256 id = nft.mintPacked(string(new bytes(64)), string(new bytes(1024)), 8, hex"000000ffffff");
        assertGt(bytes(nft.tokenURI(id)).length, 0, "escaped max metadata renders");
    }

    function testInvalidUTF8Rejected() public {
        bytes[9] memory invalid = [bytes(hex"80"), hex"c080", hex"c1bf", hex"c2", hex"e08080", hex"eda080", hex"f0808080", hex"f4908080", hex"f5808080"];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(ZeroXPixelV2.InvalidUTF8.selector);
            nft.mintPacked(string(invalid[i]), "", 8, hex"000000ffffff");
            vm.expectRevert(ZeroXPixelV2.InvalidUTF8.selector);
            nft.mintPacked("valid", string(invalid[i]), 8, hex"000000ffffff");
        }
    }

    function testValidUTF8Boundaries() public {
        bytes memory valid = hex"c280dfbfe0a080ed9fbfee8080efbfbff0908080f48fbfbf";
        uint256 id = nft.mintPacked(string(valid), string(valid), 8, hex"000000ffffff");
        assertEq(keccak256(bytes(jsonVm.parseJsonString(_json(id), ".name"))), keccak256(valid), "valid UTF8 boundaries");
    }

    function testInvalidGridAndPayload() public {
        uint256[8] memory grids = [uint256(0), 1, 4, 9, 63, 65, 255, 257];
        for (uint256 i; i < grids.length; ++i) {
            vm.expectRevert(ZeroXPixelV2.InvalidGrid.selector);
            nft.mintPacked("invalid", "", grids[i], hex"000000ffffff");
        }
        vm.expectRevert(ZeroXPixelV2.InvalidPixels.selector);
        nft.mintPacked("empty", "", 8, "");
        vm.expectRevert(ZeroXPixelV2.InvalidPixels.selector);
        nft.mintPacked("short", "", 8, hex"000000ffff");
        vm.expectRevert(ZeroXPixelV2.InvalidPixels.selector);
        nft.mintPacked("too many", "", 256, new bytes(4097 * 6));
        vm.expectRevert(ZeroXPixelV2.PixelOutOfBounds.selector);
        nft.mintPacked("x out", "", 8, hex"080000ffffff");
        vm.expectRevert(ZeroXPixelV2.PixelOutOfBounds.selector);
        nft.mintPacked("y out", "", 8, hex"000800ffffff");
        vm.expectRevert(ZeroXPixelV2.PixelOutOfBounds.selector);
        nft.mintPacked("run out", "", 256, hex"01ffffff0000");
    }

    function testNonCanonicalEncodingsRejected() public {
        bytes[5] memory invalid = [
            bytes(hex"000001ff0000010000ff0000"), // overlapping
            hex"010000ff000000000000ff00", // backwards x
            hex"000100ff000000000000ff00", // backwards row
            hex"000000ff0000010000ff0000", // adjacent same color must merge
            hex"000000ff000000000000ff00" // same cell twice
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(ZeroXPixelV2.NonCanonicalPixels.selector);
            nft.mintPacked("bad", "", 8, invalid[i]);
        }
        nft.mintPacked("gap valid", "", 8, hex"000000ff0000020000ff0000");
        nft.mintPacked("different colors valid", "", 8, hex"000000ff000001000000ff00");
        nft.mintPacked("next row valid", "", 8, hex"000000ff0000000100ff0000");
    }

    function testDuplicateArtworkCannotChangeNameOrDescription() public {
        bytes memory pixels = hex"000000ffffff";
        vm.prank(ALICE);
        nft.mintPacked("original", "original description", 8, pixels);
        vm.prank(BOB);
        vm.expectRevert(ZeroXPixelV2.ArtworkAlreadyExists.selector);
        nft.mintPacked("rename", "new description", 8, pixels);
        assertTrue(nft.checkOriginalPacked(pixels, 16), "grid is part of hash");
        vm.prank(BOB);
        nft.mintPacked("larger", "", 16, pixels);
    }

    function testTransfersApprovalsEnumerationAndImmutableCreator() public {
        vm.startPrank(ALICE);
        uint256 first = nft.mintPacked("first", "", 8, hex"000000ffffff");
        uint256 second = nft.mintPacked("second", "", 8, hex"010000ffffff");
        nft.approve(BOB, first);
        vm.stopPrank();
        vm.prank(BOB);
        nft.transferFrom(ALICE, BOB, first);
        assertEq(nft.getApproved(first), address(0), "approval cleared");
        assertEq(nft.userTokens(ALICE, 0), second, "swap-remove owner list");
        assertEq(nft.userTokenIndex(second), 0, "swapped index");
        assertEq(nft.userTokens(BOB, 0), first, "recipient list");
        vm.prank(BOB);
        nft.transferFrom(BOB, BOB, first);
        assertEq(nft.tokensOfOwner(BOB).length, 1, "self transfer doesn't duplicate");
        assertEq(nft.balanceOf(BOB), 1, "self transfer balance");
        (address creator, uint256 royalty) = nft.royaltyInfo(first, 12_345);
        assertEq(creator, ALICE, "creator survives transfer");
        assertEq(royalty, 123, "one percent round down");
        vm.prank(ALICE);
        nft.setApprovalForAll(BOB, true);
        vm.prank(BOB);
        nft.safeTransferFrom(ALICE, BOB, second);
        assertEq(nft.tokensOfOwner(ALICE).length, 0, "all transferred");
        assertEq(nft.tokensOfOwner(BOB).length, 2, "operator transfer enumerated");
    }

    function testUnauthorizedAndUnsafeTransfersRevert() public {
        vm.prank(ALICE);
        uint256 id = nft.mintPacked("first", "", 8, hex"000000ffffff");
        vm.prank(BOB);
        vm.expectRevert();
        nft.transferFrom(ALICE, BOB, id);
        vm.prank(ALICE);
        vm.expectRevert();
        nft.transferFrom(ALICE, address(0), id);
        PixelNonReceiver recipient = new PixelNonReceiver();
        vm.prank(ALICE);
        vm.expectRevert();
        nft.safeTransferFrom(ALICE, address(recipient), id);
        assertEq(nft.ownerOf(id), ALICE, "failed transfer rolled back");
        assertEq(nft.userTokens(ALICE, 0), id, "failed transfer enumeration rolled back");
    }

    function testSafeMintReceiverReentryAndForwarding() public {
        PixelReceiver recipient = new PixelReceiver(nft, ALICE);
        uint256 id = recipient.mint(hex"000000ffffff");
        assertTrue(recipient.reentryRejected(), "reentrant mint blocked");
        assertEq(nft.totalSupply(), 1, "single mint");
        assertEq(nft.ownerOf(id), ALICE, "receiver can forward safely");
        assertEq(nft.tokensOfOwner(address(recipient)).length, 0, "receiver enumeration cleared");
        assertEq(nft.userTokens(ALICE, 0), id, "forward recipient enumeration");
        (address creator,) = nft.royaltyInfo(id, 100);
        assertEq(creator, address(recipient), "creator immutable after callback transfer");
    }

    function testUnsafeMintIsAtomic() public {
        PixelNonReceiver recipient = new PixelNonReceiver();
        vm.expectRevert();
        recipient.mint(nft);
        assertEq(nft.totalSupply(), 0, "unsafe mint rollback");
        assertTrue(nft.checkOriginalPacked(hex"000000ff0000", 8), "registry rollback");
    }

    function testSupportedInterfacesAndMissingTokenReads() public {
        assertTrue(nft.supportsInterface(0x01ffc9a7), "ERC165");
        assertTrue(nft.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(nft.supportsInterface(0x5b5e139f), "ERC721 metadata");
        assertTrue(nft.supportsInterface(0x2a55205a), "ERC2981");
        assertFalse(nft.supportsInterface(0xffffffff), "invalid interface");
        vm.expectRevert(); nft.tokenData(1);
        vm.expectRevert(); nft.tokenPackedData(1);
        vm.expectRevert(); nft.tokenURI(1);
        vm.expectRevert(); nft.royaltyInfo(1, 100);
    }

    function testRoyaltyDoesNotOverflowAtMaximumSalePrice() public {
        uint256 id = nft.mintPacked("royalty", "", 8, hex"000000ffffff");
        (, uint256 amount) = nft.royaltyInfo(id, type(uint256).max);
        assertEq(amount, type(uint256).max / 100, "max sale price royalty");
    }

    function testCodeBlobChunkBoundaryAndStopSafety() public {
        PixelStorageHarness store = new PixelStorageHarness();
        bytes memory data = _checkerboard();
        (address first, address second) = store.write(data);
        assertEq(first.code.length, 24_571, "first code size below EIP170");
        assertEq(second.code.length, 7, "second code size");
        assertEq(keccak256(store.read(first, second, data.length)), keccak256(data), "chunk concatenation");
        (bool ok, bytes memory returned) = first.call(hex"ffffffff");
        assertTrue(ok, "blob begins STOP");
        assertEq(returned.length, 0, "payload cannot execute");
        bytes memory oneChunk = new bytes(24_570);
        (first, second) = store.write(oneChunk);
        assertEq(first.code.length, 24_571, "largest single aligned chunk");
        assertEq(second, address(0), "second unnecessary");
    }

    function testMaximumRunsMetadataGasAndContractCodeSize() public {
        bytes memory pixels = _checkerboard();
        uint256 before = gasleft();
        uint256 id = nft.mintPacked("4096 runs", "bounded full complexity", 64, pixels);
        uint256 mintGas = before - gasleft();
        before = gasleft();
        string memory uri = nft.tokenURI(id);
        uint256 metadataGas = before - gasleft();
        emit log_named_uint("4096-run mint gas", mintGas);
        emit log_named_uint("4096-run tokenURI gas", metadataGas);
        emit log_named_uint("4096-run tokenURI bytes", bytes(uri).length);
        emit log_named_uint("runtime code bytes", address(nft).code.length);
        string memory json = string(Base64.decode(string(_slice(bytes(uri), 29))));
        assertEq(jsonVm.parseJsonUint(json, ".attributes[3].value"), 4096, "all runs rendered");
        bytes memory svg = bytes(_image(json));
        assertEq(_occurrences(svg, bytes("<path ")), 4096, "SVG includes every run");
        assertEq(keccak256(_slice(svg, svg.length - 6)), keccak256(bytes("</svg>")), "SVG terminates");
        assertLe(mintGas, 12_000_000, "bounded mint gas");
        assertLe(metadataGas, 30_000_000, "bounded metadata call gas");
        assertLe(address(nft).code.length, 24_576, "deployable runtime size");
    }

    function testBase64VectorsAndTransparentRendering() public pure {
        assertEq(keccak256(bytes(PixelBase64.encode(""))), keccak256(bytes("")), "empty Base64");
        assertEq(keccak256(bytes(PixelBase64.encode("f"))), keccak256(bytes("Zg==")), "one Base64");
        assertEq(keccak256(bytes(PixelBase64.encode("fo"))), keccak256(bytes("Zm8=")), "two Base64");
        assertEq(keccak256(bytes(PixelBase64.encode("foo"))), keccak256(bytes("Zm9v")), "three Base64");
        assertEq(keccak256(bytes(PixelRenderer.toString(0))), keccak256(bytes("0")), "zero decimal");
    }

    function testRendererAndBase64GasProfile() public {
        bytes memory pixels = _checkerboard();
        uint256 before = gasleft();
        string memory svg = PixelRenderer.svg(pixels, 64);
        emit log_named_uint("SVG generation gas", before - gasleft());
        emit log_named_uint("SVG bytes", bytes(svg).length);
        before = gasleft();
        string memory image = PixelBase64.encode(bytes(svg));
        emit log_named_uint("SVG Base64 gas", before - gasleft());
        before = gasleft();
        string memory uri = PixelBase64.encode(bytes(image));
        emit log_named_uint("second Base64 gas", before - gasleft());
        assertGt(bytes(uri).length, 0, "profile output exists");
    }

    function testBase64MatchesOpenZeppelinAtAllPaddingBoundaries() public pure {
        for (uint256 length; length < 100; ++length) {
            bytes memory input = new bytes(length);
            for (uint256 i; i < length; ++i) input[i] = bytes1(uint8(i * 17 + length));
            bytes32 before = keccak256(input);
            string memory actual = PixelBase64.encode(input);
            assertEq(keccak256(bytes(actual)), keccak256(bytes(Base64.encode(input))), "reference Base64 equality");
            assertEq(keccak256(input), before, "encoder restores input tail");
        }
    }

    function testBase64AllPairLookupKeysAndLargeTailBoundaries() public pure {
        bytes memory input = new bytes(24_576);
        for (uint256 key; key < 4096; ++key) {
            uint24 word = uint24((key << 12) | (4095 - key));
            for (uint256 repeat; repeat < 2; ++repeat) {
                uint256 at = key * 6 + repeat * 3;
                input[at] = bytes1(uint8(word >> 16));
                input[at + 1] = bytes1(uint8(word >> 8));
                input[at + 2] = bytes1(uint8(word));
            }
        }
        _assertBase64(input);
        // Threshold, input-word alignment, 24-byte batching and all padding cases.
        for (uint256 length = 16_383; length < 16_433; ++length) {
            _assertBase64(_patternedBytes(length, bytes32(type(uint256).max)));
        }
    }

    function testBase64DirtyScratchAndRepeatedEncoding() public pure {
        bytes memory input = _patternedBytes(16_387, keccak256("dirty scratch"));
        string memory actual = PixelBase64.encode(input);
        assertEq(keccak256(bytes(PixelBase64.encode(""))), keccak256(bytes("")), "empty after nonempty");
        bytes32 unrelated = keccak256(abi.encodePacked(actual, input));
        assertTrue(unrelated != bytes32(0), "intervening operations");
        assertEq(keccak256(bytes(PixelBase64.encode(input))), keccak256(bytes(actual)), "repeat after dirty scratch");
        assertEq(keccak256(bytes(PixelBase64.encode("f"))), keccak256(bytes("Zg==")), "small after large");
    }

    function testFuzzBase64Differential(bytes32 seed, uint16 lengthSeed) public pure {
        uint256 length = 16_384 + uint256(lengthSeed) % 512;
        _assertBase64(_patternedBytes(length, seed));
    }

    function testMaximum256RunsMetadataGasAndContractCodeSize() public {
        bytes memory pixels = _full256Grid();
        uint256 before = gasleft();
        uint256 id = nft.mintPacked("256x256 max", "4096 width-16 blocks", 256, pixels);
        uint256 mintGas = before - gasleft();
        before = gasleft();
        string memory uri = nft.tokenURI(id);
        uint256 metadataGas = before - gasleft();
        emit log_named_uint("256-grid 4096-run mint gas", mintGas);
        emit log_named_uint("256-grid 4096-run tokenURI gas", metadataGas);
        emit log_named_uint("256-grid 4096-run tokenURI bytes", bytes(uri).length);
        emit log_named_uint("runtime code bytes", address(nft).code.length);
        string memory json = string(Base64.decode(string(_slice(bytes(uri), 29))));
        assertEq(jsonVm.parseJsonUint(json, ".attributes[0].value"), 256, "max grid metadata");
        assertEq(jsonVm.parseJsonUint(json, ".attributes[3].value"), 4096, "max run metadata");
        bytes memory svg = bytes(_image(json));
        assertEq(_occurrences(svg, bytes("<path ")), 4096, "every max-grid path rendered");
        assertTrue(_contains(svg, bytes('<path fill="#f0ff80" d="M240 255h16v1h-16z"/>')), "last block exact");
        assertLe(mintGas, 12_000_000, "bounded max grid mint gas");
        assertLe(metadataGas, 30_000_000, "bounded max grid URI gas");
        assertLe(address(nft).code.length, 24_576, "max grid runtime size");
    }

    function testMaximum256ArtworkWithMaximumEscapedMetadata() public {
        uint256 id = nft.mintPacked(string(new bytes(64)), string(new bytes(1024)), 256, _full256Grid());
        uint256 before = gasleft();
        string memory uri = nft.tokenURI(id);
        uint256 metadataGas = before - gasleft();
        emit log_named_uint("max artwork and escaped metadata tokenURI gas", metadataGas);
        emit log_named_uint("max artwork and escaped metadata tokenURI bytes", bytes(uri).length);
        string memory json = string(Base64.decode(string(_slice(bytes(uri), 29))));
        assertEq(bytes(jsonVm.parseJsonString(json, ".name")).length, 64, "all name controls decode");
        assertEq(bytes(jsonVm.parseJsonString(json, ".description")).length, 1024, "all description controls decode");
        assertEq(jsonVm.parseJsonUint(json, ".attributes[3].value"), 4096, "all runs in max metadata");
        assertLe(metadataGas, 35_000_000, "escaped worst case comfortably below 50m RPC cap");
    }

    function testFuzzPackedSingleRunRoundTrip(uint8 xSeed, uint8 ySeed, uint8 countSeed, bytes3 color) public {
        uint256 x = uint256(xSeed) % 64;
        uint256 y = uint256(ySeed) % 64;
        uint256 count = uint256(countSeed) % (64 - x) + 1;
        bytes memory pixels = abi.encodePacked(uint8(x), uint8(y), uint8(count - 1), color);
        vm.prank(ALICE);
        uint256 id = nft.mintPacked("fuzz", "", 64, pixels);
        (,,, bytes memory actual,,,) = nft.tokenPackedData(id);
        assertEq(keccak256(actual), keccak256(pixels), "roundtrip single run");
        assertGt(bytes(nft.tokenURI(id)).length, 29, "metadata renders");
    }

    function _checkerboard() private pure returns (bytes memory data) {
        data = new bytes(4096 * 6);
        for (uint256 i; i < 4096; ++i) {
            uint256 at = i * 6;
            data[at] = bytes1(uint8(i % 64));
            data[at + 1] = bytes1(uint8(i / 64));
            data[at + 3] = bytes1(uint8((i + i / 64) % 2 == 0 ? 255 : 0));
        }
    }

    function _full256Grid() private pure returns (bytes memory pixels) {
        pixels = new bytes(4096 * 6);
        for (uint256 i; i < 4096; ++i) {
            uint256 at = i * 6;
            uint8 x = uint8((i % 16) * 16);
            uint8 y = uint8(i / 16);
            pixels[at] = bytes1(x);
            pixels[at + 1] = bytes1(y);
            pixels[at + 2] = 0x0f;
            pixels[at + 3] = bytes1(x);
            pixels[at + 4] = bytes1(y);
            pixels[at + 5] = 0x80;
        }
    }

    function _assertBase64(bytes memory input) private pure {
        bytes32 before = keccak256(input);
        string memory actual = PixelBase64.encode(input);
        assertEq(keccak256(bytes(actual)), keccak256(bytes(Base64.encode(input))), "reference Base64 equality");
        assertEq(keccak256(Base64.decode(actual)), before, "reference Base64 roundtrip");
        assertEq(keccak256(input), before, "input restored");
    }

    function _patternedBytes(uint256 length, bytes32 seed) private pure returns (bytes memory data) {
        data = new bytes(length);
        assembly ("memory-safe") {
            let destination := add(data, 0x20)
            let end := add(destination, length)
            for {} lt(destination, end) { destination := add(destination, 0x20) } {
                mstore(destination, seed)
            }
        }
    }

    function _json(uint256 id) private view returns (string memory) {
        return string(Base64.decode(string(_slice(bytes(nft.tokenURI(id)), 29))));
    }

    function _image(string memory json) private pure returns (string memory) {
        return string(Base64.decode(string(_slice(bytes(jsonVm.parseJsonString(json, ".image")), 26))));
    }

    function _slice(bytes memory input, uint256 offset) private pure returns (bytes memory output) {
        output = new bytes(input.length - offset);
        for (uint256 i; i < output.length; ++i) output[i] = input[i + offset];
    }

    function _contains(bytes memory input, bytes memory pattern) private pure returns (bool) {
        return _occurrences(input, pattern) > 0;
    }

    function _occurrences(bytes memory input, bytes memory pattern) private pure returns (uint256 count) {
        if (pattern.length > input.length) return 0;
        for (uint256 i; i <= input.length - pattern.length; ++i) {
            bool matches = true;
            for (uint256 j; j < pattern.length; ++j) {
                if (input[i + j] != pattern[j]) { matches = false; break; }
            }
            if (matches) ++count;
        }
    }
}
