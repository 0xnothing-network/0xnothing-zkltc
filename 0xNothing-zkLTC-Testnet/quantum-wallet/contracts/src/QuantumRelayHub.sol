// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "./common/ReentrancyGuard.sol";
import {IQuantumWalletFactory} from "./interfaces/IQuantumWalletFactory.sol";

/// @title QuantumRelayHub — permissionless, refunded relaying for 0xQuantum wallets.
///
/// @dev WHY THIS EXISTS
/// `QuantumWallet.executeSigned` never reads `msg.sender`: the WOTS signature
/// binds the wallet, the chain, the nonce and every call, so submission is not an
/// authority, only a service. Yet today exactly one process holds one funded key
/// and decides which signed intents reach the chain. It cannot steal — but it can
/// censor, and when it is down the wallet is stuck.
///
/// This hub replaces that single payer with an open one. Anyone may call `relay`;
/// whoever does is reimbursed from a vault the dev tops up. Authority stays where
/// it already was — in the wallet's hash tree — and `executeSigned` remains
/// directly callable by anyone, so nothing here can ever become a new gate on
/// spending. The owner controls the SUBSIDY, never the AUTHORITY.
///
/// @dev THE ATTACK SURFACE IS ECONOMIC, NOT CRYPTOGRAPHIC
/// A vault that refunds arbitrary callers is a target. Every guard below exists
/// because removing it opens a way to drain the vault; see docs/05-DEPIN.md §4.1.
contract QuantumRelayHub is ReentrancyGuard {
    // --- immutable wiring ------------------------------------------------------

    IQuantumWalletFactory public immutable factory;

    // --- ownership (2-step, so a typo cannot orphan the vault) ------------------

    address public owner;
    address public pendingOwner;

    // --- sponsorship set -------------------------------------------------------

    /// Wallets this hub itself deployed, and only those.
    ///
    /// @dev DELIBERATELY NOT `factory.isWallet`. That function staticcalls the
    /// candidate's `factory()` and believes the answer, so ANY contract can claim
    /// membership by returning this factory's address — including one whose
    /// fallback burns every gas unit forwarded to it. Trusting it here would let
    /// an attacker bill the vault for arbitrary gas at no cost to themselves.
    /// A wallet recorded here came back from `factory.deployWallet`, whose CREATE2
    /// check makes the address unforgeable.
    mapping(address => bool) public sponsored;

    // --- per-wallet quota ------------------------------------------------------

    struct Quota {
        uint64 windowStart;
        uint32 used;
    }

    mapping(address => Quota) public quotaOf;

    // --- tunable parameters ----------------------------------------------------

    /// Hard ceiling on gas forwarded to the wallet call. Bounds the damage a
    /// single malicious or buggy op can do to the vault.
    uint256 public maxOpGas = 800_000;

    /// Gas the refund arithmetic cannot observe: the 21000 intrinsic cost, plus
    /// the quota SSTORE and the refund transfer, both of which happen at or after
    /// the final `gasleft()` reading.
    ///
    /// @dev Calibrate with `forge test --gas-report` and a real testnet send, then
    /// set it slightly LOW. Under-refunding costs the relayer a few percent;
    /// over-refunding bleeds the vault on every single call, which is the failure
    /// that compounds. Note this cannot cover an L2's L1 data-availability fee —
    /// `gasleft()` is blind to it — so relayers absorb that portion.
    uint256 public fixedOverhead = 45_000;

    /// Ceiling on the priority fee a relayer may bill above `block.basefee`.
    /// Must be an absolute constant: on an L2 the basefee can sit near zero, so
    /// anything derived from it would collapse to no cap at all.
    uint256 public maxPriority = 2 gwei;

    /// Paid on top of the gas refund, and the only reason to relay for a stranger.
    /// Keep it small: it is also the entire profit margin of a self-dealing
    /// attacker farming their own wallets.
    uint256 public tipWei = 0.00002 ether;

    /// Absolute ceiling per call, independent of the gas arithmetic.
    uint256 public maxRefundWei = 0.01 ether;

    uint32 public opsPerWindow = 20;
    uint64 public windowSeconds = 1 days;

    /// Daily spend ceilings. These are the real backstop: no sybil strategy can
    /// drain more than this per day regardless of how many wallets it creates.
    /// Deploys get their own, smaller budget so that griefing wallet creation
    /// cannot consume the budget real users' sends depend on.
    uint256 public dailyCapWei = 1 ether;
    uint256 public deployCapWei = 0.25 ether;

    uint256 public dayStart;
    uint256 public spentToday;
    uint256 public deploySpentToday;

    /// Pauses REFUNDS only. `executeSigned` is unaffected and stays callable by
    /// anyone directly — pausing can never freeze a user's funds.
    bool public paused;

    // --- events ----------------------------------------------------------------

    event Relayed(address indexed wallet, address indexed relayer, uint256 refund);
    event Sponsored(address indexed wallet, address indexed relayer);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ParamsChanged();
    event PausedSet(bool paused);
    event OwnerChanged(address indexed previous, address indexed next);

    // --- errors ----------------------------------------------------------------

    error NotOwner();
    error IsPaused();
    error NotSponsored(address wallet);
    error QuotaExhausted(address wallet);
    error DailyCapReached();
    error VaultEmpty(uint256 want, uint256 have);
    error OpFailed(bytes reason);
    error RefundFailed();
    error BadParam();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IQuantumWalletFactory factory_, address owner_) {
        if (address(factory_) == address(0) || owner_ == address(0)) revert BadParam();
        factory = factory_;
        owner = owner_;
        dayStart = block.timestamp;
        emit OwnerChanged(address(0), owner_);
    }

    // --- funding ---------------------------------------------------------------

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // --- relaying --------------------------------------------------------------

    /// Deploy a wallet and reimburse the caller's gas, with NO tip.
    ///
    /// @dev Zero tip is load-bearing: a tip here would make manufacturing sybil
    /// wallets directly profitable. At zero, creating throwaway wallets is merely
    /// free, and `deployCapWei` bounds how much of the vault that can consume in a
    /// day. This is a known griefing surface, bounded rather than eliminated.
    function relayDeploy(bytes32 root0) external nonReentrant returns (address wallet) {
        uint256 g0 = gasleft();
        if (paused) revert IsPaused();

        // The factory's CREATE2 check is what makes this address trustworthy;
        // nothing else in this contract takes a wallet address on faith.
        wallet = factory.deployWallet(root0);
        sponsored[wallet] = true;
        emit Sponsored(wallet, msg.sender);

        _refund(g0, 0, true);
    }

    /// Submit a signed operation to `wallet` and reimburse the caller plus a tip.
    ///
    /// `data` is opaque here on purpose — the wallet re-verifies the signature,
    /// the nonce, the epoch and the leaf index itself, and this hub has no
    /// standing to second-guess any of it. The only thing the hub cares about is
    /// that it is paying for a wallet it created and that the call succeeded.
    function relay(address wallet, bytes calldata data) external nonReentrant {
        uint256 g0 = gasleft();
        if (paused) revert IsPaused();
        if (!sponsored[wallet]) revert NotSponsored(wallet);
        _consumeQuota(wallet);

        // Capped gas. Without this, a wallet that burns everything forwarded to it
        // bills the vault for an unbounded amount.
        (bool ok, bytes memory reason) = wallet.call{gas: maxOpGas}(data);
        // Revert on failure so a losing racer or a doomed op cannot be reimbursed.
        // The cost of that choice is that the loser of a relay race forfeits its
        // gas — see docs/05-DEPIN.md §5.2.
        if (!ok) revert OpFailed(reason);

        uint256 refund = _refund(g0, tipWei, false);
        emit Relayed(wallet, msg.sender, refund);
    }

    // --- internals -------------------------------------------------------------

    function _consumeQuota(address wallet) private {
        Quota memory q = quotaOf[wallet];
        if (block.timestamp >= uint256(q.windowStart) + windowSeconds) {
            q.windowStart = uint64(block.timestamp);
            q.used = 0;
        }
        if (q.used >= opsPerWindow) revert QuotaExhausted(wallet);
        unchecked {
            q.used += 1;
        }
        quotaOf[wallet] = q;
    }

    /// @param g0       `gasleft()` sampled at function entry.
    /// @param tip      extra paid on top of gas, 0 for deploys.
    /// @param isDeploy bills the separate deploy budget instead of the main one.
    function _refund(uint256 g0, uint256 tip, bool isDeploy) private returns (uint256 amount) {
        // Cap the billable gas price. A relayer picks its own `tx.gasprice`, so
        // without this it could name any number and invoice the vault for it.
        uint256 price = tx.gasprice;
        uint256 cap = block.basefee + maxPriority;
        if (price > cap) price = cap;

        // `msg.data.length` is the exact calldata this transaction paid for.
        // Charging every byte at the non-zero rate over-counts by well under 1%
        // for a WOTS signature (its bytes are effectively uniform), and keeps the
        // arithmetic independent of which entry point is being refunded.
        uint256 calldataGas = 16 * msg.data.length;

        // Checked arithmetic on purpose. `maxRefundWei` below would clamp an
        // overflowed product back into range, turning a wrapped multiplication
        // into a silently plausible payout instead of a revert.
        amount = (g0 - gasleft() + fixedOverhead + calldataGas) * price + tip;
        if (amount > maxRefundWei) amount = maxRefundWei;

        _bill(amount, isDeploy);

        uint256 balance = address(this).balance;
        if (balance < amount) revert VaultEmpty(amount, balance);

        (bool paid,) = msg.sender.call{value: amount}("");
        if (!paid) revert RefundFailed();
    }

    function _bill(uint256 amount, bool isDeploy) private {
        if (block.timestamp >= dayStart + 1 days) {
            dayStart = block.timestamp;
            spentToday = 0;
            deploySpentToday = 0;
        }
        uint256 next = spentToday + amount;
        if (next > dailyCapWei) revert DailyCapReached();
        spentToday = next;

        if (isDeploy) {
            uint256 nextDeploy = deploySpentToday + amount;
            if (nextDeploy > deployCapWei) revert DailyCapReached();
            deploySpentToday = nextDeploy;
        }
    }

    // --- administration --------------------------------------------------------

    function setParams(
        uint256 maxOpGas_,
        uint256 fixedOverhead_,
        uint256 maxPriority_,
        uint256 tipWei_,
        uint256 maxRefundWei_,
        uint32 opsPerWindow_,
        uint64 windowSeconds_
    ) external onlyOwner {
        if (maxOpGas_ == 0 || windowSeconds_ == 0 || opsPerWindow_ == 0) revert BadParam();
        maxOpGas = maxOpGas_;
        fixedOverhead = fixedOverhead_;
        maxPriority = maxPriority_;
        tipWei = tipWei_;
        maxRefundWei = maxRefundWei_;
        opsPerWindow = opsPerWindow_;
        windowSeconds = windowSeconds_;
        emit ParamsChanged();
    }

    function setCaps(uint256 dailyCapWei_, uint256 deployCapWei_) external onlyOwner {
        if (deployCapWei_ > dailyCapWei_) revert BadParam();
        dailyCapWei = dailyCapWei_;
        deployCapWei = deployCapWei_;
        emit ParamsChanged();
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert BadParam();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnerChanged(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // --- views -----------------------------------------------------------------

    /// Everything a relayer node needs to decide whether a relay will pay off,
    /// in one call.
    function quote(address wallet)
        external
        view
        returns (bool relayable, uint32 opsLeft, uint256 budgetLeft, uint256 balance)
    {
        Quota memory q = quotaOf[wallet];
        uint32 used = block.timestamp >= uint256(q.windowStart) + windowSeconds ? 0 : q.used;
        opsLeft = used >= opsPerWindow ? 0 : opsPerWindow - used;

        uint256 spent = block.timestamp >= dayStart + 1 days ? 0 : spentToday;
        budgetLeft = spent >= dailyCapWei ? 0 : dailyCapWei - spent;

        balance = address(this).balance;
        relayable = !paused && sponsored[wallet] && opsLeft > 0 && budgetLeft > 0;
    }
}
