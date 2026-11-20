// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IPriceOracle } from "../../src/oracle/interfaces/IPriceOracle.sol";

/// @dev Plain ERC20 mock representing N for risk tests.
contract MockN is ERC20 {
    uint256 public reserveValueN = type(uint256).max;

    constructor() ERC20("N", "N") { }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setReserveValueN(uint256 valueN) external {
        reserveValueN = valueN;
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

    IERC20 public immutable n;
    uint256 public totalRoutedN;
    bool public shouldRevert;
    mapping(address => address) public mintFeePairForVault;
    mapping(address => address) public mintFeeVaultForPair;

    constructor(address nAddress) {
        n = IERC20(nAddress);
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function bindVault(address vault, address pair) external {
        mintFeePairForVault[vault] = pair;
        mintFeeVaultForPair[pair] = vault;
    }

    function routeMintFee(uint256 amountN) external returns (uint256 amountFlushedN) {
        require(!shouldRevert, "FEE_ROUTE_FAILED");
        uint256 balanceBefore = n.balanceOf(address(this));
        n.safeTransferFrom(msg.sender, address(this), amountN);
        require(n.balanceOf(address(this)) == balanceBefore + amountN, "EXACT_TRANSFER_REQUIRED");
        totalRoutedN += amountN;
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
