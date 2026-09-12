// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HashSig} from "../../src/libs/HashSig.sol";

/// Thin ABI wrapper around HashSig internals so forge unit tests can drive them.
contract HashSigHarness {
    function W_BITS() external pure returns (uint256) {
        return HashSig.W_BITS;
    }

    function RADIX() external pure returns (uint256) {
        return HashSig.RADIX;
    }

    function LEN1() external pure returns (uint256) {
        return HashSig.LEN1;
    }

    function LEN2() external pure returns (uint256) {
        return HashSig.LEN2;
    }

    function LEN() external pure returns (uint256) {
        return HashSig.LEN;
    }

    function TREE_H() external pure returns (uint256) {
        return HashSig.TREE_H;
    }

    function TREE_N() external pure returns (uint256) {
        return HashSig.TREE_N;
    }

    function chainStep(bytes32 x, uint8 j) external pure returns (bytes32) {
        return HashSig.chainStep(x, j);
    }

    function chain(bytes32 x, uint8 j, uint256 steps) external pure returns (bytes32) {
        return HashSig.chain(x, j, steps);
    }

    function publicElement(bytes32 secret, uint8 j) external pure returns (bytes32) {
        return HashSig.publicElement(secret, j);
    }

    function signElement(bytes32 secret, uint8 j, uint8 d) external pure returns (bytes32) {
        return HashSig.signElement(secret, j, d);
    }

    function messageDigits(uint256 digest) external pure returns (uint256[64] memory out) {
        uint256[64] memory d = HashSig.messageDigits(digest);
        for (uint256 j = 0; j < 64; ++j) out[j] = d[j];
    }

    function checksumOf(uint256[64] calldata md) external pure returns (uint8[3] memory out) {
        uint8[3] memory c = HashSig.checksumDigits(md);
        for (uint256 j = 0; j < 3; ++j) out[j] = c[j];
    }

    function leafFromSignature(bytes32 digest, bytes32[] calldata sig) external pure returns (bytes32) {
        return HashSig.leafFromSignature(digest, sig);
    }

    function computeRoot(bytes32 leaf, uint256 leafIndex, bytes32[] calldata path) external pure returns (bytes32) {
        return HashSig.computeRoot(leaf, leafIndex, path);
    }
}
