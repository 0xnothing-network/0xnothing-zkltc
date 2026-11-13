// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {ZeroXPixelV2} from "../../src/0xpixel/ZeroXPixelV2.sol";

/// Finding E-02 of the 2026-11 audit (docs/AUDIT_2026-11.md), accepted and documented: a mint is
/// identified by its pixels alone and costs nothing, so whoever gets the same pixels included
/// first owns the token and is its creator for good. It needs sight of a pending transaction,
/// which a chain ordered by one sequencer does not give outsiders. The test pins the behaviour.
contract AuditPixelTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant MALLORY = address(0xBAD);

    function testAudit_E02_firstMintOfTheSamePixelsWinsForGood() public {
        ZeroXPixelV2 pixel = new ZeroXPixelV2();
        bytes memory pixels = hex"000000ff0000";

        // Mallory copies the calldata of Alice's pending mint and lands first.
        vm.prank(MALLORY);
        uint256 id = pixel.mintPacked("copy", "", 8, pixels);

        vm.prank(ALICE);
        vm.expectRevert(ZeroXPixelV2.ArtworkAlreadyExists.selector);
        pixel.mintPacked("Sunset", "", 8, pixels);

        (address receiver,) = pixel.royaltyInfo(id, 100 ether);
        assertEq(pixel.ownerOf(id), MALLORY, "the copier owns the token");
        assertEq(receiver, MALLORY, "and is the creator the marketplace pays 0.4% of every sale");
    }
}
