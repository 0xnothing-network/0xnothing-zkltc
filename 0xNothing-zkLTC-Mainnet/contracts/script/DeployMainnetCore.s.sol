// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DIAOracleAdapter} from "../src/oracle/DIAOracleAdapter.sol";
import {OracleRouter} from "../src/oracle/OracleRouter.sol";
import {IPriceOracle} from "../src/oracle/IPriceOracle.sol";
import {OracleNUSDv2} from "../src/nusd/OracleNUSDv2.sol";
import {ZeroXPumpV2} from "../src/pump/ZeroXPumpV2.sol";
import {GraduationRouter} from "../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../src/graduation/PermanentLiquidityLocker.sol";
import {OwnerTreasury} from "../src/treasury/OwnerTreasury.sol";
import {FeeSplitter} from "../src/treasury/FeeSplitter.sol";
import {RewardStaking} from "../src/rewards/RewardStaking.sol";
import {ZeroXPixelV2} from "../src/0xpixel/ZeroXPixelV2.sol";
import {NusdNftMarketplaceV2} from "../src/0xpixel/NusdNftMarketplaceV2.sol";

interface VmDeployMainnet {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envAddress(string calldata key) external returns (address value);
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

/// @notice zkLTC mainnet core: the testnet v3 suite unchanged, with every chain-specific address
///         read from the environment and nothing defaulted. It deploys its own bounded DIA
///         adapters behind the oracle routers and a fresh 0xPixel collection for the marketplace.
///         The deployer owns every bounded parameter afterwards; hand admin to a multisig with the
///         two-step transfers before launch (see ../README.md).
contract DeployMainnetCore {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error UnexpectedConfiguration(string what);

    VmDeployMainnet private constant vm = VmDeployMainnet(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev The LiteForge testnet; a mainnet run must never land there.
    uint256 private constant TESTNET_CHAIN_ID = 4441;
    uint256 private constant MAX_PRICE_AGE = 90 minutes;
    // Sanity bounds of each feed, in USD with 18 decimals; a price outside them reads as dead.
    uint256 private constant LTC_MIN_PRICE = 10 ether;
    uint256 private constant LTC_MAX_PRICE = 1_000 ether;
    uint256 private constant BTC_MIN_PRICE = 5_000 ether;
    uint256 private constant BTC_MAX_PRICE = 500_000 ether;
    uint256 private constant ETH_MIN_PRICE = 250 ether;
    uint256 private constant ETH_MAX_PRICE = 50_000 ether;
    // Economics settled for v3 (docs/TOKENOMICS.md in the testnet tree).
    uint256 private constant NUSD_SUPPLY_CEILING = 1_000_000 ether;
    uint256 private constant SURPLUS_TREASURY_BPS = 2_000;
    uint256 private constant GRADUATION_DELAY = 1 hours;
    uint256 private constant PUMP_TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 private constant INITIAL_VIRTUAL_NUSD_RESERVE = 1_500 ether;
    uint256 private constant GRADUATION_MARKET_CAP_TARGET_NUSD = 6_000 ether;
    uint256 private constant PUMP_CREATE_FEE_NUSD = 1 ether;
    uint256 private constant PUMP_TRADE_FEE_BPS = 10;

    struct Config {
        address deployer;
        address wzkltc;
        address ltcFeed;
        address btcFeed;
        address ethFeed;
    }

    struct Deployment {
        DIAOracleAdapter ltcAdapter;
        DIAOracleAdapter btcAdapter;
        DIAOracleAdapter ethAdapter;
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
        ZeroXPixelV2 pixel;
        NusdNftMarketplaceV2 marketplace;
    }

    function run() external returns (Deployment memory d) {
        uint256 expectedChainId = vm.envUint("MAINNET_CHAIN_ID");
        if (expectedChainId == TESTNET_CHAIN_ID || block.chainid != expectedChainId) {
            revert WrongChain(expectedChainId, block.chainid);
        }
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        Config memory c = Config({
            deployer: vm.addr(privateKey),
            wzkltc: vm.envAddress("MAINNET_WZKLTC"),
            ltcFeed: vm.envAddress("MAINNET_DIA_LTC_USD"),
            btcFeed: vm.envAddress("MAINNET_DIA_BTC_USD"),
            ethFeed: vm.envAddress("MAINNET_DIA_ETH_USD")
        });
        if (c.wzkltc.code.length == 0) revert UnexpectedConfiguration("wrapped zkLTC");

        vm.startBroadcast(privateKey);

        d.ltcAdapter = new DIAOracleAdapter(c.ltcFeed, "LTC/USD", MAX_PRICE_AGE, LTC_MIN_PRICE, LTC_MAX_PRICE);
        d.btcAdapter = new DIAOracleAdapter(c.btcFeed, "BTC/USD", MAX_PRICE_AGE, BTC_MIN_PRICE, BTC_MAX_PRICE);
        d.ethAdapter = new DIAOracleAdapter(c.ethFeed, "ETH/USD", MAX_PRICE_AGE, ETH_MIN_PRICE, ETH_MAX_PRICE);
        d.ltcOracle = new OracleRouter("LTC/USD", address(d.ltcAdapter), c.deployer);
        d.btcOracle = new OracleRouter("BTC/USD", address(d.btcAdapter), c.deployer);
        d.ethOracle = new OracleRouter("ETH/USD", address(d.ethAdapter), c.deployer);

        d.nusd = new OracleNUSDv2(IPriceOracle(address(d.ltcOracle)), c.deployer, NUSD_SUPPLY_CEILING);
        d.treasury = new OwnerTreasury(c.deployer);
        d.rewardStaking = new RewardStaking(IERC20(address(d.nusd)));
        d.feeSplitter = new FeeSplitter(address(d.nusd), c.wzkltc, address(d.treasury), c.deployer);
        d.feeSplitter.setRecipients(address(d.rewardStaking), address(d.treasury));
        d.rewardStaking.bindHarvester(address(d.feeSplitter));
        d.nusd.setSurplusRecipients(address(d.rewardStaking), address(d.treasury), SURPLUS_TREASURY_BPS);

        d.locker = new PermanentLiquidityLocker(c.deployer);
        d.graduationRouter = new GraduationRouter(c.deployer, GRADUATION_DELAY, address(d.locker));
        d.pump = new ZeroXPumpV2(
            address(d.nusd),
            address(d.nusd),
            address(d.graduationRouter),
            address(d.feeSplitter),
            c.deployer,
            c.deployer,
            PUMP_TOKEN_SUPPLY,
            INITIAL_VIRTUAL_NUSD_RESERVE,
            GRADUATION_MARKET_CAP_TARGET_NUSD,
            PUMP_CREATE_FEE_NUSD,
            PUMP_TRADE_FEE_BPS
        );
        d.graduationRouter.bindPump(address(d.pump));
        d.locker.bindRouter(address(d.graduationRouter));

        d.pixel = new ZeroXPixelV2();
        address[] memory collections = new address[](1);
        collections[0] = address(d.pixel);
        d.marketplace = new NusdNftMarketplaceV2(address(d.nusd), c.deployer, collections);

        vm.stopBroadcast();
        _validate(d, c);
        _writeManifest(d, c);
    }

    function _validate(Deployment memory d, Config memory c) private view {
        if (
            address(d.ltcOracle.source()) != address(d.ltcAdapter) || address(d.btcOracle.source()) != address(d.btcAdapter)
                || address(d.ethOracle.source()) != address(d.ethAdapter) || d.ltcOracle.admin() != c.deployer
        ) revert UnexpectedConfiguration("oracle routers");
        if (
            address(d.nusd.oracle()) != address(d.ltcOracle) || d.nusd.supplyCeilingNusd() != NUSD_SUPPLY_CEILING
                || d.nusd.surplusStaking() != address(d.rewardStaking) || d.nusd.surplusTreasury() != address(d.treasury)
                || d.nusd.surplusTreasuryBps() != SURPLUS_TREASURY_BPS || d.nusd.mintPaused()
                || !d.nusd.hasRole(d.nusd.DEFAULT_ADMIN_ROLE(), c.deployer)
        ) revert UnexpectedConfiguration("nusd");
        if (
            d.rewardStaking.harvester() != address(d.feeSplitter) || d.feeSplitter.staking() != address(d.rewardStaking)
                || d.feeSplitter.treasury() != address(d.treasury) || address(d.feeSplitter.wrappedNative()) != c.wzkltc
        ) revert UnexpectedConfiguration("fees and staking");
        if (
            d.pump.feeRecipient() != address(d.feeSplitter) || d.pump.paramAdmin() != c.deployer
                || d.graduationRouter.pump() != address(d.pump) || d.graduationRouter.enabled()
        ) revert UnexpectedConfiguration("pump");
        if (!d.marketplace.collectionAllowed(address(d.pixel)) || d.marketplace.owner() != c.deployer) {
            revert UnexpectedConfiguration("marketplace");
        }
    }

    function _writeManifest(Deployment memory d, Config memory c) private {
        string memory key = "core";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "scriptBlock", block.number);
        vm.serializeAddress(key, "deployer", c.deployer);
        vm.serializeAddress(key, "wzkLTC", c.wzkltc);
        vm.serializeAddress(key, "ltcAdapter", address(d.ltcAdapter));
        vm.serializeAddress(key, "btcAdapter", address(d.btcAdapter));
        vm.serializeAddress(key, "ethAdapter", address(d.ethAdapter));
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
        vm.serializeAddress(key, "pixel", address(d.pixel));
        string memory json = vm.serializeAddress(key, "nusdMarketplace", address(d.marketplace));
        vm.writeJson(json, string.concat("./deployments/mainnet-core", vm.envOr("MAINNET_MANIFEST_SUFFIX", string("")), ".json"));
    }
}
