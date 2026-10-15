// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OracleRouter} from "../src/oracle/OracleRouter.sol";
import {IPriceOracle} from "../src/oracle/IPriceOracle.sol";
import {OracleNUSDv2} from "../src/nusd/OracleNUSDv2.sol";
import {ZeroXPumpV2} from "../src/pump/ZeroXPumpV2.sol";
import {GraduationRouter} from "../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../src/graduation/PermanentLiquidityLocker.sol";
import {OwnerTreasury} from "../src/treasury/OwnerTreasury.sol";
import {FeeSplitter} from "../src/treasury/FeeSplitter.sol";
import {RewardStaking} from "../src/rewards/RewardStaking.sol";
import {NusdNftMarketplaceV2} from "../src/0xpixel/NusdNftMarketplaceV2.sol";

interface VmDeployV3 {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envOr(string calldata key, string calldata defaultValue) external returns (string memory value);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

interface IDiaAdapter {
    function feed() external view returns (address);
    function maxPriceAge() external view returns (uint256);
}

/// @notice Testnet v3 core: oracle routers (LTC, BTC, ETH), NUSD, treasury, fee splitter, streaming
///         staking, 0xPump with its graduation router, and the 0xPixel marketplace. The deployer is
///         the direct owner of every bounded parameter; no timelock. Earlier suites are not touched.
contract DeployV3Core {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error UnexpectedConfiguration(string what);

    VmDeployV3 private constant vm = VmDeployV3(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    /// @dev Bounded DIA adapters (90-minute max age) the routers start on.
    address private constant LTC_ADAPTER = 0x54361dB5F9DF455B448E882Ce65612D5e418f3Ee;
    address private constant BTC_ADAPTER = 0x781178849cE1D131EFbedff1EF52323A6E117813;
    address private constant ETH_ADAPTER = 0x8E9BD05a80542B171719ac0d749a7A609D69E324;
    address private constant DIA_LTC_USD = 0x45dDa5d881BD2C917976CCfde74fFd6f6412da29;
    address private constant DIA_BTC_USD = 0x7d0445782E383223c7B4B660bb96b87213e9b605;
    address private constant DIA_ETH_USD = 0xc760B46beF9eD3F9A3d2b825164324D6703F0185;
    address private constant PIXEL_V1 = 0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988;
    address private constant PIXEL_V2 = 0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB;
    uint256 private constant NUSD_SUPPLY_CEILING = 1_000_000 ether;
    uint256 private constant SURPLUS_TREASURY_BPS = 2_000;
    uint256 private constant GRADUATION_DELAY = 1 hours;
    uint256 private constant PUMP_TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 private constant INITIAL_VIRTUAL_NUSD_RESERVE = 1_500 ether;
    uint256 private constant GRADUATION_MARKET_CAP_TARGET_NUSD = 6_000 ether;
    uint256 private constant PUMP_CREATE_FEE_NUSD = 1 ether;
    uint256 private constant PUMP_TRADE_FEE_BPS = 10;

    struct Deployment {
        OracleRouter ltcOracle;
        OracleRouter btcOracle;
        OracleRouter ethOracle;
        OracleNUSDv2 nusd;
        OwnerTreasury treasury;
        RewardStaking rewardStaking;
        FeeSplitter feeSplitter;
        PermanentLiquidityLocker locker;
        GraduationRouter graduationRouter;
        ZeroXPumpV2 pump;
        NusdNftMarketplaceV2 marketplace;
    }

    function run() external returns (Deployment memory d) {
        if (block.chainid != CHAIN_ID) revert WrongChain(CHAIN_ID, block.chainid);
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        _checkAdapter(LTC_ADAPTER, DIA_LTC_USD, "ltc adapter");
        _checkAdapter(BTC_ADAPTER, DIA_BTC_USD, "btc adapter");
        _checkAdapter(ETH_ADAPTER, DIA_ETH_USD, "eth adapter");

        vm.startBroadcast(privateKey);

        d.ltcOracle = new OracleRouter("LTC/USD", LTC_ADAPTER, deployer);
        d.btcOracle = new OracleRouter("BTC/USD", BTC_ADAPTER, deployer);
        d.ethOracle = new OracleRouter("ETH/USD", ETH_ADAPTER, deployer);

        d.nusd = new OracleNUSDv2(IPriceOracle(address(d.ltcOracle)), deployer, NUSD_SUPPLY_CEILING);
        d.treasury = new OwnerTreasury(deployer);
        d.rewardStaking = new RewardStaking(IERC20(address(d.nusd)));
        d.feeSplitter = new FeeSplitter(address(d.nusd), WZKLTC, address(d.treasury), deployer);
        d.feeSplitter.setRecipients(address(d.rewardStaking), address(d.treasury));
        d.rewardStaking.bindHarvester(address(d.feeSplitter));
        d.nusd.setSurplusRecipients(address(d.rewardStaking), address(d.treasury), SURPLUS_TREASURY_BPS);

        d.locker = new PermanentLiquidityLocker(deployer);
        d.graduationRouter = new GraduationRouter(deployer, GRADUATION_DELAY, address(d.locker));
        d.pump = new ZeroXPumpV2(
            address(d.nusd),
            address(d.nusd),
            address(d.graduationRouter),
            address(d.feeSplitter),
            deployer,
            deployer,
            PUMP_TOKEN_SUPPLY,
            INITIAL_VIRTUAL_NUSD_RESERVE,
            GRADUATION_MARKET_CAP_TARGET_NUSD,
            PUMP_CREATE_FEE_NUSD,
            PUMP_TRADE_FEE_BPS
        );
        d.graduationRouter.bindPump(address(d.pump));
        d.locker.bindRouter(address(d.graduationRouter));

        // Pixel V1 is allowed afterwards by `deploy-v3.mjs`: its bytecode uses PUSH0, which this
        // repository's `paris` simulation EVM cannot execute (LiteForge itself runs it fine).
        address[] memory collections = new address[](1);
        collections[0] = PIXEL_V2;
        d.marketplace = new NusdNftMarketplaceV2(address(d.nusd), deployer, collections);

        vm.stopBroadcast();
        _validate(d, deployer);
        _writeManifest(d, deployer);
    }

    function _checkAdapter(address adapter, address feed, string memory what) private view {
        if (IDiaAdapter(adapter).feed() != feed || IDiaAdapter(adapter).maxPriceAge() != 90 minutes) {
            revert UnexpectedConfiguration(what);
        }
    }

    function _validate(Deployment memory d, address deployer) private view {
        if (
            address(d.ltcOracle.source()) != LTC_ADAPTER || address(d.btcOracle.source()) != BTC_ADAPTER
                || address(d.ethOracle.source()) != ETH_ADAPTER || d.ltcOracle.admin() != deployer
                || d.btcOracle.admin() != deployer || d.ethOracle.admin() != deployer
        ) revert UnexpectedConfiguration("oracle routers");
        OracleNUSDv2 nusd = d.nusd;
        if (
            address(nusd.oracle()) != address(d.ltcOracle) || nusd.supplyCeilingNusd() != NUSD_SUPPLY_CEILING
                || nusd.surplusStaking() != address(d.rewardStaking) || nusd.surplusTreasury() != address(d.treasury)
                || nusd.surplusTreasuryBps() != SURPLUS_TREASURY_BPS || nusd.surplusFloorBps() != 30_000
                || nusd.surplusTriggerBps() != 33_000 || nusd.mintFeeBps() != 0 || nusd.redeemFeeBps() != 0
                || nusd.mintPaused() || !nusd.hasRole(nusd.DEFAULT_ADMIN_ROLE(), deployer)
                || !nusd.hasRole(nusd.PAUSER_ROLE(), deployer)
        ) revert UnexpectedConfiguration("nusd");
        if (
            d.treasury.owner() != deployer || address(d.rewardStaking.nusd()) != address(nusd)
                || d.rewardStaking.harvester() != address(d.feeSplitter)
        ) revert UnexpectedConfiguration("treasury or staking");
        FeeSplitter splitter = d.feeSplitter;
        if (
            address(splitter.nusd()) != address(nusd) || address(splitter.wrappedNative()) != WZKLTC
                || splitter.staking() != address(d.rewardStaking) || splitter.treasury() != address(d.treasury)
                || splitter.admin() != deployer || splitter.stakerBps() != 7_000 || splitter.burnBps() != 2_000
                || splitter.treasuryBps() != 1_000 || splitter.reserveBps() != 9_000
                || splitter.nativeTreasuryBps() != 1_000 || splitter.sourceCount() != 0
        ) revert UnexpectedConfiguration("fee splitter");
        ZeroXPumpV2 pump = d.pump;
        if (
            pump.feeRecipient() != address(splitter) || pump.NUSD() != address(nusd)
                || address(pump.graduationRouter()) != address(d.graduationRouter) || pump.admin() != deployer
                || pump.paramAdmin() != deployer || pump.paused() || pump.tradeFeeBps() != PUMP_TRADE_FEE_BPS
                || pump.createFee() != PUMP_CREATE_FEE_NUSD
                || pump.initialVirtualNusdReserve() != INITIAL_VIRTUAL_NUSD_RESERVE
                || pump.graduationThresholdNusd() != GRADUATION_MARKET_CAP_TARGET_NUSD
                || pump.graduationReserveThresholdNusd() != 1_500 ether
        ) revert UnexpectedConfiguration("pump");
        if (
            d.graduationRouter.pump() != address(pump) || d.graduationRouter.minimumDelay() != GRADUATION_DELAY
                || d.graduationRouter.admin() != deployer || d.graduationRouter.enabled()
        ) revert UnexpectedConfiguration("graduation router");
        if (
            address(d.marketplace.nusd()) != address(nusd) || d.marketplace.owner() != deployer
                || !d.marketplace.collectionAllowed(PIXEL_V2)
        ) revert UnexpectedConfiguration("marketplace");
    }

    function _writeManifest(Deployment memory d, address deployer) private {
        string memory key = "core";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "scriptBlock", block.number);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "ltcOracle", address(d.ltcOracle));
        vm.serializeAddress(key, "btcOracle", address(d.btcOracle));
        vm.serializeAddress(key, "ethOracle", address(d.ethOracle));
        vm.serializeAddress(key, "nusd", address(d.nusd));
        vm.serializeAddress(key, "treasury", address(d.treasury));
        vm.serializeAddress(key, "rewardStaking", address(d.rewardStaking));
        vm.serializeAddress(key, "feeSplitter", address(d.feeSplitter));
        vm.serializeAddress(key, "pumpLiquidityLocker", address(d.locker));
        vm.serializeAddress(key, "pumpGraduationRouter", address(d.graduationRouter));
        vm.serializeAddress(key, "pump", address(d.pump));
        vm.serializeAddress(key, "nusdMarketplace", address(d.marketplace));
        vm.serializeAddress(key, "pixelV1", PIXEL_V1);
        vm.serializeAddress(key, "pixelV2", PIXEL_V2);
        vm.serializeUint(key, "graduationDelaySeconds", GRADUATION_DELAY);
        string memory json = vm.serializeUint(key, "nusdSupplyCeiling", NUSD_SUPPLY_CEILING);
        vm.writeJson(json, string.concat("./deployments/v3-core", vm.envOr("V3_MANIFEST_SUFFIX", string("")), ".json"));
    }
}
