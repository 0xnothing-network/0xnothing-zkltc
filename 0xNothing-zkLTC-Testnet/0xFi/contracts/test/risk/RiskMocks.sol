// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IPriceOracle } from "../../src/oracle/interfaces/IPriceOracle.sol";

/// @dev Plain ERC20 mock representing NUSD for risk tests.
contract MockNUSD is ERC20 {
    uint256 public reserveValueNusd = type(uint256).max;

    constructor() ERC20("Nothing USD", "NUSD") { }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setReserveValueNusd(uint256 valueNusd) external {
        reserveValueNusd = valueNusd;
    }
}

contract MockCollateralToken is ERC20 {
    uint8 private immutable _assetDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _assetDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _assetDecimals;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract MockMintFeeDistributor {
    using SafeERC20 for IERC20;

    IERC20 public immutable nusd;
    uint256 public totalRoutedNusd;
    bool public shouldRevert;

    constructor(address nusdAddress) {
        nusd = IERC20(nusdAddress);
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function routeMintFee(uint256 amountNusd) external returns (uint256 amountFlushedNusd) {
        require(!shouldRevert, "FEE_ROUTE_FAILED");
        uint256 balanceBefore = nusd.balanceOf(address(this));
        nusd.safeTransferFrom(msg.sender, address(this), amountNusd);
        require(nusd.balanceOf(address(this)) == balanceBefore + amountNusd, "EXACT_TRANSFER_REQUIRED");
        totalRoutedNusd += amountNusd;
        return 0;
    }
}

contract MockPriceOracle is IPriceOracle {
    uint256 public priceWad;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    bool public readReverts;

    constructor(uint256 initialPriceWad) {
        priceWad = initialPriceWad;
        updatedAt = block.timestamp;
    }

    function setPrice(uint256 newPriceWad) external {
        priceWad = newPriceWad;
        updatedAt = block.timestamp;
        roundId += 1;
    }

    function setReadReverts(bool shouldRevert) external {
        readReverts = shouldRevert;
    }

    function readPriceWad() external view returns (uint256, uint256, uint80) {
        if (readReverts) revert("ORACLE_READ_FAILED");
        return (priceWad, updatedAt, roundId);
    }
}

contract MockDIAAggregatorV3 {
    uint8 public immutable decimals;
    string public description;
    uint80 public roundId;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    constructor(uint8 decimals_, string memory description_) {
        decimals = decimals_;
        description = description_;
    }

    function setRound(uint80 roundId_, int256 answer_, uint256 updatedAt_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answer = answer_;
        startedAt = updatedAt_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}
