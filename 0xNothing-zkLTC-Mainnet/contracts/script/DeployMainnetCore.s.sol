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
    function envOr(string calldata key, bool defaultValue) external returns (bool value);
    function deal(address account, uint256 newBalance) external;
    function readFile(string calldata path) external view returns (string memory data);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address value);
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

interface IWrappedNative {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev A wrapped native token mints 1:1 on deposit and pays back 1:1 on withdraw. The fee splitter
///      unwraps through this address for good, so a token that does not behave like that would
///      block every fee distribution. The script creates this in its local simulation only, with
///      one wei; it is never broadcast. (A script may not use its own address, hence a contract.)
contract WrappedNativeProbe {
    error UnexpectedConfiguration(string what);

    receive() external payable {}

    function check(IWrappedNative wrapped) external {
        if (wrapped.decimals() != 18) revert UnexpectedConfiguration("wrapped zkLTC does not have 18 decimals");
        uint256 amount = address(this).balance;
        uint256 before = wrapped.balanceOf(address(this));
        wrapped.deposit{value: amount}();
        if (wrapped.balanceOf(address(this)) != before + amount || address(this).balance != 0) {
            revert UnexpectedConfiguration("wrapped zkLTC does not mint 1:1 on deposit");
        }
        wrapped.withdraw(amount);
        if (wrapped.balanceOf(address(this)) != before || address(this).balance != amount) {
            revert UnexpectedConfiguration("wrapped zkLTC does not pay back 1:1 on withdraw");
        }
    }
}

/// @notice zkLTC mainnet core. Every chain-specific address is read from the environment and
///         nothing is defaulted. It deploys its own bounded DIA adapters behind the oracle routers
///         and a fresh 0xPixel collection for the marketplace.
///
///         Entry points (README.md has the order):
///         - run()       deploys. The deployer key owns every role afterwards.
///         - verify()    read-only: checks the chain against the manifest and the environment. The
///                       checks inside run() only ever see the local simulation, so run this after
///                       the broadcast, and again with MAINNET_VERIFY_HANDOVER=true at the end.
///         - handover()  after the 0xFi script: offers every role to MAINNET_GOVERNANCE (two-step
///                       transfers, which governance accepts) and grants it the NUSD roles.
///         - renounce()  once governance holds everything: the deployer gives up its NUSD roles.
contract DeployMainnetCore {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error UnexpectedConfiguration(string what);

    VmDeployMainnet private constant vm = VmDeployMainnet(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev The LiteForge testnet; a mainnet run must never land there.
    uint256 private constant TESTNET_CHAIN_ID = 4441;
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
    /// @dev The mint budget is what one wrong price can mint at once: at most this share of the ceiling.
    uint256 private constant MAX_MINT_BUDGET_SHARE_BPS = 1_000;
    /// @dev NUSD's handling of an oracle failure assumes that reading a price is cheap: a transfer
    ///      probes the oracle with 200,000 gas, and from roughly 100,000 gas per read a caller could
    ///      starve a read and report a working oracle as failed. This is measured with warm
    ///      storage, so it leaves room for what a first, cold read costs on top.
    uint256 private constant MAX_WARM_ORACLE_READ_GAS = 40_000;

    /// @dev Oracle-lag settings come from the environment because they depend on the mainnet
    ///      feed's heartbeat and deviation threshold. The mint age is at least the heartbeat (a calm
    ///      market leaves a price that old, and below it minting would stop and redemption would
    ///      pay the maximum fee for part of every heartbeat); the adapter age is at least the mint
    ///      age and close to it; each fee is at least the deviation threshold, because a trade
    ///      against a lagging price uses one leg, so half the threshold per fee is not enough.
    struct Guards {
        uint256 oracleMaxAge;
        uint256 mintMaxPriceAge;
        uint256 mintLimitPerHour;
        uint256 mintFeeBps;
        uint256 redeemFeeBps;
        uint256 feedDeviationBps;
        uint256 feedHeartbeat;
    }

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

    // ---------------------------------------------------------------- entry points

    function run() external returns (Deployment memory d) {
        _requireChain();
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        Config memory c = _config(vm.addr(privateKey));
        Guards memory g = _guards();
        _checkWrappedNative(c.wzkltc);

        vm.startBroadcast(privateKey);

        d.ltcAdapter = new DIAOracleAdapter(c.ltcFeed, "LTC/USD", g.oracleMaxAge, LTC_MIN_PRICE, LTC_MAX_PRICE);
        d.btcAdapter = new DIAOracleAdapter(c.btcFeed, "BTC/USD", g.oracleMaxAge, BTC_MIN_PRICE, BTC_MAX_PRICE);
        d.ethAdapter = new DIAOracleAdapter(c.ethFeed, "ETH/USD", g.oracleMaxAge, ETH_MIN_PRICE, ETH_MAX_PRICE);
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
        d.nusd.setMintGuards(g.mintMaxPriceAge, g.mintLimitPerHour);
        d.nusd.setFees(g.mintFeeBps, g.redeemFeeBps);

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
        _validateWiring(d, c, g);
        _validateDeployerHolds(d, c.deployer);
        _writeManifest(d, c, g);
    }

    /// @notice Read-only check of the deployed state against the manifest and the environment the
    ///         deployment used. With MAINNET_VERIFY_HANDOVER=true it expects every role with
    ///         MAINNET_GOVERNANCE and none with the deployer.
    function verify() external {
        _requireChain();
        Config memory c = _config(vm.envAddress("MAINNET_DEPLOYER"));
        Deployment memory d = _load();
        _validateWiring(d, c, _guards());
        if (vm.envOr("MAINNET_VERIFY_HANDOVER", false)) {
            _validateHandedOver(d, c.deployer, vm.envAddress("MAINNET_GOVERNANCE"), vm.envAddress("MAINNET_GUARDIAN"));
        } else {
            _validateDeployerHolds(d, c.deployer);
        }
    }

    /// @notice Offers every core role the deployer holds to MAINNET_GOVERNANCE. The transfers are
    ///         two-step: nothing changes hands until governance accepts each one, and the deployer
    ///         can point them elsewhere until then. NUSD roles are granted, not transferred; the
    ///         deployer keeps its own until renounce(). When governance is the deployer itself
    ///         nothing is offered and only the guardian receives its pause role.
    function handover() external {
        _requireChain();
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address governance = vm.envAddress("MAINNET_GOVERNANCE");
        address guardian = vm.envAddress("MAINNET_GUARDIAN");
        if (governance.code.length == 0 && governance.balance == 0) {
            revert UnexpectedConfiguration("governance has neither code nor a balance on this chain");
        }
        if (guardian == address(0)) revert UnexpectedConfiguration("guardian must be set");
        Deployment memory d = _load();
        _validateDeployerHolds(d, deployer);
        if (d.pump.admin() == deployer) {
            revert UnexpectedConfiguration("run the 0xFi script first: it hands the Pump to the controller");
        }

        vm.startBroadcast(privateKey);
        if (governance != deployer) {
            d.ltcOracle.transferAdmin(governance);
            d.btcOracle.transferAdmin(governance);
            d.ethOracle.transferAdmin(governance);
            d.feeSplitter.transferAdmin(governance);
            d.treasury.transferOwnership(governance);
            d.marketplace.transferOwnership(governance);
            d.pump.transferParamAdmin(governance);
            d.nusd.grantRole(d.nusd.DEFAULT_ADMIN_ROLE(), governance);
            d.nusd.grantRole(d.nusd.PAUSER_ROLE(), governance);
        }
        d.nusd.grantRole(d.nusd.PAUSER_ROLE(), guardian);
        vm.stopBroadcast();

        if (
            governance != deployer
                && (
                    d.ltcOracle.pendingAdmin() != governance || d.btcOracle.pendingAdmin() != governance
                        || d.ethOracle.pendingAdmin() != governance || d.feeSplitter.pendingAdmin() != governance
                        || d.treasury.pendingOwner() != governance || d.marketplace.pendingOwner() != governance
                        || d.pump.pendingParamAdmin() != governance
                )
        ) revert UnexpectedConfiguration("handover was not recorded");
        if (
            !d.nusd.hasRole(d.nusd.DEFAULT_ADMIN_ROLE(), governance) || !d.nusd.hasRole(d.nusd.PAUSER_ROLE(), governance)
                || !d.nusd.hasRole(d.nusd.PAUSER_ROLE(), guardian)
        ) revert UnexpectedConfiguration("NUSD roles were not recorded");
    }

    /// @notice The last step: once governance has accepted everything, the deployer gives up its
    ///         two NUSD roles. It refuses to run while governance does not yet hold every role.
    function renounce() external {
        _requireChain();
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address governance = vm.envAddress("MAINNET_GOVERNANCE");
        address guardian = vm.envAddress("MAINNET_GUARDIAN");
        if (governance == deployer) revert UnexpectedConfiguration("governance is the deployer: nothing to renounce");
        Deployment memory d = _load();
        _requireGovernanceHolds(d, governance);

        vm.startBroadcast(privateKey);
        // A deployer that is also the guardian keeps the pause role and nothing else.
        if (guardian != deployer) d.nusd.renounceRole(d.nusd.PAUSER_ROLE());
        d.nusd.renounceRole(d.nusd.DEFAULT_ADMIN_ROLE());
        vm.stopBroadcast();

        _validateHandedOver(d, deployer, governance, guardian);
    }

    // ---------------------------------------------------------------- environment

    function _requireChain() private {
        uint256 expectedChainId = vm.envUint("MAINNET_CHAIN_ID");
        if (expectedChainId == TESTNET_CHAIN_ID || block.chainid != expectedChainId) {
            revert WrongChain(expectedChainId, block.chainid);
        }
    }

    function _config(address deployer) private returns (Config memory c) {
        c = Config({
            deployer: deployer,
            wzkltc: vm.envAddress("MAINNET_WZKLTC"),
            ltcFeed: vm.envAddress("MAINNET_DIA_LTC_USD"),
            btcFeed: vm.envAddress("MAINNET_DIA_BTC_USD"),
            ethFeed: vm.envAddress("MAINNET_DIA_ETH_USD")
        });
    }

    function _guards() private returns (Guards memory g) {
        g = Guards({
            oracleMaxAge: vm.envUint("MAINNET_ORACLE_MAX_AGE_SECONDS"),
            mintMaxPriceAge: vm.envUint("MAINNET_MINT_MAX_PRICE_AGE_SECONDS"),
            mintLimitPerHour: vm.envUint("MAINNET_MINT_LIMIT_PER_HOUR_NUSD") * 1 ether,
            mintFeeBps: vm.envUint("MAINNET_MINT_FEE_BPS"),
            redeemFeeBps: vm.envUint("MAINNET_REDEEM_FEE_BPS"),
            feedDeviationBps: vm.envUint("MAINNET_FEED_DEVIATION_BPS"),
            feedHeartbeat: vm.envUint("MAINNET_FEED_HEARTBEAT_SECONDS")
        });
        if (g.mintMaxPriceAge > g.oracleMaxAge) revert UnexpectedConfiguration("mint price age above oracle age");
        if (g.feedHeartbeat == 0 || g.mintMaxPriceAge < g.feedHeartbeat) {
            revert UnexpectedConfiguration("mint price age below the feed's heartbeat");
        }
        if (g.feedDeviationBps == 0 || g.mintFeeBps < g.feedDeviationBps || g.redeemFeeBps < g.feedDeviationBps) {
            revert UnexpectedConfiguration("each NUSD fee must be at least the feed's deviation threshold");
        }
        if (
            g.mintLimitPerHour == 0
                || g.mintLimitPerHour > NUSD_SUPPLY_CEILING * MAX_MINT_BUDGET_SHARE_BPS / 10_000
        ) revert UnexpectedConfiguration("mint budget must be between 1 NUSD and a tenth of the supply ceiling");
    }

    /// @dev Runs in the local simulation; nothing is sent.
    function _checkWrappedNative(address token) private {
        if (token.code.length == 0) revert UnexpectedConfiguration("wrapped zkLTC has no code");
        WrappedNativeProbe probe = new WrappedNativeProbe();
        vm.deal(address(probe), 1);
        probe.check(IWrappedNative(token));
    }

    // ---------------------------------------------------------------- checks

    /// @dev Everything that does not depend on who holds a role.
    function _validateWiring(Deployment memory d, Config memory c, Guards memory g) private view {
        if (
            address(d.ltcOracle.source()) != address(d.ltcAdapter) || address(d.btcOracle.source()) != address(d.btcAdapter)
                || address(d.ethOracle.source()) != address(d.ethAdapter)
        ) revert UnexpectedConfiguration("oracle routers");
        _validateAdapter(d.ltcAdapter, c.ltcFeed, g.oracleMaxAge, LTC_MIN_PRICE, LTC_MAX_PRICE);
        _validateAdapter(d.btcAdapter, c.btcFeed, g.oracleMaxAge, BTC_MIN_PRICE, BTC_MAX_PRICE);
        _validateAdapter(d.ethAdapter, c.ethFeed, g.oracleMaxAge, ETH_MIN_PRICE, ETH_MAX_PRICE);
        _validateLivePrice(d.ltcOracle, LTC_MIN_PRICE, LTC_MAX_PRICE);
        _validateLivePrice(d.btcOracle, BTC_MIN_PRICE, BTC_MAX_PRICE);
        _validateLivePrice(d.ethOracle, ETH_MIN_PRICE, ETH_MAX_PRICE);
        if (
            address(d.nusd.oracle()) != address(d.ltcOracle) || d.nusd.supplyCeilingNusd() != NUSD_SUPPLY_CEILING
                || d.nusd.surplusStaking() != address(d.rewardStaking) || d.nusd.surplusTreasury() != address(d.treasury)
                || d.nusd.surplusTreasuryBps() != SURPLUS_TREASURY_BPS || d.nusd.mintPaused()
        ) revert UnexpectedConfiguration("nusd");
        if (
            d.nusd.mintMaxPriceAge() != g.mintMaxPriceAge || d.nusd.mintLimitPerWindow() != g.mintLimitPerHour
                || d.nusd.mintFeeBps() != g.mintFeeBps || d.nusd.redeemFeeBps() != g.redeemFeeBps
        ) revert UnexpectedConfiguration("oracle-lag guards");
        if (
            d.rewardStaking.harvester() != address(d.feeSplitter) || address(d.rewardStaking.nusd()) != address(d.nusd)
                || d.feeSplitter.staking() != address(d.rewardStaking) || d.feeSplitter.treasury() != address(d.treasury)
                || address(d.feeSplitter.wrappedNative()) != c.wzkltc || address(d.feeSplitter.nusd()) != address(d.nusd)
        ) revert UnexpectedConfiguration("fees and staking");
        if (
            d.pump.feeRecipient() != address(d.feeSplitter) || d.pump.NUSD() != address(d.nusd)
                || address(d.pump.graduationRouter()) != address(d.graduationRouter)
                || d.pump.createFee() != PUMP_CREATE_FEE_NUSD || d.pump.tradeFeeBps() != PUMP_TRADE_FEE_BPS
                || d.pump.initialVirtualNusdReserve() != INITIAL_VIRTUAL_NUSD_RESERVE
                || d.pump.graduationThresholdNusd() != GRADUATION_MARKET_CAP_TARGET_NUSD
                || d.pump.tokenTotalSupply() != PUMP_TOKEN_SUPPLY
        ) revert UnexpectedConfiguration("pump");
        if (
            d.graduationRouter.pump() != address(d.pump) || d.graduationRouter.minimumDelay() != GRADUATION_DELAY
                || d.graduationRouter.lpRecipient() != address(d.locker)
                || d.locker.router() != address(d.graduationRouter)
        ) revert UnexpectedConfiguration("graduation router and locker");
        if (!d.marketplace.collectionAllowed(address(d.pixel)) || address(d.marketplace.nusd()) != address(d.nusd)) {
            revert UnexpectedConfiguration("marketplace");
        }
    }

    function _validateAdapter(
        DIAOracleAdapter adapter,
        address feed,
        uint256 maxAge,
        uint256 minimumPrice,
        uint256 maximumPrice
    ) private view {
        if (
            address(adapter.feed()) != feed || adapter.maxPriceAge() != maxAge || adapter.minPriceWad() != minimumPrice
                || adapter.maxPriceWad() != maximumPrice
        ) revert UnexpectedConfiguration("oracle adapter");
    }

    /// @dev A feed that does not price is the wrong address or a dead feed. A price within a factor
    ///      of two of either bound means the bounds no longer fit the market: one more doubling or
    ///      halving would read as a dead oracle.
    function _validateLivePrice(OracleRouter router, uint256 minimumPrice, uint256 maximumPrice) private view {
        if (!router.isFresh()) revert UnexpectedConfiguration("a feed does not price right now");
        uint256 gasBefore = gasleft();
        (uint256 priceWad,,) = router.readPriceWad();
        if (gasBefore - gasleft() > MAX_WARM_ORACLE_READ_GAS) {
            revert UnexpectedConfiguration("an oracle read costs too much gas");
        }
        if (priceWad < 2 * minimumPrice || priceWad > maximumPrice / 2) {
            revert UnexpectedConfiguration("a live price is within a factor of two of its adapter's bounds");
        }
    }

    /// @dev The state the deploy scripts leave: the deployer key holds every core role. The Pump
    ///      and graduation router admin belong to the deployer until the 0xFi script gives them to
    ///      its graduation controller, which is a contract.
    function _validateDeployerHolds(Deployment memory d, address deployer) private view {
        if (
            d.ltcOracle.admin() != deployer || d.btcOracle.admin() != deployer || d.ethOracle.admin() != deployer
                || d.feeSplitter.admin() != deployer || d.treasury.owner() != deployer
                || d.marketplace.owner() != deployer || d.pump.paramAdmin() != deployer
                || !d.nusd.hasRole(d.nusd.DEFAULT_ADMIN_ROLE(), deployer)
                || !d.nusd.hasRole(d.nusd.PAUSER_ROLE(), deployer)
        ) revert UnexpectedConfiguration("a core role is not with the deployer");
        _validatePumpAdmins(d, deployer);
    }

    function _validatePumpAdmins(Deployment memory d, address deployer) private view {
        address pumpAdmin = d.pump.admin();
        address routerAdmin = d.graduationRouter.admin();
        bool withDeployer = pumpAdmin == deployer && routerAdmin == deployer;
        bool withController = pumpAdmin == routerAdmin && pumpAdmin.code.length != 0;
        if (!withDeployer && !withController) revert UnexpectedConfiguration("pump and graduation router admin");
    }

    function _requireGovernanceHolds(Deployment memory d, address governance) private view {
        if (
            d.ltcOracle.admin() != governance || d.btcOracle.admin() != governance || d.ethOracle.admin() != governance
                || d.feeSplitter.admin() != governance || d.treasury.owner() != governance
                || d.marketplace.owner() != governance || d.pump.paramAdmin() != governance
                || !d.nusd.hasRole(d.nusd.DEFAULT_ADMIN_ROLE(), governance)
                || !d.nusd.hasRole(d.nusd.PAUSER_ROLE(), governance)
        ) revert UnexpectedConfiguration("governance does not hold every core role yet");
    }

    /// @dev The state after the handover: governance holds every role, nothing is pending, and the
    ///      deployer holds none. The Pump and its graduation router belong to the controller.
    function _validateHandedOver(Deployment memory d, address deployer, address governance, address guardian)
        private
        view
    {
        _requireGovernanceHolds(d, governance);
        if (
            d.ltcOracle.pendingAdmin() != address(0) || d.btcOracle.pendingAdmin() != address(0)
                || d.ethOracle.pendingAdmin() != address(0) || d.feeSplitter.pendingAdmin() != address(0)
                || d.treasury.pendingOwner() != address(0) || d.marketplace.pendingOwner() != address(0)
                || d.pump.pendingParamAdmin() != address(0)
        ) revert UnexpectedConfiguration("a transfer is still pending");
        if (!d.nusd.hasRole(d.nusd.PAUSER_ROLE(), guardian)) revert UnexpectedConfiguration("guardian cannot pause NUSD minting");
        if (
            deployer != governance
                && (
                    d.nusd.hasRole(d.nusd.DEFAULT_ADMIN_ROLE(), deployer)
                        || (deployer != guardian && d.nusd.hasRole(d.nusd.PAUSER_ROLE(), deployer))
                )
        ) revert UnexpectedConfiguration("the deployer still holds a NUSD role");
        address pumpAdmin = d.pump.admin();
        if (pumpAdmin != d.graduationRouter.admin() || pumpAdmin.code.length == 0 || pumpAdmin == governance) {
            revert UnexpectedConfiguration("pump and graduation router admin");
        }
    }

    // ---------------------------------------------------------------- manifest

    function _manifestPath() private returns (string memory) {
        return string.concat("./deployments/mainnet-core", vm.envOr("MAINNET_MANIFEST_SUFFIX", string("")), ".json");
    }

    function _writeManifest(Deployment memory d, Config memory c, Guards memory g) private {
        string memory key = "core";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "scriptBlock", block.number);
        vm.serializeAddress(key, "deployer", c.deployer);
        vm.serializeAddress(key, "wzkLTC", c.wzkltc);
        // What the guards were set from, so a second person can compare them with the feed's
        // published parameters.
        vm.serializeAddress(key, "ltcFeed", c.ltcFeed);
        vm.serializeAddress(key, "btcFeed", c.btcFeed);
        vm.serializeAddress(key, "ethFeed", c.ethFeed);
        vm.serializeUint(key, "feedHeartbeatSeconds", g.feedHeartbeat);
        vm.serializeUint(key, "feedDeviationBps", g.feedDeviationBps);
        vm.serializeUint(key, "oracleMaxAgeSeconds", g.oracleMaxAge);
        vm.serializeUint(key, "mintMaxPriceAgeSeconds", g.mintMaxPriceAge);
        vm.serializeUint(key, "mintLimitPerHourNusd", g.mintLimitPerHour / 1 ether);
        vm.serializeUint(key, "mintFeeBps", g.mintFeeBps);
        vm.serializeUint(key, "redeemFeeBps", g.redeemFeeBps);
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
        vm.writeJson(json, _manifestPath());
    }

    function _load() private returns (Deployment memory d) {
        string memory json = vm.readFile(_manifestPath());
        d.ltcAdapter = DIAOracleAdapter(vm.parseJsonAddress(json, ".ltcAdapter"));
        d.btcAdapter = DIAOracleAdapter(vm.parseJsonAddress(json, ".btcAdapter"));
        d.ethAdapter = DIAOracleAdapter(vm.parseJsonAddress(json, ".ethAdapter"));
        d.ltcOracle = OracleRouter(vm.parseJsonAddress(json, ".ltcOracle"));
        d.btcOracle = OracleRouter(vm.parseJsonAddress(json, ".btcOracle"));
        d.ethOracle = OracleRouter(vm.parseJsonAddress(json, ".ethOracle"));
        d.nusd = OracleNUSDv2(payable(vm.parseJsonAddress(json, ".nusd")));
        d.treasury = OwnerTreasury(payable(vm.parseJsonAddress(json, ".treasury")));
        d.rewardStaking = RewardStaking(vm.parseJsonAddress(json, ".rewardStaking"));
        d.feeSplitter = FeeSplitter(payable(vm.parseJsonAddress(json, ".feeSplitter")));
        d.locker = PermanentLiquidityLocker(vm.parseJsonAddress(json, ".pumpLiquidityLocker"));
        d.graduationRouter = GraduationRouter(vm.parseJsonAddress(json, ".pumpGraduationRouter"));
        d.pump = ZeroXPumpV2(vm.parseJsonAddress(json, ".pump"));
        d.pixel = ZeroXPixelV2(vm.parseJsonAddress(json, ".pixel"));
        d.marketplace = NusdNftMarketplaceV2(vm.parseJsonAddress(json, ".nusdMarketplace"));
        if (address(d.nusd).code.length == 0 || address(d.pump).code.length == 0) {
            revert UnexpectedConfiguration("the manifest does not describe this chain");
        }
    }
}
