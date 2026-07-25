// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library MathX {
    error MulDivOverflow();

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) revert MulDivOverflow();
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }

    // Full precision multiplication followed by division, adapted from Remco Bloemen's algorithm.
    function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(x, y, not(0))
                prod0 := mul(x, y)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            if (prod1 == 0) {
                if (denominator == 0) revert MulDivOverflow();
                return prod0 / denominator;
            }
            if (denominator <= prod1) revert MulDivOverflow();

            uint256 remainder;
            assembly {
                remainder := mulmod(x, y, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
        }
    }

    function mulDivUp(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        result = mulDiv(x, y, denominator);
        if (mulmod(x, y, denominator) != 0) {
            if (result == type(uint256).max) revert MulDivOverflow();
            result++;
        }
    }

    function sqrt(uint256 value) internal pure returns (uint256 result) {
        if (value == 0) return 0;

        result = value;
        uint256 candidate = (value / 2) + 1;
        while (candidate < result) {
            result = candidate;
            candidate = ((value / candidate) + candidate) / 2;
        }
    }

    function sqrtUp(uint256 value) internal pure returns (uint256 result) {
        result = sqrt(value);
        if (result * result < value) result++;
    }
}
