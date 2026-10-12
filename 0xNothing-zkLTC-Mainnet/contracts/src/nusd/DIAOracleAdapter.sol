// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {TwoStepAdmin} from "../common/TwoStepAdmin.sol";
import {IDIAAggregatorV3} from "./interfaces/IDIAAggregatorV3.sol";

/// @notice Normalizes a DIA AggregatorV3-style feed to 18 decimals and rejects stale, out-of-band, or
///         abruptly moving prices.
/// @dev The admin can only tighten or relax the acceptance rules; it can never supply a price. Deviation is
///      measured against the last synced anchor because the DIA feed does not implement `getRoundData`. The
///      allowed deviation grows by `maxDeviationBps` for every `maxPriceAge` elapsed since the anchor was
///      published, capped at `MAX_DEVIATION_INTERVALS`, so a genuine large move self-heals without unbounded
///      allowance growth.
contract DIAOracleAdapter is TwoStepAdmin {
    error InvalidFeed();
    error InvalidMaxPriceAge();
    error InvalidFeedDecimals();
    error InvalidPriceBounds();
    error InvalidDeviation();
    error InvalidOracleAnswer();
    error IncompleteOracleRound();
    error FutureOracleTimestamp();
    error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp);
    error PriceOutOfBounds(uint256 priceWad, uint256 minPriceWad, uint256 maxPriceWad);
    error PriceDeviationExceeded(uint256 anchorPriceWad, uint256 priceWad, uint256 allowedDeviationWad);

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_PRICE_AGE = 5 minutes;
    uint256 public constant MAX_PRICE_AGE_CAP = 2 hours;
    uint256 public constant MAX_DEVIATION_INTERVALS = 3;

    IDIAAggregatorV3 public immutable feed;
    uint8 public immutable feedDecimals;

    uint256 public maxPriceAge;
    uint256 public minPriceWad;
    uint256 public maxPriceWad;
    /// @notice Maximum move per `maxPriceAge` interval relative to the anchor; zero disables the check.
    uint256 public maxDeviationBps;
    /// @notice Rejects rounds whose `answeredInRound` lags `roundId`; can be disabled for feeds that do not
    ///         populate the field so mint and redeem cannot be bricked permanently.
    bool public enforceAnsweredInRound = true;

    uint256 public anchorPriceWad;
    uint256 public anchorUpdatedAt;
    uint80 public anchorRoundId;

    event MaxPriceAgeUpdated(uint256 maxPriceAge);
    event PriceBoundsUpdated(uint256 minPriceWad, uint256 maxPriceWad);
    event MaxDeviationUpdated(uint256 maxDeviationBps);
    event AnsweredInRoundEnforcementUpdated(bool enforced);
    event PriceAnchorUpdated(uint256 priceWad, uint256 updatedAt, uint80 roundId, bool forced);

    constructor(
        address feedAddress,
        uint256 maximumPriceAge,
        address initialAdmin,
        uint256 minimumPriceWad,
        uint256 maximumPriceWad,
        uint256 maximumDeviationBps
    ) TwoStepAdmin(initialAdmin) {
        if (feedAddress == address(0) || feedAddress.code.length == 0) revert InvalidFeed();

        IDIAAggregatorV3 oracle = IDIAAggregatorV3(feedAddress);
        uint8 oracleDecimals = oracle.decimals();
        if (oracleDecimals > 36) revert InvalidFeedDecimals();

        feed = oracle;
        feedDecimals = oracleDecimals;
        _setMaxPriceAge(maximumPriceAge);
        _setPriceBounds(minimumPriceWad, maximumPriceWad);
        _setMaxDeviationBps(maximumDeviationBps);
    }

    function readPriceWad() public view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId) {
        (priceWad, updatedAt, roundId) = _readBoundedPrice();
        _checkDeviation(priceWad, roundId);
    }

    function isFresh() external view returns (bool fresh) {
        try this.readPriceWad() returns (uint256, uint256, uint80) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Moves the deviation anchor to the current feed price when it passes every check.
    function syncPrice() external returns (uint256 priceWad) {
        uint256 updatedAt;
        uint80 roundId;
        (priceWad, updatedAt, roundId) = readPriceWad();
        _setAnchor(priceWad, updatedAt, roundId, false);
    }

    /// @notice Re-anchors to the current feed price, bypassing only the deviation check.
    function resetPriceAnchor() external onlyAdmin returns (uint256 priceWad) {
        uint256 updatedAt;
        uint80 roundId;
        (priceWad, updatedAt, roundId) = _readBoundedPrice();
        _setAnchor(priceWad, updatedAt, roundId, true);
    }

    function setMaxPriceAge(uint256 maximumPriceAge) external onlyAdmin {
        _setMaxPriceAge(maximumPriceAge);
    }

    function setPriceBounds(uint256 minimumPriceWad, uint256 maximumPriceWad) external onlyAdmin {
        _setPriceBounds(minimumPriceWad, maximumPriceWad);
    }

    function setMaxDeviationBps(uint256 maximumDeviationBps) external onlyAdmin {
        _setMaxDeviationBps(maximumDeviationBps);
    }

    function setEnforceAnsweredInRound(bool enforced) external onlyAdmin {
        enforceAnsweredInRound = enforced;
        emit AnsweredInRoundEnforcementUpdated(enforced);
    }

    function _readBoundedPrice() internal view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId) {
        int256 answer;
        uint80 answeredInRound;
        (roundId, answer,, updatedAt, answeredInRound) = feed.latestRoundData();

        if (roundId == 0 || answer <= 0 || updatedAt == 0) revert InvalidOracleAnswer();
        if (enforceAnsweredInRound && answeredInRound < roundId) revert IncompleteOracleRound();
        if (updatedAt > block.timestamp) revert FutureOracleTimestamp();
        if (block.timestamp - updatedAt > maxPriceAge) {
            revert StaleOraclePrice(updatedAt, block.timestamp);
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 unsignedAnswer = uint256(answer);
        if (feedDecimals == 18) {
            priceWad = unsignedAnswer;
        } else if (feedDecimals < 18) {
            priceWad = unsignedAnswer * (10 ** (18 - feedDecimals));
        } else {
            priceWad = unsignedAnswer / (10 ** (feedDecimals - 18));
        }
        if (priceWad == 0) revert InvalidOracleAnswer();
        if (priceWad < minPriceWad || priceWad > maxPriceWad) {
            revert PriceOutOfBounds(priceWad, minPriceWad, maxPriceWad);
        }
    }

    function _checkDeviation(uint256 priceWad, uint80 roundId) internal view {
        uint256 deviationBps = maxDeviationBps;
        uint256 anchor = anchorPriceWad;
        if (deviationBps == 0 || anchor == 0 || roundId == anchorRoundId) return;

        uint256 elapsed = block.timestamp > anchorUpdatedAt ? block.timestamp - anchorUpdatedAt : 0;
        uint256 intervals = elapsed / maxPriceAge + 1;
        if (intervals > MAX_DEVIATION_INTERVALS) intervals = MAX_DEVIATION_INTERVALS;
        uint256 allowed = MathX.mulDiv(anchor, deviationBps * intervals, BPS_DENOMINATOR);
        uint256 difference = priceWad > anchor ? priceWad - anchor : anchor - priceWad;
        if (difference > allowed) revert PriceDeviationExceeded(anchor, priceWad, allowed);
    }

    function _setAnchor(uint256 priceWad, uint256 updatedAt, uint80 roundId, bool forced) internal {
        anchorPriceWad = priceWad;
        anchorUpdatedAt = updatedAt;
        anchorRoundId = roundId;
        emit PriceAnchorUpdated(priceWad, updatedAt, roundId, forced);
    }

    function _setMaxPriceAge(uint256 maximumPriceAge) internal {
        if (maximumPriceAge < MIN_PRICE_AGE || maximumPriceAge > MAX_PRICE_AGE_CAP) revert InvalidMaxPriceAge();
        maxPriceAge = maximumPriceAge;
        emit MaxPriceAgeUpdated(maximumPriceAge);
    }

    function _setPriceBounds(uint256 minimumPriceWad, uint256 maximumPriceWad) internal {
        if (minimumPriceWad == 0 || minimumPriceWad >= maximumPriceWad) revert InvalidPriceBounds();
        minPriceWad = minimumPriceWad;
        maxPriceWad = maximumPriceWad;
        emit PriceBoundsUpdated(minimumPriceWad, maximumPriceWad);
    }

    function _setMaxDeviationBps(uint256 maximumDeviationBps) internal {
        if (maximumDeviationBps > BPS_DENOMINATOR) revert InvalidDeviation();
        maxDeviationBps = maximumDeviationBps;
        emit MaxDeviationUpdated(maximumDeviationBps);
    }
}
