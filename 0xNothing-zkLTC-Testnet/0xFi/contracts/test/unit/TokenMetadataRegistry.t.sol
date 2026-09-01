// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TokenMetadataRegistry } from "../../src/metadata/TokenMetadataRegistry.sol";
import { TestBase } from "../helpers/TestBase.sol";
import {
    LongOwnerReturnTokenMock,
    NonCanonicalOwnerReturnTokenMock,
    NonOwnableTokenMock,
    OwnableTokenMock,
    RevertingOwnerTokenMock,
    ShortOwnerReturnTokenMock
} from "../mocks/TokenMetadataMocks.sol";

contract TokenMetadataRegistryTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CORE_NUSD = address(0x1001);
    address private constant CORE_WZKLTC = address(0x1002);

    TokenMetadataRegistry private registry;

    function setUp() public {
        vm.warp(1_000_000);
        address[] memory protectedTokens = new address[](2);
        protectedTokens[0] = CORE_NUSD;
        protectedTokens[1] = CORE_WZKLTC;
        registry = new TokenMetadataRegistry(protectedTokens);
    }

    function testRegisterImageExactlyOnceAndEnumeratesRecord() public {
        OwnableTokenMock token = new OwnableTokenMock(ALICE);
        string memory uri = "ipfs://bafybeigdyrzt/image.png";

        vm.prank(ALICE);
        uint256 registrationId = registry.registerImage(address(token), uri);

        assertEq(registrationId, 0, "first registration id");
        assertEq(registry.registrationCount(), 1, "one registration");
        assertEq(registry.registeredToken(0), address(token), "token enumerated");
        assertEq(keccak256(bytes(registry.imageURI(address(token)))), keccak256(bytes(uri)), "image lookup");

        TokenMetadataRegistry.ImageRecord memory record = registry.imageRecord(address(token));
        assertEq(record.registrant, ALICE, "registrant recorded");
        assertEq(uint256(record.registeredAt), block.timestamp, "timestamp recorded");
        assertEq(keccak256(bytes(record.imageURI)), keccak256(bytes(uri)), "uri recorded");

        vm.expectRevert(abi.encodeWithSelector(TokenMetadataRegistry.AlreadyRegistered.selector, address(token)));
        vm.prank(ALICE);
        registry.registerImage(address(token), "https://gateway.pinata.cloud/ipfs/replacement");
    }

    function testRegistrationStaysImmutableAfterOwnershipTransfer() public {
        OwnableTokenMock token = new OwnableTokenMock(ALICE);
        vm.prank(ALICE);
        token.transferOwnership(BOB);

        vm.prank(BOB);
        registry.registerImage(address(token), "https://gateway.pinata.cloud/ipfs/original");

        vm.prank(BOB);
        token.transferOwnership(ALICE);
        vm.expectRevert(abi.encodeWithSelector(TokenMetadataRegistry.AlreadyRegistered.selector, address(token)));
        vm.prank(ALICE);
        registry.registerImage(address(token), "ipfs://replacement");
    }

    function testConstructorRejectsZeroAndDuplicateProtectedTokens() public {
        address[] memory zeroProtected = new address[](1);
        vm.expectRevert(TokenMetadataRegistry.ZeroToken.selector);
        new TokenMetadataRegistry(zeroProtected);

        address[] memory duplicateProtected = new address[](2);
        duplicateProtected[0] = CORE_NUSD;
        duplicateProtected[1] = CORE_NUSD;
        vm.expectRevert(abi.encodeWithSelector(TokenMetadataRegistry.DuplicateProtectedToken.selector, CORE_NUSD));
        new TokenMetadataRegistry(duplicateProtected);
    }

    function testProtectedTokensArePermanentAndEnumerable() public {
        assertTrue(registry.isProtectedToken(CORE_NUSD), "NUSD protected");
        assertTrue(registry.isProtectedToken(CORE_WZKLTC), "wrapped native protected");
        assertEq(registry.protectedTokenCount(), 2, "protected count");
        assertEq(registry.protectedToken(0), CORE_NUSD, "first protected token");
        assertEq(registry.protectedToken(1), CORE_WZKLTC, "second protected token");

        vm.expectRevert(TokenMetadataRegistry.TokenNotContract.selector);
        vm.prank(ALICE);
        registry.registerImage(CORE_NUSD, "ipfs://core");
    }

    function testProtectedContractTokenIsRejected() public {
        OwnableTokenMock protectedToken = new OwnableTokenMock(ALICE);
        address[] memory protectedTokens = new address[](1);
        protectedTokens[0] = address(protectedToken);
        TokenMetadataRegistry localRegistry = new TokenMetadataRegistry(protectedTokens);

        vm.expectRevert(abi.encodeWithSelector(TokenMetadataRegistry.ProtectedToken.selector, address(protectedToken)));
        vm.prank(ALICE);
        localRegistry.registerImage(address(protectedToken), "ipfs://core");
    }

    function testNonContractAndUnsupportedOwnershipAreRejected() public {
        vm.expectRevert(TokenMetadataRegistry.TokenNotContract.selector);
        vm.prank(ALICE);
        registry.registerImage(ALICE, "ipfs://image");

        NonOwnableTokenMock nonOwnable = new NonOwnableTokenMock();
        vm.expectRevert(TokenMetadataRegistry.UnsupportedOwnership.selector);
        vm.prank(ALICE);
        registry.registerImage(address(nonOwnable), "ipfs://image");

        RevertingOwnerTokenMock revertingOwner = new RevertingOwnerTokenMock();
        vm.expectRevert(TokenMetadataRegistry.UnsupportedOwnership.selector);
        vm.prank(ALICE);
        registry.registerImage(address(revertingOwner), "ipfs://image");
    }

    function testMalformedOwnerResponsesAreRejected() public {
        ShortOwnerReturnTokenMock shortReturn = new ShortOwnerReturnTokenMock();
        vm.expectRevert(TokenMetadataRegistry.UnsupportedOwnership.selector);
        vm.prank(ALICE);
        registry.registerImage(address(shortReturn), "ipfs://image");

        LongOwnerReturnTokenMock longReturn = new LongOwnerReturnTokenMock();
        vm.expectRevert(TokenMetadataRegistry.UnsupportedOwnership.selector);
        vm.prank(ALICE);
        registry.registerImage(address(longReturn), "ipfs://image");

        NonCanonicalOwnerReturnTokenMock nonCanonical = new NonCanonicalOwnerReturnTokenMock();
        vm.expectRevert(TokenMetadataRegistry.UnsupportedOwnership.selector);
        vm.prank(ALICE);
        registry.registerImage(address(nonCanonical), "ipfs://image");
    }

    function testRenouncedOwnershipAndWrongCallerAreRejected() public {
        OwnableTokenMock renounced = new OwnableTokenMock(address(0));
        vm.expectRevert(TokenMetadataRegistry.RenouncedOwnership.selector);
        vm.prank(ALICE);
        registry.registerImage(address(renounced), "ipfs://image");

        OwnableTokenMock token = new OwnableTokenMock(ALICE);
        vm.expectRevert(TokenMetadataRegistry.NotTokenOwner.selector);
        vm.prank(BOB);
        registry.registerImage(address(token), "ipfs://image");
    }

    function testValidHttpsUriIsAccepted() public {
        OwnableTokenMock token = new OwnableTokenMock(ALICE);
        string memory uri = "https://gateway.pinata.cloud/ipfs/bafy-valid";
        vm.prank(ALICE);
        registry.registerImage(address(token), uri);
        assertEq(keccak256(bytes(registry.imageURI(address(token)))), keccak256(bytes(uri)), "https uri stored");
    }

    function testInvalidUriSchemesAndEmptyPathsAreRejected() public {
        _expectInvalidUri("");
        _expectInvalidUri("ipfs://");
        _expectInvalidUri("https://");
        _expectInvalidUri("http://example.com/image.png");
        _expectInvalidUri("ftp://example.com/image.png");
        _expectInvalidUri("IPFS://bafy-case-sensitive");
        _expectInvalidUri("ipfs://bafy path");
        _expectInvalidUri("https://example.com/image\n.png");
    }

    function testOversizedUriIsRejectedAtBound() public {
        OwnableTokenMock acceptedToken = new OwnableTokenMock(ALICE);
        string memory accepted = _uriOfLength(registry.MAX_IMAGE_URI_LENGTH());
        vm.prank(ALICE);
        registry.registerImage(address(acceptedToken), accepted);

        OwnableTokenMock rejectedToken = new OwnableTokenMock(ALICE);
        string memory oversized = _uriOfLength(registry.MAX_IMAGE_URI_LENGTH() + 1);
        vm.expectRevert(TokenMetadataRegistry.InvalidImageURI.selector);
        vm.prank(ALICE);
        registry.registerImage(address(rejectedToken), oversized);
    }

    function _expectInvalidUri(string memory uri) private {
        OwnableTokenMock token = new OwnableTokenMock(ALICE);
        vm.expectRevert(TokenMetadataRegistry.InvalidImageURI.selector);
        vm.prank(ALICE);
        registry.registerImage(address(token), uri);
    }

    function _uriOfLength(uint256 length) private pure returns (string memory) {
        bytes memory value = new bytes(length);
        bytes memory prefix = bytes("ipfs://");
        for (uint256 i; i < prefix.length; ++i) {
            value[i] = prefix[i];
        }
        for (uint256 i = prefix.length; i < length; ++i) {
            value[i] = "a";
        }
        return string(value);
    }
}
