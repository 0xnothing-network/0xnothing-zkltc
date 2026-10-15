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
///         - Surplus: once the reserve reaches 3.3x supply, anyone can mint the excess down to 3.0x,
///           at most once every 7 days: 80% to the staking pool, 20% to the treasury.
///         The admin changes bounded parameters only; nobody can pause redemption, move the
///         reserve or mint outside these rules.
contract OracleNUSDv2 is RoleControl, ReentrancyGuard {
    error InvalidOracle();
    error InvalidSupplyCeiling();
    error InvalidAmount();
    error InvalidRecipient();
    error InvalidFee();
    error InvalidSurplusRatios();
    error InvalidSurplusSplit();
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
    uint256 public constant MAX_FEE_BPS = 50;
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

        amountNusd = quoteMint(msg.value);
        if (amountNusd == 0) revert InvalidAmount();
        if (amountNusd < minNusdOut) revert SlippageExceeded(minNusdOut, amountNusd);

        uint256 supply = totalSupply;
        uint256 ceiling = _raiseCeilingIfDue(supply + amountNusd);
        uint256 availableAmountNusd = ceiling > supply ? ceiling - supply : 0;
        if (amountNusd > availableAmountNusd) revert SupplyCeilingExceeded(amountNusd, availableAmountNusd);

        // The whole deposit joins the reserve; the fee is the NUSD that was not minted for it.
        totalCollateralWei += msg.value;
        _mint(recipient, amountNusd);

        emit MintedAtOracle(msg.sender, recipient, msg.value, amountNusd);
    }

    /// @notice zkLTC paid for `amountNusd`: the lower of its oracle value and its share of the
    ///         reserve, minus the redeem fee (which stays in the reserve).
    function quoteRedeem(uint256 amountNusd) public view returns (uint256 collateralOutWei) {
        uint256 supply = totalSupply;
        if (amountNusd == 0 || amountNusd > supply) return 0;
        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 atOracle = MathX.mulDiv(amountNusd, WAD, priceWad);
        uint256 proRata = MathX.mulDiv(amountNusd, totalCollateralWei, supply);
        uint256 gross = MathX.min(atOracle, proRata);
        collateralOutWei = gross - MathX.mulDiv(gross, redeemFeeBps, BPS);
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

    /// @notice Stops the failure clock once the oracle prices again. Permissionless.
    function clearOracleFailure() external {
        if (!_oracleUsable()) revert OracleUnavailable();
        if (oracleFailureReportedAt == 0) return;
        oracleFailureReportedAt = 0;
        emit OracleFailureCleared(msg.sender);
    }

    /// @notice Price-free exit once the oracle has been unusable for ORACLE_FAILURE_GRACE: pays each
    ///         holder their proportional share of the reserve, so the order of exits does not matter.
    function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        nonReentrant
        returns (uint256 collateralOutWei)
    {
        uint256 reportedAt = oracleFailureReportedAt;
        if (reportedAt == 0) revert OracleFailureNotReported();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < reportedAt + ORACLE_FAILURE_GRACE) {
            revert OracleFailureGracePending(reportedAt + ORACLE_FAILURE_GRACE);
        }
        if (_oracleUsable()) revert OracleHealthy();
        if (amountNusd == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        collateralOutWei = MathX.mulDiv(amountNusd, totalCollateralWei, totalSupply);
        if (collateralOutWei == 0) revert InvalidAmount();
        if (collateralOutWei < minCollateralOutWei) revert SlippageExceeded(minCollateralOutWei, collateralOutWei);
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

    /// @notice NUSD the next release would mint and whether it may run now.
    /// @dev Reverts while the oracle cannot price, like every other price-dependent path.
    function surplusMintCapacity() public view returns (uint256 amountNusd, bool ready) {
        uint256 supply = totalSupply;
        uint256 reserveValue = _valueOf(totalCollateralWei);
        bool triggered = reserveValue * BPS >= supply * surplusTriggerBps && reserveValue != 0;
        uint256 target = MathX.mulDiv(reserveValue, BPS, surplusFloorBps);
        amountNusd = target > supply ? target - supply : 0;
        uint256 ceiling = supplyCeilingNusd;
        uint256 headroom = ceiling > supply ? ceiling - supply : 0;
        if (amountNusd > headroom) amountNusd = headroom;
        // forge-lint: disable-next-line(block-timestamp)
        bool due = block.timestamp >= uint256(lastSurplusReleaseAt) + SURPLUS_INTERVAL;
        ready = triggered && due && amountNusd != 0 && surplusStaking != address(0) && surplusTreasury != address(0);
    }

    /// @notice Mints the reserve's excess over the floor: 80% to the staking pool, 20% to the
    ///         treasury by default. Permissionless, at most once per SURPLUS_INTERVAL, only above
    ///         the trigger, always against a fresh price.
    function releaseSurplus() external nonReentrant returns (uint256 amountNusd) {
        address staking = surplusStaking;
        address treasury = surplusTreasury;
        if (staking == address(0) || treasury == address(0)) revert SurplusRecipientUnset();
        uint256 nextAt = uint256(lastSurplusReleaseAt) + SURPLUS_INTERVAL;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < nextAt) revert SurplusTooSoon(nextAt);

        bool ready;
        (amountNusd, ready) = surplusMintCapacity();
        uint256 reserveValue = _valueOf(totalCollateralWei);
        if (!ready) revert SurplusBelowTrigger(reserveValue, totalSupply);

        lastSurplusReleaseAt = uint40(block.timestamp);
        uint256 toTreasury = MathX.mulDiv(amountNusd, surplusTreasuryBps, BPS);
        uint256 toStaking = amountNusd - toTreasury;
        if (toStaking != 0) _mint(staking, toStaking);
        if (toTreasury != 0) _mint(treasury, toTreasury);
        emit SurplusReleased(msg.sender, toStaking, toTreasury, reserveValue, totalSupply);
    }

    // ---------------------------------------------------------------- pauser and admin

    function setMintPaused(bool paused) external onlyRole(PAUSER_ROLE) {
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

    /// @dev Doubles the ceiling when the supply after this mint uses 80% of it and the last raise
    ///      is a week old.
    function _raiseCeilingIfDue(uint256 supplyAfter) private returns (uint256 ceiling) {
        ceiling = supplyCeilingNusd;
        if (
            supplyAfter * BPS >= ceiling * CEILING_RAISE_USAGE_BPS
            // forge-lint: disable-next-line(block-timestamp)
            && block.timestamp >= uint256(lastCeilingRaiseAt) + CEILING_RAISE_INTERVAL
        ) {
            uint256 raised = MathX.min(ceiling * 2, type(uint96).max);
            if (raised > ceiling) {
                // forge-lint: disable-next-line(unsafe-typecast)
                supplyCeilingNusd = uint96(raised);
                lastCeilingRaiseAt = uint40(block.timestamp);
                emit SupplyCeilingUpdated(raised, true);
                ceiling = raised;
            }
        }
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
