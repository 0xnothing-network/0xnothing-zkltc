// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title NusdPointsStaking
/// @notice Escrows NUSD for fixed periods and awards non-transferable point credits up front.
/// @dev Point credits use 18 decimals. One NUSD at the base multiplier earns 1e18 credits,
///      while 100e18 credits are displayed as 1.00 0xPoint by clients.
contract NusdPointsStaking is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ConfigUnchanged();
    error FeeOnTransferUnsupported();
    error Insolvent();
    error InsufficientExcess();
    error InsufficientPointCredits();
    error InsufficientRedemptionReserve();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidLockDuration();
    error InvalidNusd();
    error InvalidRate();
    error InvalidRateVersion();
    error InvalidSignature();
    error InvalidSigner();
    error InvalidVoucherNonce();
    error PageTooLarge();
    error PositionAlreadyWithdrawn();
    error PositionNotFound();
    error PositionStillLocked();
    error RedemptionDisabled();
    error RedemptionPaused();
    error RedemptionTooSmall();
    error StakingPaused();
    error TimestampOverflow();
    error UnauthorizedGuardian();
    error UnauthorizedPositionOwner();
    error VoucherExpired();

    uint256 public constant BPS = 10_000;
    uint256 public constant POINT_CREDITS_PER_XPOINT = 100e18;
    uint256 public constant MAX_PAGE_SIZE = 100;

    uint32 public constant LOCK_30_DAYS = 30 days;
    uint32 public constant LOCK_90_DAYS = 90 days;
    uint32 public constant LOCK_180_DAYS = 180 days;
    uint32 public constant LOCK_365_DAYS = 365 days;

    bytes32 public constant REDEEM_VOUCHER_TYPEHASH = keccak256(
        "RedeemVoucher(address account,address recipient,uint256 pointCredits,uint256 nonce,uint256 deadline,uint256 rateVersion)"
    );
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant EIP712_NAME_HASH = keccak256("0xNothing NUSD Points");
    bytes32 public constant EIP712_VERSION_HASH = keccak256("1");

    struct Position {
        address account;
        uint256 amount;
        uint256 pointCredits;
        uint64 unlockTime;
        uint32 lockDuration;
        bool withdrawn;
    }

    struct RedeemVoucher {
        address account;
        address recipient;
        uint256 pointCredits;
        uint256 nonce;
        uint256 deadline;
        uint256 rateVersion;
    }

    IERC20Metadata public immutable nusd;

    address public guardian;
    address public redemptionSigner;
    bool public stakingPaused;
    bool public redemptionsPaused;
    bool public redemptionEnabled;

    /// @notice NUSD wei paid for one whole 0xPoint, expressed as a wad.
    uint256 public nusdPerXPointWad;
    uint256 public rateVersion = 1;
    uint256 public redemptionReserve;

    uint256 public nextPositionId;
    uint256 public totalLocked;
    uint256 public totalEarnedPointCredits;
    uint256 public totalSpentPointCredits;

    mapping(address => uint256) public totalLockedByUser;
    mapping(address => uint256) public earnedPointCredits;
    mapping(address => uint256) public spentPointCredits;
    mapping(address => uint256) public redemptionNonces;

    mapping(uint256 => Position) private _positions;
    mapping(address => uint256[]) private _userPositionIds;

    event Staked(
        uint256 indexed positionId,
        address indexed account,
        uint256 amount,
        uint256 pointCredits,
        uint32 lockDuration,
        uint64 unlockTime
    );
    event Withdrawn(uint256 indexed positionId, address indexed account, uint256 amount);
    event RedemptionExecuted(
        address indexed account,
        address indexed recipient,
        uint256 pointCredits,
        uint256 nusdOut,
        uint256 nonce,
        uint256 rateVersion
    );
    event PointsRedeemed(
        address indexed account,
        address indexed recipient,
        uint256 pointCredits,
        uint256 nusdOut,
        uint256 indexed rateVersion
    );
    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event RedemptionSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event StakingPauseUpdated(bool paused, address indexed caller);
    event RedemptionPauseUpdated(bool paused, address indexed caller);
    event RedemptionConfigUpdated(uint256 nusdPerXPointWad, bool enabled, uint256 indexed rateVersion);
    event RedemptionReserveFunded(address indexed funder, uint256 amount, uint256 reserveAfter);
    event RedemptionReserveWithdrawn(address indexed recipient, uint256 amount, uint256 reserveAfter);
    event ExcessWithdrawn(address indexed recipient, uint256 amount);

    constructor(address nusd_, address initialOwner, address initialGuardian, address initialRedemptionSigner)
        Ownable(initialOwner)
    {
        if (nusd_.code.length == 0) revert InvalidNusd();
        if (initialGuardian == address(0)) revert InvalidAddress();
        if (initialRedemptionSigner == address(0) || initialRedemptionSigner.code.length != 0) {
            revert InvalidSigner();
        }

        IERC20Metadata candidate = IERC20Metadata(nusd_);
        try candidate.decimals() returns (uint8 decimals_) {
            if (decimals_ != 18) revert InvalidNusd();
        } catch {
            revert InvalidNusd();
        }

        nusd = candidate;
        guardian = initialGuardian;
        redemptionSigner = initialRedemptionSigner;

        emit GuardianUpdated(address(0), initialGuardian);
        emit RedemptionSignerUpdated(address(0), initialRedemptionSigner);
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert UnauthorizedGuardian();
        _;
    }

    /// @notice Locks NUSD and immediately credits the position's fixed-duration points.
    function stake(uint256 amount, uint32 lockDuration) external nonReentrant returns (uint256 positionId) {
        if (stakingPaused) revert StakingPaused();
        if (amount == 0) revert InvalidAmount();

        uint256 multiplierBps = lockMultiplierBps(lockDuration);
        uint256 pointCredits = Math.mulDiv(amount, multiplierBps, BPS);
        uint256 unlockTimestamp = block.timestamp + lockDuration;
        if (unlockTimestamp > type(uint64).max) revert TimestampOverflow();
        // The explicit bound above makes this narrowing conversion safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 unlockTime = uint64(unlockTimestamp);

        positionId = nextPositionId++;
        _positions[positionId] = Position({
            account: msg.sender,
            amount: amount,
            pointCredits: pointCredits,
            unlockTime: unlockTime,
            lockDuration: lockDuration,
            withdrawn: false
        });
        _userPositionIds[msg.sender].push(positionId);

        totalLocked += amount;
        totalLockedByUser[msg.sender] += amount;
        totalEarnedPointCredits += pointCredits;
        earnedPointCredits[msg.sender] += pointCredits;

        _pullExact(msg.sender, amount);
        _assertSolvent();

        emit Staked(positionId, msg.sender, amount, pointCredits, lockDuration, unlockTime);
    }

    /// @notice Returns a matured position only to its original owner, even while protocol actions are paused.
    function withdraw(uint256 positionId) external nonReentrant {
        Position storage position = _positionAt(positionId);
        if (position.account != msg.sender) revert UnauthorizedPositionOwner();
        if (position.withdrawn) revert PositionAlreadyWithdrawn();
        // Fixed locks are explicitly timestamp based.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < position.unlockTime) revert PositionStillLocked();

        uint256 amount = position.amount;
        position.withdrawn = true;
        totalLocked -= amount;
        totalLockedByUser[msg.sender] -= amount;

        _pushExact(msg.sender, amount);
        _assertSolvent();

        emit Withdrawn(positionId, msg.sender, amount);
    }

    /// @notice Funds the isolated NUSD reserve used only for point redemptions.
    function fundRedemptionReserve(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        redemptionReserve += amount;
        _pullExact(msg.sender, amount);
        _assertSolvent();
        emit RedemptionReserveFunded(msg.sender, amount, redemptionReserve);
    }

    /// @notice Directly redeems the caller's available point credits for NUSD.
    /// @dev The caller is always both the point owner and NUSD recipient.
    function redeemPoints(uint256 pointCredits) external nonReentrant returns (uint256 nusdOut) {
        return _redeemPoints(msg.sender, msg.sender, pointCredits);
    }

    /// @notice Redeems earned credits using an account-bound, nonce-protected EIP-712 voucher.
    /// @dev Anyone may relay a valid voucher; its signed recipient cannot be changed by the relayer.
    function redeem(RedeemVoucher calldata voucher, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 nusdOut)
    {
        // Voucher expiries are explicitly timestamp based.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > voucher.deadline) revert VoucherExpired();
        if (voucher.nonce != redemptionNonces[voucher.account]) revert InvalidVoucherNonce();
        if (voucher.rateVersion != rateVersion) revert InvalidRateVersion();

        (address recovered, ECDSA.RecoverError recoveryError,) =
            ECDSA.tryRecoverCalldata(voucherDigest(voucher), signature);
        if (recoveryError != ECDSA.RecoverError.NoError || recovered != redemptionSigner) revert InvalidSignature();

        redemptionNonces[voucher.account] = voucher.nonce + 1;
        nusdOut = _redeemPoints(voucher.account, voucher.recipient, voucher.pointCredits);

        emit RedemptionExecuted(
            voucher.account, voucher.recipient, voucher.pointCredits, nusdOut, voucher.nonce, voucher.rateVersion
        );
    }

    function configureRedemption(uint256 newNusdPerXPointWad, bool enabled) external onlyOwner {
        if (enabled && newNusdPerXPointWad == 0) revert InvalidRate();
        if (newNusdPerXPointWad == nusdPerXPointWad && enabled == redemptionEnabled) revert ConfigUnchanged();

        nusdPerXPointWad = newNusdPerXPointWad;
        redemptionEnabled = enabled;
        rateVersion += 1;
        emit RedemptionConfigUpdated(newNusdPerXPointWad, enabled, rateVersion);
    }

    function setRedemptionSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0) || newSigner.code.length != 0) revert InvalidSigner();
        address previousSigner = redemptionSigner;
        redemptionSigner = newSigner;
        emit RedemptionSignerUpdated(previousSigner, newSigner);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidAddress();
        address previousGuardian = guardian;
        guardian = newGuardian;
        emit GuardianUpdated(previousGuardian, newGuardian);
    }

    function pauseStaking() external onlyOwnerOrGuardian {
        if (stakingPaused) revert ConfigUnchanged();
        stakingPaused = true;
        emit StakingPauseUpdated(true, msg.sender);
    }

    function unpauseStaking() external onlyOwner {
        if (!stakingPaused) revert ConfigUnchanged();
        stakingPaused = false;
        emit StakingPauseUpdated(false, msg.sender);
    }

    function pauseRedemptions() external onlyOwnerOrGuardian {
        if (redemptionsPaused) revert ConfigUnchanged();
        redemptionsPaused = true;
        emit RedemptionPauseUpdated(true, msg.sender);
    }

    function unpauseRedemptions() external onlyOwner {
        if (!redemptionsPaused) revert ConfigUnchanged();
        redemptionsPaused = false;
        emit RedemptionPauseUpdated(false, msg.sender);
    }

    /// @notice Withdraws uncommitted redemption liquidity without touching escrowed principal.
    function withdrawRedemptionReserve(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (amount > redemptionReserve) revert InsufficientRedemptionReserve();

        redemptionReserve -= amount;
        _pushExact(recipient, amount);
        _assertSolvent();
        emit RedemptionReserveWithdrawn(recipient, amount, redemptionReserve);
    }

    /// @notice Recovers only direct, unaccounted token transfers above locked principal and the reserve.
    function withdrawExcess(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (amount > excessNusd()) revert InsufficientExcess();

        _pushExact(recipient, amount);
        _assertSolvent();
        emit ExcessWithdrawn(recipient, amount);
    }

    function lockMultiplierBps(uint32 lockDuration) public pure returns (uint256 multiplierBps) {
        if (lockDuration == LOCK_30_DAYS) return 10_000;
        if (lockDuration == LOCK_90_DAYS) return 12_000;
        if (lockDuration == LOCK_180_DAYS) return 15_000;
        if (lockDuration == LOCK_365_DAYS) return 30_000;
        revert InvalidLockDuration();
    }

    function quotePointCredits(uint256 amount, uint32 lockDuration) public pure returns (uint256) {
        return Math.mulDiv(amount, lockMultiplierBps(lockDuration), BPS);
    }

    function quoteRedemption(uint256 pointCredits) public view returns (uint256) {
        return Math.mulDiv(pointCredits, nusdPerXPointWad, POINT_CREDITS_PER_XPOINT);
    }

    function availablePointCredits(address account) public view returns (uint256) {
        return earnedPointCredits[account] - spentPointCredits[account];
    }

    function xPointsWad(address account) external view returns (uint256) {
        return availablePointCredits(account) / 100;
    }

    function userPositionCount(address account) external view returns (uint256) {
        return _userPositionIds[account].length;
    }

    function userPositionIdAt(address account, uint256 index) external view returns (uint256) {
        return _userPositionIds[account][index];
    }

    function userPositionIds(address account, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids)
    {
        if (limit > MAX_PAGE_SIZE) revert PageTooLarge();
        uint256 count = _userPositionIds[account].length;
        if (offset >= count || limit == 0) return new uint256[](0);

        uint256 remaining = count - offset;
        uint256 size = limit < remaining ? limit : remaining;
        ids = new uint256[](size);
        for (uint256 i; i < size; ++i) {
            ids[i] = _userPositionIds[account][offset + i];
        }
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return _positionAt(positionId);
    }

    function accountSummary(address account)
        external
        view
        returns (uint256 locked, uint256 earned, uint256 spent, uint256 available, uint256 positionCount)
    {
        return (
            totalLockedByUser[account],
            earnedPointCredits[account],
            spentPointCredits[account],
            availablePointCredits(account),
            _userPositionIds[account].length
        );
    }

    function voucherDigest(RedeemVoucher calldata voucher) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                REDEEM_VOUCHER_TYPEHASH,
                voucher.account,
                voucher.recipient,
                voucher.pointCredits,
                voucher.nonce,
                voucher.deadline,
                voucher.rateVersion
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparatorV4(), structHash));
    }

    /// @notice EIP-712 domain used by the server-side redemption signer.
    function domainSeparatorV4() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this))
        );
    }

    function excessNusd() public view returns (uint256) {
        uint256 obligations = totalLocked + redemptionReserve;
        uint256 balance = nusd.balanceOf(address(this));
        return balance > obligations ? balance - obligations : 0;
    }

    function isSolvent() external view returns (bool) {
        return nusd.balanceOf(address(this)) >= totalLocked + redemptionReserve;
    }

    function _positionAt(uint256 positionId) private view returns (Position storage position) {
        if (positionId >= nextPositionId) revert PositionNotFound();
        return _positions[positionId];
    }

    function _redeemPoints(address account, address recipient, uint256 pointCredits) private returns (uint256 nusdOut) {
        if (redemptionsPaused) revert RedemptionPaused();
        if (!redemptionEnabled) revert RedemptionDisabled();
        if (account == address(0) || recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        if (pointCredits == 0) revert InvalidAmount();
        if (pointCredits > availablePointCredits(account)) revert InsufficientPointCredits();

        nusdOut = quoteRedemption(pointCredits);
        if (nusdOut == 0) revert RedemptionTooSmall();
        if (nusdOut > redemptionReserve) revert InsufficientRedemptionReserve();

        spentPointCredits[account] += pointCredits;
        totalSpentPointCredits += pointCredits;
        redemptionReserve -= nusdOut;

        _pushExact(recipient, nusdOut);
        _assertSolvent();
        emit PointsRedeemed(account, recipient, pointCredits, nusdOut, rateVersion);
    }

    function _pullExact(address from, uint256 amount) private {
        IERC20 token = IERC20(address(nusd));
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) != balanceBefore + amount) revert FeeOnTransferUnsupported();
    }

    function _pushExact(address recipient, uint256 amount) private {
        IERC20 token = IERC20(address(nusd));
        uint256 recipientBalanceBefore = token.balanceOf(recipient);
        uint256 contractBalanceBefore = token.balanceOf(address(this));
        token.safeTransfer(recipient, amount);
        if (
            token.balanceOf(recipient) != recipientBalanceBefore + amount
                || token.balanceOf(address(this)) != contractBalanceBefore - amount
        ) {
            revert FeeOnTransferUnsupported();
        }
    }

    function _assertSolvent() private view {
        if (nusd.balanceOf(address(this)) < totalLocked + redemptionReserve) revert Insolvent();
    }
}
