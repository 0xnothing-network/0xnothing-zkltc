// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

library SafeTransferLib {
    error ERC20CallFailed(address token);
    error NativeTransferFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert ERC20CallFailed(token);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert ERC20CallFailed(token);
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (success && (data.length == 0 || abi.decode(data, (bool)))) return;

        _approve(token, spender, 0);
        _approve(token, spender, amount);
    }

    function safeTransferNative(address to, uint256 amount) internal {
        (bool success,) = payable(to).call{value: amount}("");
        if (!success) revert NativeTransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert ERC20CallFailed(token);
    }
}
