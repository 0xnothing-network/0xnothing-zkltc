// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Self-contained forge script base — no forge-std. Mirrors the project's
/// zero-dependency convention (see test/TestBase.sol).
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function envUint(string calldata key) external returns (uint256);
    function envAddress(string calldata key) external returns (address);
    function envOr(string calldata key, uint256 defaultValue) external returns (uint256);
    function envString(string calldata key, string calldata defaultValue) external returns (string memory);
    function startBroadcast(address signer) external;
    /// Broadcast signed by `privateKey` directly. Preferred for env-sourced keys:
    /// forge signs with this key without needing a --private-key CLI flag, so the
    /// secret never appears in process args, shell history, or logs.
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function writeFile(string calldata path, string calldata data) external;
    function toString(uint256 value) external pure returns (string memory);
    function toString(address value) external pure returns (string memory);
}

abstract contract ScriptBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Append/overwrite a deployments/<chainId>.json record for the relayer + SDK.
    function _record(
        uint256 chainId,
        string memory name,
        address deployed,
        address deployer,
        uint256 blockNumber
    ) internal {
        _recordAs(string.concat("deployments/", vm.toString(chainId), ".json"), chainId, name, deployed, deployer, blockNumber);
    }

    /// Same record, written to an explicit path.
    ///
    /// @dev `_record` writes ONE file per chain and overwrites it. A second
    /// deployment that reuses it would erase the factory's address — the one
    /// value that must never be lost, because every wallet address is a CREATE2
    /// prediction from it. Anything deployed after the factory must therefore
    /// name its own file.
    function _recordAs(
        string memory path,
        uint256 chainId,
        string memory name,
        address deployed,
        address deployer,
        uint256 blockNumber
    ) internal {
        string memory json = string.concat(
            '{"chainId":',
            vm.toString(chainId),
            ',"name":"',
            name,
            '","address":"',
            vm.toString(deployed),
            '","deployer":"',
            vm.toString(deployer),
            '","block":',
            vm.toString(blockNumber),
            "}"
        );
        vm.writeFile(path, json);
    }
}
