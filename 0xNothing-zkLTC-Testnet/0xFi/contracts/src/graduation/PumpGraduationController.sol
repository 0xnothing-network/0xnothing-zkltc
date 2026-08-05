// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IGraduationAdapter } from "../interfaces/IGraduationAdapter.sol";

interface IControlledZeroXPump {
    struct GraduationResult {
        address dex;
        bytes32 pairId;
        address pool;
        address lpToken;
        uint256 lpAmount;
    }

    function NUSD() external view returns (address);
    function graduationRouter() external view returns (address);
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function status(address token) external view returns (uint8);
    function spotPriceNusdWad(address token) external view returns (uint256);
    function markets(address token)
        external
        view
        returns (
            address creator,
            uint256 tokenReserve,
            uint256 realNusdReserve,
            uint256 virtualTokenReserve,
            uint256 virtualNusdReserve,
            uint256 totalNusdVolume,
            uint64 createdAt,
            uint8 lifecycle,
            address dex,
            bytes32 dexPairId,
            address pool
        );
    function graduate(address token, address adapter, uint256 minimumLp, uint256 deadline)
        external
        returns (GraduationResult memory result);
    function setPaused(bool paused) external;
    function withdrawProtocolFees(address recipient, uint256 amountNusd) external;
    function transferAdmin(address newAdmin) external;
    function acceptAdmin() external;
}

interface IZeroXFiGraduationAdapterTopology {
    function factory() external view returns (address);
    function pumpRouter() external view returns (address);
    function nusd() external view returns (address);
    function pump() external view returns (address);
}

interface IZeroXFiGraduationFactoryTopology {
    function graduationAdapter() external view returns (address);
    function nusd() external view returns (address);
    function pump() external view returns (address);
}

interface IControlledGraduationRouter {
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function enabled() external view returns (bool);
    function isAdapterAllowed(address adapter) external view returns (bool);
    function scheduleAdapter(address adapter) external;
    function disableAdapter(address adapter) external;
    function scheduleEnable() external;
    function disableRouter() external;
    function transferAdmin(address newAdmin) external;
    function acceptAdmin() external;
}

