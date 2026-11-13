// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {RoleControl} from "../common/RoleControl.sol";
import {SafeTransferLib} from "../common/SafeTransferLib.sol";
import {IPriceOracle} from "../oracle/IPriceOracle.sol";

/// @title NUSD
/// @notice Nothing USD, backed by native zkLTC and priced through an oracle router.
///         - Mint: zkLTC worth $1 at the oracle mints 1 NUSD, minus an optional fee that stays in
///           the reserve. The supply ceiling doubles by itself once 80% of it is used, at most once
///           every 7 days, so growth never waits for an admin while a bad price stays bounded.
///         - Redeem: pays the lower of the oracle value and the holder's proportional share of the
///           reserve. While the reserve covers supply that is exactly $1; below that every holder
///           takes the same haircut, so there is no run to win, and the zkLTC stays in reserve to
///           restore the peg when LTC recovers. Redemption can never be paused.
///         - Surplus: once the reserve reaches 3.3x supply, anyone can mint the excess over 3.0x,
///           at most once every 7 days and at most a tenth of the supply each time (what a release
///           exactly at 3.3x mints): 80% to the staking pool, 20% to the treasury. A larger surplus
///           goes out over the following weeks, so one wrong or short-lived price cannot mint more
///           than that step. A release the ceiling has no room for waits; it is never cut down,
///           and it lifts the ceiling when a mint of one wei would (80% used, a week since the
///           last raise).
///           NUSD redeemed in the last one to two weeks still counts as supply for the 3.3x test
///           (not for the size of the step), so redeeming and minting back cannot force a release
///           that the lasting supply would not have earned.
///         - Oracle lag: a price is only exact when it is fresh, so minting (and the surplus
///           release) also needs a price no older than `mintMaxPriceAge`, minting draws on a budget
///           that refills over an hour, a redemption against a price older than `mintMaxPriceAge`
///           pays the maximum fee, and the mint and redeem fees (up to 2%) can each be set at or
///           above the feed's deviation threshold. Together they bound what anyone can extract
///           from a lagging feed.
///         - Oracle failure: anyone can report an oracle that cannot price. If no mint, redemption,
///           surplus release or transfer of NUSD finds it pricing during the next 7 days, holders
///           can leave with their proportional share of the reserve for as long as it stays down.
///         The admin of this contract changes bounded parameters only: it cannot pause
///         redemption, move the reserve or mint outside these rules. The price itself is the
///         oracle's, so whoever chooses the oracle's source is trusted with it.
contract OracleNUSDv2 is RoleControl, ReentrancyGuard {
    error InvalidOracle();
    error InvalidSupplyCeiling();
    error InvalidAmount();
    error InvalidRecipient();
    error InvalidFee();
    error InvalidSurplusRatios();
    error InvalidSurplusSplit();
    error InvalidMintGuards();
    error StaleMintPrice(uint256 updatedAt, uint256 maxAge);
    error MintRateLimited(uint256 requestedAmountNusd, uint256 availableAmountNusd);
    error MintPaused();
    error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount);
    error SupplyCeilingExceeded(uint256 requestedAmountNusd, uint256 availableAmountNusd);
    error OracleHealthy();
    error OracleFailureNotReported();
    error OracleUnavailable();
    error OracleFailureGracePending(uint256 availableAt);
    error SurplusRecipientUnset();
    error SurplusTooSoon(uint256 availableAt);
    error SurplusBelowTrigger(uint256 reserveValueNusd, uint256 supplyNusd);
    error ERC20InvalidAddress();
    error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount);
    error ERC20InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requiredAmount);

    string public constant name = "Nothing USD";
    string public constant symbol = "NUSD";
    uint8 public constant decimals = 18;
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS = 10_000;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice How long the oracle must stay unusable before the price-free exit opens.
    uint256 public constant ORACLE_FAILURE_GRACE = 7 days;
    /// @notice Gas a transfer spends at most on checking whether a reported oracle prices again.
    uint256 public constant ORACLE_PROBE_GAS = 200_000;
    /// @notice Mint and redeem fees can be raised to the feed's deviation threshold, never above 2%.
    uint256 public constant MAX_FEE_BPS = 200;
    /// @notice A spent mint budget is whole again after this period.
    uint256 public constant MINT_WINDOW = 1 hours;
    uint256 public constant MIN_MINT_PRICE_AGE = 1 minutes;
    uint256 public constant MAX_MINT_PRICE_AGE = 1 days;
    /// @notice The ceiling doubles once supply uses 80% of it, at most once per interval.
    uint256 public constant CEILING_RAISE_USAGE_BPS = 8_000;
    uint256 public constant CEILING_RAISE_INTERVAL = 7 days;
    uint256 public constant SURPLUS_INTERVAL = 7 days;
    /// @notice The surplus floor can never be set below 1.5x supply ...
    uint256 public constant MIN_SURPLUS_FLOOR_BPS = 15_000;
    /// @notice ... the trigger always sits at least 0.1x above the floor ...
    uint256 public constant MIN_SURPLUS_GAP_BPS = 1_000;
    /// @notice ... and the treasury never takes more than 20% of a release.
    uint256 public constant MAX_SURPLUS_TREASURY_BPS = 2_000;

    IPriceOracle public immutable oracle;

    uint256 public totalSupply;
    uint256 public totalCollateralWei;

    // One slot: the ceiling and the clocks.
    uint96 public supplyCeilingNusd;
    uint40 public lastCeilingRaiseAt;
    uint40 public lastSurplusReleaseAt;
    /// @notice First time anyone observed the oracle failing; zero while it is healthy.
    uint40 public oracleFailureReportedAt;

    // One slot: everything the mint path reads besides supply, reserve and ceiling.
    address public surplusStaking;
    uint16 public mintFeeBps;
    uint16 public redeemFeeBps;
    uint16 public surplusFloorBps = 30_000;
    uint16 public surplusTriggerBps = 33_000;
    bool public mintPaused;

    address public surplusTreasury;
    uint16 public surplusTreasuryBps = 2_000;

    // One slot: the oracle-lag guards.
    /// @notice The mint budget: at most this much NUSD at once, refilled evenly over MINT_WINDOW
    ///         (unlimited until the admin sets it).
    uint96 public mintLimitPerWindow = type(uint96).max;
    /// @notice NUSD counted against the budget as of `mintWindowStart`; it drains as time passes.
    uint96 public mintedInWindow;
    uint40 public mintWindowStart;
    /// @notice Oldest price, in seconds, a mint or surplus release accepts. A redemption against
    ///         an older price pays MAX_FEE_BPS. Keep it at or above the feed's heartbeat: a calm
    ///         market leaves a price that old, and it should not cost redeemers the maximum fee.
    uint24 public mintMaxPriceAge = 90 minutes;

    // One slot: the highest supply a redemption started from, this week and last (surplusSupplyBasis).
    uint96 private _peakSupplyThisEpoch;
    uint96 private _peakSupplyLastEpoch;
    uint32 private _peakEpoch;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MintedAtOracle(address indexed payer, address indexed recipient, uint256 collateralInWei, uint256 amountNusd);
    event RedeemedAtOracle(
        address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei
    );
    event ReserveCovered(address indexed payer, uint256 amountWei, uint256 totalCollateralWei);
    event OracleFailureReported(address indexed reporter, uint256 reportedAt);
    event OracleFailureCleared(address indexed caller);
    event EmergencyRedeemed(
        address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei
    );
    event SurplusReleased(
        address indexed caller,
        uint256 toStakingNusd,
        uint256 toTreasuryNusd,
        uint256 reserveValueNusd,
        uint256 supplyAfterNusd
    );
    event Burned(address indexed account, uint256 amountNusd);
    event MintPauseUpdated(bool paused);
    event FeesUpdated(uint256 mintFeeBps, uint256 redeemFeeBps);
    event SupplyCeilingUpdated(uint256 supplyCeilingNusd, bool automatic);
    event SurplusRecipientsUpdated(address indexed staking, address indexed treasury, uint256 treasuryBps);
    event SurplusRatiosUpdated(uint256 floorBps, uint256 triggerBps);
    event MintGuardsUpdated(uint256 maxPriceAge, uint256 limitPerWindow);

    constructor(IPriceOracle priceOracle, address initialAdmin, uint256 supplyCeilingNusd_)
        RoleControl(initialAdmin)
    {
        if (address(priceOracle).code.length == 0) revert InvalidOracle();
        if (supplyCeilingNusd_ == 0 || supplyCeilingNusd_ > type(uint96).max) revert InvalidSupplyCeiling();

        oracle = priceOracle;
        // forge-lint: disable-next-line(unsafe-typecast)
        supplyCeilingNusd = uint96(supplyCeilingNusd_);
        _grantRole(PAUSER_ROLE, initialAdmin);
    }

    receive() external payable {
        _coverReserve(msg.sender, msg.value);
    }

    function vault() external view returns (address) {
        return address(this);
    }

    // ---------------------------------------------------------------- ERC-20

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ERC20InvalidAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (from == address(0)) revert ERC20InvalidAddress();
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    // ---------------------------------------------------------------- mint and redeem

    function quoteMint(uint256 collateralWei) public view returns (uint256 amountNusd) {
        uint256 grossNusd = _valueOf(collateralWei);
        amountNusd = grossNusd - MathX.mulDiv(grossNusd, mintFeeBps, BPS);
    }

    function mintAtOracle(uint256 minNusdOut, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 amountNusd)
    {
        if (mintPaused) revert MintPaused();
        if (msg.value == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        _requireFreshPrice();
        _clearOracleFailure();
        amountNusd = quoteMint(msg.value);
        if (amountNusd == 0) revert InvalidAmount();
        if (amountNusd < minNusdOut) revert SlippageExceeded(minNusdOut, amountNusd);

        uint256 supply = totalSupply;
        uint256 ceiling = _raiseCeilingIfDue(supply + amountNusd);
        uint256 availableAmountNusd = ceiling > supply ? ceiling - supply : 0;
        if (amountNusd > availableAmountNusd) revert SupplyCeilingExceeded(amountNusd, availableAmountNusd);

        _consumeMintBudget(amountNusd);

        // The whole deposit joins the reserve; the fee is the NUSD that was not minted for it.
        totalCollateralWei += msg.value;
        _mint(recipient, amountNusd);

        emit MintedAtOracle(msg.sender, recipient, msg.value, amountNusd);
    }

    /// @notice zkLTC paid for `amountNusd`: the lower of its oracle value and its share of the
    ///         reserve, minus the redeem fee (which stays in the reserve). The fee is
    ///         `redeemFeeBps`, or MAX_FEE_BPS while the price is older than `mintMaxPriceAge`:
    ///         redemption never waits for a fresher price, it pays for the risk of an old one.
    function quoteRedeem(uint256 amountNusd) public view returns (uint256 collateralOutWei) {
        uint256 supply = totalSupply;
        if (amountNusd == 0 || amountNusd > supply) return 0;
        (uint256 priceWad, uint256 updatedAt,) = oracle.readPriceWad();
        uint256 atOracle = MathX.mulDiv(amountNusd, WAD, priceWad);
        uint256 proRata = MathX.mulDiv(amountNusd, totalCollateralWei, supply);
        uint256 gross = MathX.min(atOracle, proRata);
        // forge-lint: disable-next-line(block-timestamp)
        bool fresh = updatedAt <= block.timestamp && block.timestamp - updatedAt <= mintMaxPriceAge;
        collateralOutWei = gross - MathX.mulDiv(gross, fresh ? redeemFeeBps : MAX_FEE_BPS, BPS);
    }

    function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        nonReentrant
        returns (uint256 collateralOutWei)
    {
        if (amountNusd == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        collateralOutWei = quoteRedeem(amountNusd);
        if (collateralOutWei == 0) revert InvalidAmount();
        if (collateralOutWei < minCollateralOutWei) revert SlippageExceeded(minCollateralOutWei, collateralOutWei);

        _clearOracleFailure();
        _recordSupplyPeak(totalSupply);
        _burn(msg.sender, amountNusd);
        totalCollateralWei -= collateralOutWei;
        SafeTransferLib.safeTransferNative(recipient, collateralOutWei);

        emit RedeemedAtOracle(msg.sender, recipient, amountNusd, collateralOutWei);
    }

    // ---------------------------------------------------------------- oracle failure exit

    /// @notice Starts the failure clock. Permissionless; only succeeds while the oracle cannot price.
    function reportOracleFailure() external {
        if (_oracleUsable()) revert OracleHealthy();
        if (oracleFailureReportedAt != 0) return;
        // The grace period is measured in wall-clock time by design.
        // forge-lint: disable-next-line(block-timestamp)
        oracleFailureReportedAt = uint40(block.timestamp);
        emit OracleFailureReported(msg.sender, block.timestamp);
    }

    /// @notice Stops the failure clock once the oracle prices again. Permissionless, and every
    ///         mint, redemption, surplus release and transfer of NUSD does the same: each one that
    ///         finds the oracle pricing proves it works, so the report it meets is void.
    function clearOracleFailure() external {
        if (!_oracleUsable()) revert OracleUnavailable();
        _clearOracleFailure();
    }

    /// @notice When the price-free exit opens, provided the report is still standing then; zero
    ///         while no failure is reported.
    function oracleFailureExitAt() public view returns (uint256) {
        uint256 reportedAt = oracleFailureReportedAt;
        return reportedAt == 0 ? 0 : reportedAt + ORACLE_FAILURE_GRACE;
    }

    /// @notice Price-free exit once the oracle has been unusable for ORACLE_FAILURE_GRACE: pays each
    ///         holder their proportional share of the reserve, so the order of exits does not matter.
    function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        nonReentrant
        returns (uint256 collateralOutWei)
    {
        uint256 availableAt = oracleFailureExitAt();
        if (availableAt == 0) revert OracleFailureNotReported();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < availableAt) revert OracleFailureGracePending(availableAt);
        if (_oracleUsable()) revert OracleHealthy();
        if (amountNusd == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        collateralOutWei = MathX.mulDiv(amountNusd, totalCollateralWei, totalSupply);
        if (collateralOutWei == 0) revert InvalidAmount();
        if (collateralOutWei < minCollateralOutWei) revert SlippageExceeded(minCollateralOutWei, collateralOutWei);
        _recordSupplyPeak(totalSupply);
        _burn(msg.sender, amountNusd);
        totalCollateralWei -= collateralOutWei;
        SafeTransferLib.safeTransferNative(recipient, collateralOutWei);
        emit EmergencyRedeemed(msg.sender, recipient, amountNusd, collateralOutWei);
    }

    // ---------------------------------------------------------------- reserve and surplus

    function reserveValueNusd() public view returns (uint256 valueNusd) {
        valueNusd = _valueOf(totalCollateralWei);
    }

    /// @notice Reserve value over supply, in WAD (1e18 = fully backed). Max uint while nothing is minted.
    function backingRatioWad() external view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return type(uint256).max;
        return MathX.mulDiv(reserveValueNusd(), WAD, supply);
    }

    /// @notice Burns the caller's NUSD. The collateral stays, so every burn raises the reserve ratio.
    function burn(uint256 amountNusd) external {
        if (amountNusd == 0) revert InvalidAmount();
        _burn(msg.sender, amountNusd);
        emit Burned(msg.sender, amountNusd);
    }

    function coverReserve() external payable {
        _coverReserve(msg.sender, msg.value);
    }

    /// @notice The supply a surplus release is measured against: the current supply, or the highest
    ///         supply a redemption started from in this 7-day epoch or the one before, whichever is
    ///         larger. A redemption therefore lifts the ratio a release sees only once it has stayed
    ///         out for a whole epoch: 7 to 14 days. A plain burn is not remembered, because its
    ///         collateral stays in the reserve; it counts at once unless a redemption in this epoch
    ///         or the last started from a higher supply.
    function surplusSupplyBasis() public view returns (uint256 basis) {
        basis = totalSupply;
        // forge-lint: disable-next-line(block-timestamp)
        uint256 epoch = block.timestamp / SURPLUS_INTERVAL;
        uint256 peakEpoch = _peakEpoch;
        uint256 peak;
        if (epoch == peakEpoch) {
            peak = _peakSupplyThisEpoch > _peakSupplyLastEpoch ? _peakSupplyThisEpoch : _peakSupplyLastEpoch;
        } else if (epoch == peakEpoch + 1) {
            peak = _peakSupplyThisEpoch;
        }
        if (peak > basis) basis = peak;
    }

    /// @notice NUSD a release would mint now and whether its surplus conditions hold.
    /// @dev `amountNusd` is the reserve's excess over the floor, at most one step, and zero when the
    ///      ceiling (doubled first if the supply uses 80% of it and the last raise is a week old)
    ///      has no room for all of it. Below the trigger it only shows how much is above the floor. `ready` covers the trigger, the weekly timer, the pause and the recipients.
    ///      A release also needs a price fresh enough to mint against (`mintMaxPriceAge`), which
    ///      this view does not check. Reverts while the oracle cannot price, like every other
    ///      price-dependent path.
    function surplusMintCapacity() public view returns (uint256 amountNusd, bool ready) {
        uint256 supply = totalSupply;
        uint256 basis = surplusSupplyBasis();
        uint256 reserveValue = _valueOf(totalCollateralWei);
        uint256 floorBps = surplusFloorBps;
        uint256 triggerBps = surplusTriggerBps;
        bool triggered = reserveValue * BPS >= basis * triggerBps && reserveValue != 0;
        uint256 target = MathX.mulDiv(reserveValue, BPS, floorBps);
        amountNusd = target > basis ? target - basis : 0;
        // One release mints at most a step: what a release exactly at the trigger mints, a tenth of
        // the supply at 3.3x over 3.0x. The price a release trusts can be wrong, or a peak that is
        // gone an hour later, and unlike a mint the release draws on no hourly budget; this bounds
        // what one such price can mint. The step follows the supply that exists, not the
        // remembered one: supply that was redeemed must not make a release larger, and with no
        // supply there is nothing to release into. A real surplus beyond it follows in later weeks.
        uint256 step = MathX.mulDiv(supply, triggerBps - floorBps, floorBps);
        if (amountNusd > step) amountNusd = step;
        // A release is whole or it waits. Cut down to the last of the ceiling's headroom it would
        // use up the week for dust and leave minting closed until the ceiling can rise. It lifts
        // the ceiling exactly when a mint of one wei would: when the supply already uses 80% of it
        // and the last raise is a week old. At the default ratios a step that does not fit means
        // the supply is past 90% of the ceiling, so a release never waits for somebody to mint.
        (uint256 ceiling,) = _ceilingFor(supply);
        uint256 headroom = ceiling > supply ? ceiling - supply : 0;
        if (amountNusd > headroom) amountNusd = 0;
        // forge-lint: disable-next-line(block-timestamp)
        bool due = block.timestamp >= uint256(lastSurplusReleaseAt) + SURPLUS_INTERVAL;
        ready = triggered && due && amountNusd != 0 && !mintPaused && surplusStaking != address(0)
            && surplusTreasury != address(0);
    }

    /// @notice Mints the reserve's excess over the floor, one step at a time (surplusMintCapacity):
    ///         80% to the staking pool, 20% to the treasury by default. Permissionless, at most
    ///         once per SURPLUS_INTERVAL, only above the trigger, always against a fresh price,
    ///         never while minting is paused.
    function releaseSurplus() external nonReentrant returns (uint256 amountNusd) {
        if (mintPaused) revert MintPaused();
        address staking = surplusStaking;
        address treasury = surplusTreasury;
        if (staking == address(0) || treasury == address(0)) revert SurplusRecipientUnset();
        uint256 nextAt = uint256(lastSurplusReleaseAt) + SURPLUS_INTERVAL;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < nextAt) revert SurplusTooSoon(nextAt);

        bool ready;
        _requireFreshPrice();
        _clearOracleFailure();
        (amountNusd, ready) = surplusMintCapacity();
        uint256 reserveValue = _valueOf(totalCollateralWei);
        if (!ready) revert SurplusBelowTrigger(reserveValue, surplusSupplyBasis());

        _raiseCeilingIfDue(totalSupply);
        lastSurplusReleaseAt = uint40(block.timestamp);
        uint256 toTreasury = MathX.mulDiv(amountNusd, surplusTreasuryBps, BPS);
        uint256 toStaking = amountNusd - toTreasury;
        if (toStaking != 0) _mint(staking, toStaking);
        if (toTreasury != 0) _mint(treasury, toTreasury);
        emit SurplusReleased(msg.sender, toStaking, toTreasury, reserveValue, totalSupply);
    }

    // ---------------------------------------------------------------- pauser and admin

    /// @notice Stops minting and the surplus release, the two paths that create NUSD against the
    ///         oracle price. Redemption is not affected. Any pauser can stop them; only the admin
    ///         can start them again, so a pause-only key cannot lift a pause. With no admin left a
    ///         pause is permanent: revoke every pauser before the admin role is ever given up.
    function setMintPaused(bool paused) external {
        bytes32 role = paused ? PAUSER_ROLE : DEFAULT_ADMIN_ROLE;
        if (!hasRole(role, msg.sender)) revert MissingRole(role, msg.sender);
        mintPaused = paused;
        emit MintPauseUpdated(paused);
    }

    function setFees(uint256 newMintFeeBps, uint256 newRedeemFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMintFeeBps > MAX_FEE_BPS || newRedeemFeeBps > MAX_FEE_BPS) revert InvalidFee();
        // forge-lint: disable-next-line(unsafe-typecast)
        mintFeeBps = uint16(newMintFeeBps);
        // forge-lint: disable-next-line(unsafe-typecast)
        redeemFeeBps = uint16(newRedeemFeeBps);
        emit FeesUpdated(newMintFeeBps, newRedeemFeeBps);
    }

    /// @notice A ceiling only limits new mints; it can never sit below what already exists.
    function setSupplyCeiling(uint256 newCeiling) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCeiling == 0 || newCeiling < totalSupply || newCeiling > type(uint96).max) {
            revert InvalidSupplyCeiling();
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        supplyCeilingNusd = uint96(newCeiling);
        emit SupplyCeilingUpdated(newCeiling, false);
    }

    function setSurplusRecipients(address staking, address treasury, uint256 treasuryBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (staking == address(0) || treasury == address(0) || staking == treasury) revert InvalidRecipient();
        if (treasuryBps > MAX_SURPLUS_TREASURY_BPS) revert InvalidSurplusSplit();
        surplusStaking = staking;
        surplusTreasury = treasury;
        // forge-lint: disable-next-line(unsafe-typecast)
        surplusTreasuryBps = uint16(treasuryBps);
        emit SurplusRecipientsUpdated(staking, treasury, treasuryBps);
    }

    /// @notice Oracle-lag guards: the oldest price a mint accepts and the size of the mint budget.
    function setMintGuards(uint256 maxPriceAge, uint256 limitPerWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            maxPriceAge < MIN_MINT_PRICE_AGE || maxPriceAge > MAX_MINT_PRICE_AGE || limitPerWindow == 0
                || limitPerWindow > type(uint96).max
        ) revert InvalidMintGuards();
        // forge-lint: disable-next-line(unsafe-typecast)
        mintMaxPriceAge = uint24(maxPriceAge);
        // forge-lint: disable-next-line(unsafe-typecast)
        mintLimitPerWindow = uint96(limitPerWindow);
        emit MintGuardsUpdated(maxPriceAge, limitPerWindow);
    }

    /// @notice NUSD that can be minted right now. The budget refills evenly, so no more than
    ///         `mintLimitPerWindow` can be minted at once and no more than twice that in any hour.
    function mintAvailableInWindow() public view returns (uint256) {
        uint256 limit = mintLimitPerWindow;
        uint256 used = _mintBudgetUsed(limit);
        return used >= limit ? 0 : limit - used;
    }

    function setSurplusRatios(uint256 floorBps, uint256 triggerBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            floorBps < MIN_SURPLUS_FLOOR_BPS || triggerBps < floorBps + MIN_SURPLUS_GAP_BPS
                || triggerBps > type(uint16).max
        ) revert InvalidSurplusRatios();
        // forge-lint: disable-next-line(unsafe-typecast)
        surplusFloorBps = uint16(floorBps);
        // forge-lint: disable-next-line(unsafe-typecast)
        surplusTriggerBps = uint16(triggerBps);
        emit SurplusRatiosUpdated(floorBps, triggerBps);
    }

    // ---------------------------------------------------------------- internals

    /// @dev The ceiling that applies to a supply of `supplyAfter`: doubled when that supply uses
    ///      80% of it and the last raise is a week old.
    function _ceilingFor(uint256 supplyAfter) private view returns (uint256 ceiling, bool raised) {
        ceiling = supplyCeilingNusd;
        if (
            supplyAfter * BPS >= ceiling * CEILING_RAISE_USAGE_BPS
            // forge-lint: disable-next-line(block-timestamp)
            && block.timestamp >= uint256(lastCeilingRaiseAt) + CEILING_RAISE_INTERVAL
        ) {
            uint256 doubled = MathX.min(ceiling * 2, type(uint96).max);
            if (doubled > ceiling) return (doubled, true);
        }
    }

    /// @dev Doubles the ceiling when `supplyAfter` uses 80% of it and the last raise is a week
    ///      old. A mint passes the supply after it, a surplus release the supply before it.
    function _raiseCeilingIfDue(uint256 supplyAfter) private returns (uint256 ceiling) {
        bool raised;
        (ceiling, raised) = _ceilingFor(supplyAfter);
        if (raised) {
            // forge-lint: disable-next-line(unsafe-typecast)
            supplyCeilingNusd = uint96(ceiling);
            lastCeilingRaiseAt = uint40(block.timestamp);
            emit SupplyCeilingUpdated(ceiling, true);
        }
    }

    function _requireFreshPrice() private view {
        (, uint256 updatedAt,) = oracle.readPriceWad();
        uint256 maxAge = mintMaxPriceAge;
        // forge-lint: disable-next-line(block-timestamp)
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) revert StaleMintPrice(updatedAt, maxAge);
    }

    /// @dev NUSD still counted against the mint budget: what was counted at the last mint, less
    ///      what has refilled since.
    function _mintBudgetUsed(uint256 limit) private view returns (uint256 used) {
        used = mintedInWindow;
        // forge-lint: disable-next-line(block-timestamp)
        uint256 elapsed = block.timestamp - mintWindowStart;
        if (used == 0 || elapsed >= MINT_WINDOW) return 0;
        uint256 refilled = MathX.mulDiv(limit, elapsed, MINT_WINDOW);
        used = used > refilled ? used - refilled : 0;
    }

    /// @dev Counts a mint against the budget.
    function _consumeMintBudget(uint256 amountNusd) private {
        uint256 limit = mintLimitPerWindow;
        uint256 used = _mintBudgetUsed(limit);
        uint256 available = used >= limit ? 0 : limit - used;
        if (amountNusd > available) revert MintRateLimited(amountNusd, available);
        // used + amountNusd is at most the limit, which fits 96 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        mintedInWindow = uint96(used + amountNusd);
        mintWindowStart = uint40(block.timestamp);
    }

    function _valueOf(uint256 collateralWei) private view returns (uint256) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        return MathX.mulDiv(collateralWei, priceWad, WAD);
    }

    function _oracleUsable() private view returns (bool) {
        try oracle.readPriceWad() returns (uint256 priceWad, uint256, uint80) {
            return priceWad != 0;
        } catch {
            return false;
        }
    }

    function _clearOracleFailure() private {
        if (oracleFailureReportedAt == 0) return;
        oracleFailureReportedAt = 0;
        emit OracleFailureCleared(msg.sender);
    }

    function _coverReserve(address payer, uint256 amountWei) private {
        if (amountWei == 0) revert InvalidAmount();
        totalCollateralWei += amountWei;
        emit ReserveCovered(payer, amountWei, totalCollateralWei);
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ERC20InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert ERC20InsufficientBalance(from, balance, amount);

        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);

        // NUSD changing hands while the oracle prices shows the oracle works, so a standing failure
        // report is void. The read gets a fixed amount of gas: a broken oracle cannot make
        // transfers unaffordable, and a read that fails for any reason leaves the report in place.
        if (oracleFailureReportedAt != 0) {
            (bool ok, bytes memory data) =
                address(oracle).staticcall{gas: ORACLE_PROBE_GAS}(abi.encodeCall(IPriceOracle.readPriceWad, ()));
            if (ok && data.length >= 32 && abi.decode(data, (uint256)) != 0) _clearOracleFailure();
        }
    }

    function _mint(address recipient, uint256 amount) private {
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function _burn(address account, uint256 amount) private {
        uint256 balance = balanceOf[account];
        if (balance < amount) revert ERC20InsufficientBalance(account, balance, amount);

        unchecked {
            balanceOf[account] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(account, address(0), amount);
    }

    /// @dev Remembers the supply a redemption starts from, per 7-day epoch.
    function _recordSupplyPeak(uint256 supplyBefore) private {
        // forge-lint: disable-next-line(block-timestamp)
        uint256 epoch = block.timestamp / SURPLUS_INTERVAL;
        uint256 peakEpoch = _peakEpoch;
        // Supply never exceeds the 96-bit ceiling, and the epoch number fits 32 bits.
        if (epoch == peakEpoch) {
            // forge-lint: disable-next-line(unsafe-typecast)
            if (supplyBefore > _peakSupplyThisEpoch) _peakSupplyThisEpoch = uint96(supplyBefore);
        } else {
            _peakSupplyLastEpoch = epoch == peakEpoch + 1 ? _peakSupplyThisEpoch : 0;
            // forge-lint: disable-next-line(unsafe-typecast)
            _peakSupplyThisEpoch = uint96(supplyBefore);
            // forge-lint: disable-next-line(unsafe-typecast)
            _peakEpoch = uint32(epoch);
        }
    }

    function _spendAllowance(address owner, address spender, uint256 amount) private {
        uint256 currentAllowance = allowance[owner][spender];
        if (currentAllowance == type(uint256).max) return;
        if (currentAllowance < amount) {
            revert ERC20InsufficientAllowance(owner, spender, currentAllowance, amount);
        }

        unchecked {
            allowance[owner][spender] = currentAllowance - amount;
        }
        emit Approval(owner, spender, allowance[owner][spender]);
    }
}
