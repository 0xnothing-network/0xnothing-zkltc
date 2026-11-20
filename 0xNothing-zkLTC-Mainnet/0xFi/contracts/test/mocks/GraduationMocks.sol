// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IGraduationAdapter } from "../../src/interfaces/IGraduationAdapter.sol";

contract MockPump {
    address public immutable N;
    address public graduationRouter;
    mapping(address => uint256) public status;

    constructor(address n_) {
        N = n_;
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
        address n,
        uint256 tokenAmount,
        uint256 nAmount,
        uint256 minimumLp,
        uint256 deadline
    ) external returns (IGraduationAdapter.GraduationResult memory result) {
        IERC20(token).forceApprove(address(adapter), tokenAmount);
        IERC20(n).forceApprove(address(adapter), nAmount);
        result = adapter.graduate(
            IGraduationAdapter.GraduationParams({
                token: token,
                n: n,
                tokenAmount: tokenAmount,
                nAmount: nAmount,
                minimumLp: minimumLp,
                deadline: deadline,
                lpRecipient: address(this)
            })
        );
        IERC20(token).forceApprove(address(adapter), 0);
        IERC20(n).forceApprove(address(adapter), 0);
    }
}
