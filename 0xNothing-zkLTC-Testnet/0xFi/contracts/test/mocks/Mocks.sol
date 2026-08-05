// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IGraduationAdapter } from "../../src/interfaces/IGraduationAdapter.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Fee token", "FEE") { }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value >= 100) {
            uint256 fee = value / 100;
            super._update(from, address(1), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MockPump {
    address public immutable NUSD;
    address public graduationRouter;
    mapping(address => uint256) public status;

    constructor(address nusd_) {
        NUSD = nusd_;
    }

    function setGraduationRouter(address router) external {
        graduationRouter = router;
    }

    function setStatus(address token, uint256 lifecycle) external {
        status[token] = lifecycle;
    }
}

contract MockPumpRouter {
    using SafeERC20 for IERC20;

    address public immutable pump;

    constructor(address pump_) {
        pump = pump_;
    }

    function execute(
        IGraduationAdapter adapter,
        address token,
        address nusd,
        uint256 tokenAmount,
        uint256 nusdAmount,
        uint256 minimumLp,
        uint256 deadline
    ) external returns (IGraduationAdapter.GraduationResult memory result) {
        IERC20(token).forceApprove(address(adapter), tokenAmount);
        IERC20(nusd).forceApprove(address(adapter), nusdAmount);
        result = adapter.graduate(
            IGraduationAdapter.GraduationParams({
                token: token,
                nusd: nusd,
                tokenAmount: tokenAmount,
                nusdAmount: nusdAmount,
                minimumLp: minimumLp,
                deadline: deadline,
                lpRecipient: address(this)
            })
        );
        IERC20(token).forceApprove(address(adapter), 0);
        IERC20(nusd).forceApprove(address(adapter), 0);
    }
}
