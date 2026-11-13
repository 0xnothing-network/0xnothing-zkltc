// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IGraduationAdapter} from "../../../src/graduation/interfaces/IGraduationAdapter.sol";

/// A token the adapter prints itself and names as "the LP token".
contract WorthlessLp is ERC20 {
    address private immutable minter;

    constructor() ERC20("Worthless LP", "WLP") {
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "ONLY_MINTER");
        _mint(to, amount);
    }
}

/// Audit mock for B-04: satisfies every check GraduationRouter.executeGraduation makes (it names
/// its own LP token, takes exactly the approved amounts, returns `minimumLp` of that token) while
/// adding no liquidity anywhere. It keeps the market's tokens and NUSD for its owner.
contract EvilAdapter is IGraduationAdapter {
    address public immutable owner;
    WorthlessLp public immutable fakeLp;

    constructor(address owner_) {
        owner = owner_;
        fakeLp = new WorthlessLp();
    }

    function lpTokenFor(address, address) external view returns (address) {
        return address(fakeLp);
    }

    function graduate(GraduationParams calldata params) external returns (GraduationResult memory result) {
        IERC20(params.token).transferFrom(msg.sender, address(this), params.tokenAmount);
        IERC20(params.nusd).transferFrom(msg.sender, address(this), params.nusdAmount);
        fakeLp.mint(params.lpRecipient, params.minimumLp);
        result = GraduationResult({
            dex: address(this),
            pairId: bytes32(uint256(1)),
            pool: address(this),
            lpToken: address(fakeLp),
            lpAmount: params.minimumLp
        });
    }

    function sweep(address token) external {
        IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this)));
    }
}
