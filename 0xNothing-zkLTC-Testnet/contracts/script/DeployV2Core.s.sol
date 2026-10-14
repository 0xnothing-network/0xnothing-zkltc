// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DIAOracleAdapter} from "../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSDv2} from "../src/nusd/OracleNUSDv2.sol";
import {ZeroXPumpV2} from "../src/pump/ZeroXPumpV2.sol";
import {GraduationRouter} from "../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../src/graduation/PermanentLiquidityLocker.sol";
import {OwnerTreasury} from "../src/treasury/OwnerTreasury.sol";
import {FeeSplitter} from "../src/treasury/FeeSplitter.sol";
import {RewardStaking} from "../src/rewards/RewardStaking.sol";
import {SurplusMintGovernor} from "../src/governance/SurplusMintGovernor.sol";
import {NusdNftMarketplaceV2} from "../src/0xpixel/NusdNftMarketplaceV2.sol";

interface VmDeployV2 {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envOr(string calldata key, string calldata defaultValue) external returns (string memory value);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Testnet v2 core: NUSD v2, treasury, fee splitter, 0xPoints staking, surplus-mint
///         governor, 0xPump v2 with its graduation router, and the 0xPixel marketplace v2.
///         The deployer stays the direct owner (testnet governance mode). v1 is not touched.
contract DeployV2Core {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error UnexpectedConfiguration(string what);

    VmDeployV2 private constant vm = VmDeployV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    /// @dev Stateless LTC/USD adapter already used by NUSD v1 (DIA feed 0x45dD…, 90-minute max age).
    address private constant NUSD_ORACLE_ADAPTER = 0x3579B31e3241DE60F5F9462B3E0d759F346a49c8;
    address private constant DIA_LTC_USD = 0x45dDa5d881BD2C917976CCfde74fFd6f6412da29;
    address private constant PIXEL_V1 = 0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988;
    address private constant PIXEL_V2 = 0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB;
    uint256 private constant NUSD_SUPPLY_CEILING = 1_000_000 ether;
    uint256 private constant GRADUATION_DELAY = 1 hours;
    uint256 private constant PUMP_TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 private constant INITIAL_VIRTUAL_NUSD_RESERVE = 1_500 ether;
    uint256 private constant GRADUATION_MARKET_CAP_TARGET_NUSD = 6_000 ether;

    struct Deployment {
        OracleNUSDv2 nusd;
        OwnerTreasury treasury;
        RewardStaking rewardStaking;
        FeeSplitter feeSplitter;
        SurplusMintGovernor governor;
        PermanentLiquidityLocker locker;
        GraduationRouter graduationRouter;
        ZeroXPumpV2 pump;
        NusdNftMarketplaceV2 marketplace;
    }

    function run() external returns (Deployment memory d) {
        if (block.chainid != CHAIN_ID) revert WrongChain(CHAIN_ID, block.chainid);
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        DIAOracleAdapter adapter = DIAOracleAdapter(NUSD_ORACLE_ADAPTER);
        if (address(adapter.feed()) != DIA_LTC_USD || adapter.maxPriceAge() != 90 minutes) {
            revert UnexpectedConfiguration("oracle adapter");
        }

        vm.startBroadcast(privateKey);

        d.nusd = new OracleNUSDv2(adapter, deployer, NUSD_SUPPLY_CEILING);
        d.treasury = new OwnerTreasury(deployer);
        d.rewardStaking = new RewardStaking(IERC20(address(d.nusd)));
        d.feeSplitter = new FeeSplitter(IERC20(address(d.nusd)), address(d.rewardStaking), address(d.treasury));
        d.governor = new SurplusMintGovernor(IERC20(address(d.nusd)), address(d.rewardStaking), address(d.treasury));
        d.nusd.bindSurplusMinter(address(d.governor));

        d.locker = new PermanentLiquidityLocker(deployer);
        d.graduationRouter = new GraduationRouter(deployer, GRADUATION_DELAY, address(d.locker));
        d.pump = new ZeroXPumpV2(
            address(d.nusd),
            address(d.nusd),
            address(d.graduationRouter),
            address(d.feeSplitter),
            deployer,
            PUMP_TOKEN_SUPPLY,
            INITIAL_VIRTUAL_NUSD_RESERVE,
            GRADUATION_MARKET_CAP_TARGET_NUSD
        );
        d.graduationRouter.bindPump(address(d.pump));
        d.locker.bindRouter(address(d.graduationRouter));

        // Pixel V1 is allowed afterwards by `deploy-v2.mjs`: its bytecode uses PUSH0, which this
        // repository's `paris` simulation EVM cannot execute (LiteForge itself runs it fine).
        address[] memory collections = new address[](1);
        collections[0] = PIXEL_V2;
        d.marketplace = new NusdNftMarketplaceV2(address(d.nusd), deployer, collections);

        vm.stopBroadcast();
        _validate(d, deployer);
        _writeManifest(d, deployer);
    }

    function _validate(Deployment memory d, address deployer) private view {
        if (
            address(d.nusd.oracle()) != NUSD_ORACLE_ADAPTER || d.nusd.surplusMinter() != address(d.governor)
                || d.nusd.supplyCeilingNusd() != NUSD_SUPPLY_CEILING || d.nusd.mintPaused() || d.nusd.redeemPaused()
                || !d.nusd.hasRole(d.nusd.DEFAULT_ADMIN_ROLE(), deployer)
        ) revert UnexpectedConfiguration("nusd");
        if (d.treasury.owner() != deployer || address(d.rewardStaking.nusd()) != address(d.nusd)) {
            revert UnexpectedConfiguration("treasury or staking");
        }
        if (
            address(d.feeSplitter.nusd()) != address(d.nusd) || d.feeSplitter.rewardPool() != address(d.rewardStaking)
                || d.feeSplitter.treasury() != address(d.treasury)
        ) revert UnexpectedConfiguration("fee splitter");
        if (
            address(d.governor.nusd()) != address(d.nusd) || d.governor.rewardPool() != address(d.rewardStaking)
                || d.governor.treasury() != address(d.treasury)
        ) revert UnexpectedConfiguration("governor");
        if (
            d.pump.feeRecipient() != address(d.feeSplitter) || d.pump.NUSD() != address(d.nusd)
                || address(d.pump.graduationRouter()) != address(d.graduationRouter) || d.pump.admin() != deployer
                || d.pump.paused() || d.pump.tradeFeeBps() != 10 || d.pump.createFee() != 1 ether
        ) revert UnexpectedConfiguration("pump");
        if (
            d.graduationRouter.pump() != address(d.pump) || d.graduationRouter.minimumDelay() != GRADUATION_DELAY
                || d.graduationRouter.admin() != deployer || d.graduationRouter.enabled()
        ) revert UnexpectedConfiguration("graduation router");
        if (
            address(d.marketplace.nusd()) != address(d.nusd) || d.marketplace.owner() != deployer
                || !d.marketplace.collectionAllowed(PIXEL_V2)
        ) revert UnexpectedConfiguration("marketplace");
    }

    function _writeManifest(Deployment memory d, address deployer) private {
        string memory key = "core";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "scriptBlock", block.number);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "nusdOracleAdapter", NUSD_ORACLE_ADAPTER);
        vm.serializeAddress(key, "nusd", address(d.nusd));
        vm.serializeAddress(key, "treasury", address(d.treasury));
        vm.serializeAddress(key, "rewardStaking", address(d.rewardStaking));
        vm.serializeAddress(key, "feeSplitter", address(d.feeSplitter));
        vm.serializeAddress(key, "surplusMintGovernor", address(d.governor));
        vm.serializeAddress(key, "pumpLiquidityLocker", address(d.locker));
        vm.serializeAddress(key, "pumpGraduationRouter", address(d.graduationRouter));
        vm.serializeAddress(key, "pump", address(d.pump));
        vm.serializeAddress(key, "nusdMarketplace", address(d.marketplace));
        vm.serializeAddress(key, "pixelV1", PIXEL_V1);
        vm.serializeAddress(key, "pixelV2", PIXEL_V2);
        vm.serializeUint(key, "graduationDelaySeconds", GRADUATION_DELAY);
        string memory json = vm.serializeUint(key, "nusdSupplyCeiling", NUSD_SUPPLY_CEILING);
        vm.writeJson(json, string.concat("./deployments/v2-core", vm.envOr("V2_MANIFEST_SUFFIX", string("")), ".json"));
    }
}
