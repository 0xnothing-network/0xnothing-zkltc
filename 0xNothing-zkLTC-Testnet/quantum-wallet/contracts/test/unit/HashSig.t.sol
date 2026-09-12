// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {HashSig} from "../../src/libs/HashSig.sol";
import {HashSigHarness} from "./HashSigHarness.sol";

/// Pure-library property tests. The genuine end-to-end proof (valid signatures
/// accepted, forged rejected, leaves/epochs enforced) lives in QuantumWallet.t.sol
/// and the cross-language agreement lives in the SDK-generated vectors.
contract HashSigTest is TestBase {
    HashSigHarness internal h;

    function setUp() public {
        h = new HashSigHarness();
    }

    /// Independent reference implementation of one chain application.
    function _refStep(bytes32 x, uint8 j) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint8(0x71), j, x));
    }

    function _refChain(bytes32 x, uint8 j, uint256 steps) internal pure returns (bytes32) {
        for (uint256 i = 0; i < steps; ++i) x = _refStep(x, j);
        return x;
    }

    // --- parameter sanity ------------------------------------------------------

    function test_constants() public {
        assertEq(h.W_BITS(), 4, "w bits");
        assertEq(h.RADIX(), 16, "radix");
        assertEq(h.LEN1(), 64, "len1");
        assertEq(h.LEN2(), 3, "len2");
        assertEq(h.LEN(), 67, "len");
        assertEq(h.TREE_H(), 10, "tree height");
        assertEq(h.TREE_N(), 1024, "tree nodes");
        // 3 checksum digits must cover 64*15 = 960 (< 16^3 = 4096).
        assertTrue(h.LEN2() == 3 && 64 * 15 < 4096, "checksum width sufficient");
    }

    function testFuzz_chain_matchesReference(bytes32 x, uint8 j, uint8 steps) public {
        steps = uint8(bound(steps, 0, 15));
        assertEq(h.chain(x, j, steps), _refChain(x, j, steps), "chain matches reference loop");
    }

    function test_chain_over_15_reverts(bytes32 x, uint8 j) public {
        vm.expectRevert(HashSig.InvalidChainSteps.selector);
        h.chain(x, j, 16);
    }

    // --- WOTS sign/verify relation ----------------------------------------------

    /// The exact algebraic identity a verifier relies on: pk = F^(15-d)(sig) up to
    /// d further applications. i.e. verify(sig) == pk for the right digit.
    function testFuzz_signVerify_identity(bytes32 sk, uint8 j, uint8 d) public {
        d = uint8(bound(d, 0, 15));
        bytes32 pk = h.publicElement(sk, j);
        assertEq(pk, _refChain(sk, j, 15), "publicElement == 15 chain steps");
        bytes32 sig = h.signElement(sk, j, d);
        assertEq(sig, _refChain(sk, j, 15 - uint256(d)), "signElement == chain(15-d)");
        // Forward the signature by its digit: must recover the public element.
        assertEq(h.chain(sig, j, d), pk, "verification identity");
    }

    function testFuzz_differentDigits_differentElements(bytes32 sk, uint8 j, uint8 a, uint8 b) public {
        a = uint8(bound(a, 0, 15));
        b = uint8(bound(b, 0, 15));
        vm.assume(a != b);
        assertTrue(h.signElement(sk, j, a) != h.signElement(sk, j, b), "digit collision in sign elements");
    }

    // --- nibble extraction -------------------------------------------------------

    function test_messageDigits_are_bigEndianNibbles() public {
        bytes32 digest = keccak256("nibble-check");
        uint256 d = uint256(digest);
        uint256[64] memory got = h.messageDigits(d);
        for (uint256 j = 0; j < 64; ++j) {
            uint256 want = (d >> (252 - 4 * j)) & 0xF;
            assertEq(got[j], want, "nibble j mismatch");
        }
    }

    // --- Merkle path ---------------------------------------------------------------

    /// Build a synthetic 1024-leaf tree (independent of WOTS) and check that
    /// computeRoot(leaf, index, path) returns the tree root.
    function testFuzz_computeRoot_recoversTreeRoot(uint256 seedIdx) public {
        seedIdx = bound(seedIdx, 0, HashSig.TREE_N - 1);
        uint256 n = HashSig.TREE_N;

        // levels[l][k]; level 0 = leaves.
        bytes32[][] memory levels = new bytes32[][](HashSig.TREE_H + 1);
        bytes32[] memory cur = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) cur[i] = keccak256(abi.encodePacked("leaf", i));
        levels[0] = cur;
        for (uint256 l = 1; l <= HashSig.TREE_H; ++l) {
            bytes32[] memory next = new bytes32[](cur.length / 2);
            for (uint256 k = 0; k < next.length; ++k) {
                next[k] = keccak256(abi.encodePacked(cur[2 * k], cur[2 * k + 1]));
            }
            levels[l] = next;
            cur = next;
        }
        bytes32 root = levels[HashSig.TREE_H][0];

        // Assemble the auth path for seedIdx.
        bytes32[] memory path = new bytes32[](HashSig.TREE_H);
        for (uint256 l = 0; l < HashSig.TREE_H; ++l) {
            uint256 node = seedIdx >> l;
            path[l] = levels[l][node ^ 1];
        }

        bytes32 leaf = levels[0][seedIdx];
        assertEq(h.computeRoot(leaf, seedIdx, path), root, "path proves leaf to root");

        // Tamper one path element: must no longer equal the root.
        path[3] = keccak256("tampered");
        assertTrue(h.computeRoot(leaf, seedIdx, path) != root, "tampered path rejected");
    }

    function test_wrongPathLength_reverts(bytes32 leaf, uint256 idx) public {
        bytes32[] memory path = new bytes32[](4);
        // error WrongPathLength(uint256 got, uint256 want) — parameterised errors
        // must be matched against the full encoding, not the selector alone.
        vm.expectRevert(abi.encodeWithSelector(HashSig.WrongPathLength.selector, 4, HashSig.TREE_H));
        h.computeRoot(leaf, idx, path);
    }

    function test_wrongSigLength_reverts(bytes32 digest) public {
        bytes32[] memory sig = new bytes32[](66);
        vm.expectRevert(abi.encodeWithSelector(HashSig.WrongSignatureLength.selector, 66, HashSig.LEN));
        h.leafFromSignature(digest, sig);
    }
}
