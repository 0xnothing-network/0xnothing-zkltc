// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Immutable data blobs start with STOP so their payload cannot execute.
contract PixelDataBlob {
    constructor(bytes memory runtime) {
        assembly ("memory-safe") {
            return(add(runtime, 0x20), mload(runtime))
        }
    }
}

/// @notice Store bounded pixel bytes in contract code rather than storage slots.
library PixelData {
    // Six-byte alignment; STOP plus payload remains below EIP-170's 24,576 bytes.
    uint256 internal constant CHUNK_SIZE = 24_570;

    function write(bytes calldata pixels) internal returns (address first, address second) {
        uint256 split = pixels.length > CHUNK_SIZE ? CHUNK_SIZE : pixels.length;
        first = address(new PixelDataBlob(abi.encodePacked(hex"00", pixels[:split])));
        if (split < pixels.length) {
            second = address(new PixelDataBlob(abi.encodePacked(hex"00", pixels[split:])));
        }
    }

    function read(address first, address second, uint256 length) internal view returns (bytes memory pixels) {
        pixels = new bytes(length);
        uint256 split = length > CHUNK_SIZE ? CHUNK_SIZE : length;
        assembly ("memory-safe") {
            extcodecopy(first, add(pixels, 0x20), 1, split)
            if gt(length, split) {
                extcodecopy(second, add(add(pixels, 0x20), split), 1, sub(length, split))
            }
        }
    }
}
