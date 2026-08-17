// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { CommunityLiquidityLocker } from "../src/locking/CommunityLiquidityLocker.sol";
import { TokenMetadataRegistry } from "../src/metadata/TokenMetadataRegistry.sol";

interface VmDeployCommunityTools {
    function envUint(string calldata key) external returns (uint256 value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployCommunityTools {
    VmDeployCommunityTools private constant vm =
        VmDeployCommunityTools(address(uint160(uint256(keccak256("hevm cheat code")))));

    // 0xFi DEX factory on LitVM LiteForge testnet (chainId 4441).
    address private constant DEX_FACTORY = 0xe33fE815c2e12DC83b69397CeD12b09849Fa9C0D;

    // Canonical assets protected from third-party image registration in the metadata registry.
    address private constant NUSD = 0x5317e21aba902c6c7087a84457bc02fFe99604d1;
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    address private constant NBTC = 0x0CBc1e968db77885DCa648D7bD0e80fCc94cB9Cf;
    address private constant NETH = 0xD504bB9430d94ccFF87e12e94fd6C0074D0E8aCb;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        address[] memory protectedTokens = new address[](4);
        protectedTokens[0] = NUSD;
        protectedTokens[1] = WZKLTC;
        protectedTokens[2] = NBTC;
        protectedTokens[3] = NETH;

        vm.startBroadcast(deployerKey);

        CommunityLiquidityLocker locker = new CommunityLiquidityLocker(DEX_FACTORY);
        TokenMetadataRegistry registry = new TokenMetadataRegistry(protectedTokens);

        vm.stopBroadcast();
    }
}
