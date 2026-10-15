// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Linear, bounded SVG construction for six-byte horizontal RGB runs.
library PixelRenderer {
    bytes16 private constant HEX = "0123456789abcdef";

    function svg(bytes memory pixels, uint256 grid) internal pure returns (string memory) {
        // Max path 47 bytes, max header 116 bytes, trailer 6 bytes.
        // The 192-byte allowance also covers partial-word stores (up to 31 bytes).
        bytes memory output = new bytes(192 + (pixels.length / 6) * 47);
        uint256 at = _append(output, 0, '<svg xmlns="http://www.w3.org/2000/svg" width="');
        at = _decimal(output, at, grid);
        at = _append(output, at, '" height="');
        at = _decimal(output, at, grid);
        at = _append(output, at, '" viewBox="0 0 ');
        at = _decimal(output, at, grid);
        output[at++] = " ";
        at = _decimal(output, at, grid);
        at = _append(output, at, '" shape-rendering="crispEdges">');
        assembly ("memory-safe") {
            function decimal(pointer, value) -> next {
                next := pointer
                if gt(value, 99) {
                    mstore8(next, add(48, div(value, 100)))
                    next := add(next, 1)
                }
                if gt(value, 9) {
                    mstore8(next, add(48, mod(div(value, 10), 10)))
                    next := add(next, 1)
                }
                mstore8(next, add(48, mod(value, 10)))
                next := add(next, 1)
            }
            let destination := add(add(output, 0x20), at)
            let source := add(pixels, 0x20)
            let end := add(source, mload(pixels))
            let hexDigits := "0123456789abcdef"
            for {} lt(source, end) { source := add(source, 6) } {
                let run := mload(source)
                mstore(destination, '<path fill="#')
                destination := add(destination, 13)
                for { let c := 3 } lt(c, 6) { c := add(c, 1) } {
                    let color := byte(c, run)
                    mstore8(destination, byte(shr(4, color), hexDigits))
                    mstore8(add(destination, 1), byte(and(color, 15), hexDigits))
                    destination := add(destination, 2)
                }
                mstore(destination, '" d="M')
                destination := decimal(add(destination, 6), byte(0, run))
                mstore8(destination, 32)
                destination := decimal(add(destination, 1), byte(1, run))
                mstore8(destination, 104)
                let width := add(byte(2, run), 1)
                destination := decimal(add(destination, 1), width)
                mstore(destination, "v1h-")
                destination := decimal(add(destination, 4), width)
                mstore(destination, 'z"/>')
                destination := add(destination, 4)
            }
            mstore(destination, "</svg>")
            mstore(output, sub(add(destination, 6), add(output, 0x20)))
        }
        return string(output);
    }

    function legacyHex(bytes memory pixels) internal pure returns (string memory) {
        uint256 fullRows;
        for (uint256 i = 2; i < pixels.length; i += 6) {
            if (pixels[i] == 0xff) ++fullRows;
        }
        bytes memory output = new bytes(2 + (pixels.length / 6 + fullRows) * 12);
        output[0] = "0";
        output[1] = "x";
        uint256 at = 2;
        for (uint256 i; i < pixels.length; i += 6) {
            uint256 count = uint256(uint8(pixels[i + 2])) + 1;
            at = _hexByte(output, at, uint8(pixels[i]));
            at = _hexByte(output, at, uint8(pixels[i + 1]));
            at = _hexByte(output, at, count == 256 ? 255 : count);
            for (uint256 c = 3; c < 6; ++c) at = _hexByte(output, at, uint8(pixels[i + c]));
            if (count == 256) {
                at = _hexByte(output, at, 255);
                at = _hexByte(output, at, uint8(pixels[i + 1]));
                at = _hexByte(output, at, 1);
                for (uint256 c = 3; c < 6; ++c) at = _hexByte(output, at, uint8(pixels[i + c]));
            }
        }
        return string(output);
    }

    function escapeJSON(string memory value) internal pure returns (string memory) {
        bytes memory input = bytes(value);
        bytes memory output = new bytes(input.length * 6);
        uint256 at;
        for (uint256 i; i < input.length; ++i) {
            uint8 c = uint8(input[i]);
            if (c == 34 || c == 92) {
                output[at++] = "\\";
                output[at++] = bytes1(c);
            } else if (c < 32) {
                output[at++] = "\\";
                output[at++] = "u";
                output[at++] = "0";
                output[at++] = "0";
                output[at++] = HEX[c >> 4];
                output[at++] = HEX[c & 15];
            } else {
                output[at++] = bytes1(c);
            }
        }
        assembly ("memory-safe") { mstore(output, at) }
        return string(output);
    }

    function toString(uint256 value) internal pure returns (string memory) {
        uint256 digits = 1;
        for (uint256 remaining = value; remaining >= 10; remaining /= 10) ++digits;
        bytes memory output = new bytes(digits);
        do {
            output[--digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        } while (digits != 0);
        return string(output);
    }

    function toHex(uint256 value, uint256 length) internal pure returns (string memory) {
        bytes memory output = new bytes(2 + length * 2);
        output[0] = "0";
        output[1] = "x";
        for (uint256 i = output.length; i > 2;) {
            output[--i] = HEX[value & 15];
            value >>= 4;
        }
        return string(output);
    }

    function _hexByte(bytes memory output, uint256 at, uint256 value) private pure returns (uint256) {
        output[at++] = HEX[value >> 4];
        output[at++] = HEX[value & 15];
        return at;
    }

    function _decimal(bytes memory output, uint256 at, uint256 value) private pure returns (uint256) {
        if (value >= 100) output[at++] = bytes1(uint8(48 + value / 100));
        if (value >= 10) output[at++] = bytes1(uint8(48 + (value / 10) % 10));
        output[at++] = bytes1(uint8(48 + value % 10));
        return at;
    }

    function _append(bytes memory output, uint256 at, bytes memory part) private pure returns (uint256) {
        // All callers reserve at least 31 bytes beyond the maximum rendered SVG.
        // Copy words into that reserved space, avoiding byte-by-byte fragment work.
        assembly ("memory-safe") {
            let destination := add(add(output, 0x20), at)
            let source := add(part, 0x20)
            let end := add(source, mload(part))
            for {} lt(source, end) { source := add(source, 0x20) destination := add(destination, 0x20) } {
                mstore(destination, mload(source))
            }
        }
        return at + part.length;
    }
}
