// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Settable price source; `broken` makes every read revert like a dead feed.
contract MockPriceOracle {
    uint256 public price;
    bool public broken;

    constructor(uint256 initialPrice) {
        price = initialPrice;
    }

    function setPrice(uint256 newPrice) external {
        price = newPrice;
    }

    function setBroken(bool value) external {
        broken = value;
    }

    function readPriceWad() external view returns (uint256, uint256, uint80) {
        require(!broken, "ORACLE_DOWN");
        return (price, block.timestamp, 1);
    }
}

contract MockWrappedNative is ERC20 {
    constructor() ERC20("Wrapped zkLTC", "WzkLTC") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "NATIVE_SEND");
    }
}

interface IDistributor {
    function distribute() external returns (uint256);
    function harvest() external returns (uint256);
}

/// Behaves like the Pump or the router: pays its accrued NUSD to the splitter, then asks it to split.
contract MockFeeSource {
    IERC20 public immutable token;
    address public immutable splitter;

    constructor(IERC20 token_, address splitter_) {
        token = token_;
        splitter = splitter_;
    }

    function distributeFees() external returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        require(amount != 0, "NOTHING");
        token.transfer(splitter, amount);
        IDistributor(splitter).distribute();
    }
}

contract RevertingFeeSource {
    function distributeFees() external pure {
        revert("BROKEN");
    }
}

contract GasBurningFeeSource {
    uint256 public counter;

    function distributeFees() external {
        while (true) {
            ++counter;
        }
    }
}

/// Calls back into the harvest it is part of.
contract ReenteringFeeSource {
    address public immutable splitter;
    uint256 public innerResult = type(uint256).max;

    constructor(address splitter_) {
        splitter = splitter_;
    }

    function distributeFees() external {
        innerResult = IDistributor(splitter).harvest();
    }
}

/// Stands in for the fee splitter in staking tests: pays a preset amount on the next harvest.
contract MockHarvester {
    enum Mode {
        Pay,
        Revert,
        BurnGas
    }

    MockMintable public immutable token;
    address public staking;
    uint256 public nextPayment;
    uint256 public calls;
    Mode public mode;

    constructor(MockMintable token_) {
        token = token_;
    }

    function setStaking(address staking_) external {
        staking = staking_;
    }

    function setNextPayment(uint256 amount) external {
        nextPayment = amount;
    }

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function harvest() external returns (uint256) {
        if (mode == Mode.Revert) revert("HARVEST_FAILED");
        if (mode == Mode.BurnGas) {
            while (true) {
                ++calls;
            }
        }
        ++calls;
        uint256 amount = nextPayment;
        nextPayment = 0;
        if (amount != 0) token.mint(staking, amount);
        return 1;
    }
}

interface MockMintable {
    function mint(address account, uint256 amount) external;
}
