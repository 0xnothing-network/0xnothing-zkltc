// SPDX-License-Identifier: MIT
/*
Copyright (c) 2022-2026 Solady

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
pragma solidity ^0.8.24;

/// @notice Standard padded RFC 4648 Base64 encoding.
/// @dev Encoder adapted from Solady's MIT Base64.encode(data, false, false).
/// Source: https://github.com/Vectorized/solady/blob/main/src/utils/Base64.sol
/// @author Solady (Vectorized), modified from Solmate and Brecht Devos.
/// License notice: contracts/THIRD_PARTY_NOTICES.md.
library PixelBase64 {
    function encode(bytes memory data) internal pure returns (string memory result) {
        if (data.length >= 16_384) return _encodeLarge(data);
        assembly ("memory-safe") {
            let length := mload(data)
            if length {
                let encodedLength := shl(2, div(add(length, 2), 3))
                result := mload(0x40)
                mstore(0x1f, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")
                mstore(0x3f, "ghijklmnopqrstuvwxyz0123456789+/")
                let pointer := add(result, 0x20)
                let end := add(pointer, encodedLength)
                let dataEnd := add(add(data, 0x20), length)
                let dataEndValue := mload(dataEnd)
                mstore(dataEnd, 0)
                for {} 1 {} {
                    data := add(data, 3)
                    let input := mload(data)
                    mstore8(0, mload(and(shr(18, input), 0x3f)))
                    mstore8(1, mload(and(shr(12, input), 0x3f)))
                    mstore8(2, mload(and(shr(6, input), 0x3f)))
                    mstore8(3, mload(and(input, 0x3f)))
                    mstore(pointer, mload(0))
                    pointer := add(pointer, 4)
                    if iszero(lt(pointer, end)) { break }
                }
                mstore(dataEnd, dataEndValue)
                mstore(0x40, add(end, 0x20))
                let padding := div(2, mod(length, 3))
                mstore(sub(pointer, padding), shl(240, 0x3d3d))
                mstore(pointer, 0)
                mstore(result, encodedLength)
            }
        }
    }

    /// @dev Large artwork metadata amortizes a 12-bit -> two-character lookup.
    /// Each complete 24-byte input block becomes one 32-byte output store.
    function _encodeLarge(bytes memory data) private pure returns (string memory result) {
        assembly ("memory-safe") {
            function block24(input, table) -> encoded {
                encoded := and(mload(add(table, shl(1, and(shr(244, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)
                encoded := or(encoded, shr(16, and(mload(add(table, shl(1, and(shr(232, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(32, and(mload(add(table, shl(1, and(shr(220, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(48, and(mload(add(table, shl(1, and(shr(208, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(64, and(mload(add(table, shl(1, and(shr(196, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(80, and(mload(add(table, shl(1, and(shr(184, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(96, and(mload(add(table, shl(1, and(shr(172, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(112, and(mload(add(table, shl(1, and(shr(160, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(128, and(mload(add(table, shl(1, and(shr(148, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(144, and(mload(add(table, shl(1, and(shr(136, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(160, and(mload(add(table, shl(1, and(shr(124, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(176, and(mload(add(table, shl(1, and(shr(112, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(192, and(mload(add(table, shl(1, and(shr(100, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(208, and(mload(add(table, shl(1, and(shr(88, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(224, and(mload(add(table, shl(1, and(shr(76, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
                encoded := or(encoded, shr(240, and(mload(add(table, shl(1, and(shr(64, input), 0xfff)))), 0xffff000000000000000000000000000000000000000000000000000000000000)))
            }
            let length := mload(data)
            let encodedLength := shl(2, div(add(length, 2), 3))
            // A guard word keeps temporary input-tail zeroing away from the table.
            let table := add(mload(0x40), 0x20)
            result := add(table, 0x2000)
            mstore(0x1f, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef")
            mstore(0x3f, "ghijklmnopqrstuvwxyz0123456789+/")
            let at := table
            for { let first := 0 } lt(first, 64) { first := add(first, 1) } {
                let firstChar := mload(first)
                for { let second := 0 } lt(second, 64) { second := add(second, 1) } {
                    mstore8(at, firstChar)
                    mstore8(add(at, 1), mload(second))
                    at := add(at, 2)
                }
            }
            let source := add(data, 0x20)
            let dataEnd := add(source, length)
            let dataEndValue := mload(dataEnd)
            mstore(dataEnd, 0)
            let pointer := add(result, 0x20)
            for {} iszero(gt(add(source, 24), dataEnd)) { source := add(source, 24) pointer := add(pointer, 32) } {
                mstore(pointer, block24(mload(source), table))
            }
            // At most eight tail groups, including the final padded group.
            for {} lt(source, dataEnd) { source := add(source, 3) pointer := add(pointer, 4) } {
                let input := shr(232, mload(source))
                let highMask := 0xffff000000000000000000000000000000000000000000000000000000000000
                let first := and(mload(add(table, shl(1, shr(12, input)))), highMask)
                let second := and(mload(add(table, shl(1, and(input, 0xfff)))), highMask)
                mstore(pointer, or(first, shr(16, second)))
            }
            mstore(dataEnd, dataEndValue)
            let padding := div(2, mod(length, 3))
            mstore(sub(pointer, padding), shl(240, 0x3d3d))
            mstore(pointer, 0)
            mstore(result, encodedLength)
            mstore(0x40, add(pointer, 0x20))
        }
    }
}