/// @notice Permissionless automation boundary for READY 0xPump markets.
/// @dev The controller is intended to become the Pump admin. Governance retains the
///      remaining Pump admin powers through a timelock, while the guardian can only pause.
contract PumpGraduationController is ReentrancyGuard {
    error InvalidConfiguration();
    error InvalidGraduationPreview();
    error InvalidGraduationResult();
    error GraduationsPaused();
    error MarketNotReady();
    error PendingAdminMismatch();
    error RouterUnavailable();
    error Unauthorized();

    uint8 public constant READY = 2;
    uint256 public constant WAD = 1e18;
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    IControlledZeroXPump public immutable pump;
    IGraduationAdapter public immutable adapter;
    IControlledGraduationRouter public immutable router;
    address public immutable governance;
    address public immutable nusd;

    address public guardian;
    bool public graduationsPaused;

    struct GraduationPreview {
        bool ready;
        address pool;
        uint256 tokenAmount;
        uint256 nusdAmount;
        uint256 expectedLp;
        uint256 minimumLp;
    }

    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event GraduationsPauseUpdated(bool paused);
    event PumpAdminAccepted(address indexed caller);
    event PumpAdminTransferStarted(address indexed newAdmin);
    event PumpPauseRouted(address indexed caller, bool paused);
    event RouterAdminAccepted(address indexed caller);
    event RouterAdminTransferStarted(address indexed newAdmin);
    event RouterAdapterDisabled(address indexed adapter);
    event RouterAdapterScheduled(address indexed adapter);
    event RouterDisableRouted(address indexed caller);
    event RouterEnableScheduled();
    event ProtocolFeesWithdrawalRouted(address indexed recipient, uint256 amountNusd);
    event ReadyMarketGraduated(
        address indexed caller,
        address indexed token,
        address indexed pool,
        uint256 tokenAmount,
        uint256 nusdAmount,
        uint256 lpAmount
    );

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    constructor(address pump_, address adapter_, address governance_, address guardian_) {
        if (pump_.code.length == 0 || adapter_.code.length == 0 || governance_ == address(0) || guardian_ == address(0))
        {
            revert InvalidConfiguration();
        }

        IControlledZeroXPump configuredPump = IControlledZeroXPump(pump_);
        IZeroXFiGraduationAdapterTopology configuredAdapter = IZeroXFiGraduationAdapterTopology(adapter_);
        address configuredNusd = configuredPump.NUSD();
        address configuredRouter = configuredPump.graduationRouter();
        address factory = configuredAdapter.factory();
        if (configuredNusd.code.length == 0 || configuredRouter.code.length == 0 || factory.code.length == 0) {
            revert InvalidConfiguration();
        }
        if (
            configuredAdapter.pump() != pump_ || configuredAdapter.nusd() != configuredNusd
                || configuredAdapter.pumpRouter() != configuredPump.graduationRouter()
        ) revert InvalidConfiguration();

        IZeroXFiGraduationFactoryTopology configuredFactory = IZeroXFiGraduationFactoryTopology(factory);
        if (
            configuredFactory.graduationAdapter() != adapter_ || configuredFactory.pump() != pump_
                || configuredFactory.nusd() != configuredNusd
        ) revert InvalidConfiguration();

        pump = configuredPump;
        adapter = IGraduationAdapter(adapter_);
        router = IControlledGraduationRouter(configuredRouter);
        governance = governance_;
        guardian = guardian_;
        nusd = configuredNusd;
    }

    /// @notice Returns the exact initial LP amount expected from the empty protected pair.
    /// @dev The minimum equals the expected amount, so any reserve or implementation drift reverts atomically.
    function previewGraduation(address token) public view returns (GraduationPreview memory preview) {
        preview.ready = pump.status(token) == READY;
        preview.pool = adapter.lpTokenFor(token, nusd);
        if (!preview.ready) return preview;

        (, uint256 tokenReserve, uint256 realNusdReserve,,,,,,,,) = pump.markets(token);
        uint256 priceWad = pump.spotPriceNusdWad(token);
        if (realNusdReserve == 0 || priceWad == 0) revert InvalidGraduationPreview();

        uint256 tokenAmount = Math.mulDiv(realNusdReserve, WAD, priceWad);
        if (tokenAmount == 0 || tokenAmount > tokenReserve) revert InvalidGraduationPreview();

        uint256 rootK = Math.sqrt(tokenAmount * realNusdReserve);
        if (rootK <= MINIMUM_LIQUIDITY) revert InvalidGraduationPreview();

        preview.tokenAmount = tokenAmount;
        preview.nusdAmount = realNusdReserve;
        preview.expectedLp = rootK - MINIMUM_LIQUIDITY;
        preview.minimumLp = preview.expectedLp;
    }

    /// @notice Prepares the protected pool and graduates a READY market atomically.
    /// @dev Anyone may execute this function; it cannot select an adapter, recipient, price, or liquidity amount.
    function graduateReady(address token)
        external
        nonReentrant
        returns (IControlledZeroXPump.GraduationResult memory result)
    {
        if (graduationsPaused) revert GraduationsPaused();
        if (!router.enabled() || !router.isAdapterAllowed(address(adapter))) revert RouterUnavailable();
        GraduationPreview memory preview = previewGraduation(token);
        if (!preview.ready) revert MarketNotReady();

        address pool = adapter.preparePool(token);
        if (pool == address(0) || pool.code.length == 0 || adapter.lpTokenFor(token, nusd) != pool) {
            revert InvalidGraduationResult();
        }

        result = pump.graduate(token, address(adapter), preview.minimumLp, block.timestamp);
        if (result.pool != pool || result.lpToken != pool || result.lpAmount != preview.expectedLp) {
            revert InvalidGraduationResult();
        }

        emit ReadyMarketGraduated(msg.sender, token, pool, preview.tokenAmount, preview.nusdAmount, result.lpAmount);
    }

    /// @notice Completes the Pump's two-step admin transfer once this controller is pending.
    function acceptPumpAdmin() external nonReentrant {
        if (pump.pendingAdmin() != address(this)) revert PendingAdminMismatch();
        pump.acceptAdmin();
        if (pump.admin() != address(this)) revert PendingAdminMismatch();
        emit PumpAdminAccepted(msg.sender);
    }

    /// @notice Completes the router's two-step admin transfer once this controller is pending.
    function acceptRouterAdmin() external nonReentrant {
        if (router.pendingAdmin() != address(this)) revert PendingAdminMismatch();
        router.acceptAdmin();
        if (router.admin() != address(this)) revert PendingAdminMismatch();
        emit RouterAdminAccepted(msg.sender);
    }

    /// @notice Completes both two-step handovers in a single transaction.
    function acceptProtocolAdmin() external nonReentrant {
        if (pump.pendingAdmin() != address(this) || router.pendingAdmin() != address(this)) {
            revert PendingAdminMismatch();
        }
        pump.acceptAdmin();
        router.acceptAdmin();
        if (pump.admin() != address(this) || router.admin() != address(this)) revert PendingAdminMismatch();
        emit PumpAdminAccepted(msg.sender);
        emit RouterAdminAccepted(msg.sender);
    }

    /// @notice The guardian and governance may stop Pump activity immediately; neither path can unpause here.
    function emergencyPause() external nonReentrant {
        if (msg.sender != guardian && msg.sender != governance) revert Unauthorized();
        graduationsPaused = true;
        emit GraduationsPauseUpdated(true);
        if (pump.admin() == address(this)) {
            pump.setPaused(true);
            emit PumpPauseRouted(msg.sender, true);
        }
        if (router.admin() == address(this)) {
            router.disableRouter();
            emit RouterDisableRouted(msg.sender);
        }
    }

    function setPumpPaused(bool paused) external onlyGovernance nonReentrant {
        graduationsPaused = paused;
        pump.setPaused(paused);
        emit GraduationsPauseUpdated(paused);
        emit PumpPauseRouted(msg.sender, paused);
    }

    function setGraduationsPaused(bool paused) external onlyGovernance {
        graduationsPaused = paused;
        emit GraduationsPauseUpdated(paused);
    }

    function scheduleAdapter() external onlyGovernance {
        router.scheduleAdapter(address(adapter));
        emit RouterAdapterScheduled(address(adapter));
    }

    function disableAdapter() external onlyGovernance {
        router.disableAdapter(address(adapter));
        emit RouterAdapterDisabled(address(adapter));
    }

    function scheduleRouterEnable() external onlyGovernance {
        router.scheduleEnable();
        emit RouterEnableScheduled();
    }

    function disableRouter() external onlyGovernance nonReentrant {
        router.disableRouter();
        emit RouterDisableRouted(msg.sender);
    }

    function withdrawProtocolFees(address recipient, uint256 amountNusd) external onlyGovernance nonReentrant {
        pump.withdrawProtocolFees(recipient, amountNusd);
        emit ProtocolFeesWithdrawalRouted(recipient, amountNusd);
    }

    function transferPumpAdmin(address newAdmin) external onlyGovernance nonReentrant {
        pump.transferAdmin(newAdmin);
        emit PumpAdminTransferStarted(newAdmin);
    }

    function transferRouterAdmin(address newAdmin) external onlyGovernance nonReentrant {
        router.transferAdmin(newAdmin);
        emit RouterAdminTransferStarted(newAdmin);
    }

    function setGuardian(address newGuardian) external onlyGovernance {
        if (newGuardian == address(0)) revert InvalidConfiguration();
        address previousGuardian = guardian;
        guardian = newGuardian;
        emit GuardianUpdated(previousGuardian, newGuardian);
    }
}
