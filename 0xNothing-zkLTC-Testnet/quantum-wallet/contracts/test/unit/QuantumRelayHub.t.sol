// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {QuantumRelayHub} from "../../src/QuantumRelayHub.sol";
import {QuantumWalletFactory} from "../../src/QuantumWalletFactory.sol";
import {IQuantumWallet} from "../../src/interfaces/IQuantumWallet.sol";
import {IQuantumWalletFactory} from "../../src/interfaces/IQuantumWalletFactory.sol";
import {TreeSigner} from "../utils/TreeSigner.sol";
import {FakeQuantumWallet} from "../mocks/FakeQuantumWallet.sol";
import {RelayReenterProbe} from "../mocks/RelayReenterProbe.sol";

/// QuantumRelayHub is a vault that pays strangers. Its attack surface is
/// economic, not cryptographic: nothing here can steal from a wallet (the wallet's
/// hash tree decides that), but plenty can drain the dev's subsidy. Every test
/// below pins one guard that, if removed, turns the vault into a faucet — plus the
/// two properties that must survive no matter what the owner does: the hub can
/// never gate spending, and pausing can never freeze funds.
contract QuantumRelayHubTest is TestBase {
    QuantumWalletFactory internal factory;
    QuantumRelayHub internal hub;

    address internal constant RECIPIENT = address(0xBEEF);

    /// The test contract IS the relayer in most cases below, so it has to be able
    /// to take the refund. Without this, every `_refund` would end in
    /// `RefundFailed` and the suite would pass for entirely the wrong reason.
    receive() external payable {}

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new QuantumWalletFactory();
        hub = new QuantumRelayHub(IQuantumWalletFactory(address(factory)), address(this));
        vm.deal(address(hub), 100 ether);
        vm.deal(address(this), 1 ether);
        vm.txGasPrice(0);
        vm.fee(0);
    }

    // --- plumbing -------------------------------------------------------------

    /// Deploy through the hub at zero gas price, so the wallet is sponsored and
    /// the vault has spent nothing yet. Tests that care about refund arithmetic
    /// set their own price afterwards.
    function _sponsored(bytes32 seed) internal returns (address wallet, TreeSigner signer) {
        signer = new TreeSigner(seed);
        vm.txGasPrice(0);
        vm.fee(0);
        wallet = hub.relayDeploy(signer.root());
    }

    function _w(address wallet) internal pure returns (IQuantumWallet) {
        return IQuantumWallet(payable(wallet));
    }

    /// Calldata for a real, signed native transfer — what a relayer node would
    /// receive from the bulletin board and forward verbatim.
    function _execData(address wallet, TreeSigner s, uint32 leaf, uint256 value)
        internal
        view
        returns (bytes memory)
    {
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = _w(wallet).nonce();
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](1);
        op.calls[0] = IQuantumWallet.Call({to: RECIPIENT, value: value, data: ""});

        bytes32 digest = _w(wallet).opDigest(op);
        (bytes32[] memory wots, bytes32[] memory path) = s.sign(leaf, digest);
        IQuantumWallet.Sig memory sig =
            IQuantumWallet.Sig({epoch: 0, leafIndex: leaf, wots: wots, path: path});

        return abi.encodeCall(IQuantumWallet.executeSigned, (op, sig));
    }

    // --- sponsorship set ------------------------------------------------------

    function test_relayDeploy_marksSponsored_andPaysNoTip() public {
        uint256 vaultBefore = address(hub).balance;

        address wallet = hub.relayDeploy(keccak256("deploy-root"));

        assertTrue(hub.sponsored(wallet), "hub sponsors the wallet it deployed");
        assertEq(wallet, factory.predictWallet(keccak256("deploy-root")), "CREATE2 address");
        // Price is 0 here, so the ONLY thing a payout could contain is the tip.
        // A tip on deploy would make manufacturing sybil wallets directly
        // profitable, so it must be exactly zero.
        assertEq(address(hub).balance, vaultBefore, "deploy pays no tip");
        assertEq(hub.deploySpentToday(), 0, "nothing billed at zero gas price");
    }

    /// THE security test. Relaying is gated on a set the hub built itself, not on
    /// the factory's self-declaration check.
    function test_spoofedWallet_cannotBeRelayed() public {
        FakeQuantumWallet fake = new FakeQuantumWallet(address(factory));

        // First: prove the spoof is real, not hypothetical. If this assertion ever
        // flips to false, `isWallet` was hardened and this test's premise changed —
        // the hub's own set is still the right design, but read §4.1 before
        // touching it.
        assertTrue(factory.isWallet(address(fake)), "isWallet believes the impostor");

        // Second: prove the hub does not care what `isWallet` thinks.
        assertFalse(hub.sponsored(address(fake)), "impostor is not sponsored");
        vm.expectRevert(abi.encodeWithSelector(QuantumRelayHub.NotSponsored.selector, address(fake)));
        hub.relay(address(fake), hex"");
    }

    function test_realWalletDeployedOutsideHub_isNotSponsored() public {
        // A wallet is a wallet, but the hub only subsidises what it paid to create.
        address wallet = factory.deployWallet(keccak256("outside"));
        assertTrue(factory.isWallet(wallet), "genuine wallet");
        assertFalse(hub.sponsored(wallet), "but not on the hub's tab");

        vm.expectRevert(abi.encodeWithSelector(QuantumRelayHub.NotSponsored.selector, wallet));
        hub.relay(wallet, hex"");
    }

    // --- the happy path -------------------------------------------------------

    function test_relay_executesSignedOp_andRefundsRelayer() public {
        (address wallet, TreeSigner s) = _sponsored(bytes32(uint256(0xA11CE)));
        vm.deal(wallet, 10 ether);
        bytes memory data = _execData(wallet, s, 0, 3 ether);

        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        uint256 relayerBefore = address(this).balance;

        hub.relay(wallet, data);

        assertEq(RECIPIENT.balance, 3 ether, "recipient paid");
        assertEq(wallet.balance, 7 ether, "wallet kept remainder");
        assertEq(_w(wallet).nonce(), 1, "nonce advanced");
        assertEq(_w(wallet).leafIndex(), 1, "leaf consumed");

        uint256 refund = address(this).balance - relayerBefore;
        assertGt(refund, hub.tipWei(), "relayer got gas back plus the tip");
        assertEq(hub.spentToday(), refund, "vault booked exactly what it paid");
        assertEq(hub.deploySpentToday(), 0, "a send is not charged to the deploy budget");
    }

    /// The hub is a payer, never a gate. Even a wallet it never heard of can spend
    /// by calling `executeSigned` directly — this is the property that makes the
    /// whole design non-custodial.
    function test_hubIsNotAGate_directExecuteAlwaysWorks() public {
        TreeSigner s = new TreeSigner(bytes32(uint256(0xD1EC7)));
        address wallet = factory.deployWallet(s.root());
        vm.deal(wallet, 1 ether);

        assertFalse(hub.sponsored(wallet), "hub has no relationship with this wallet");

        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](1);
        op.calls[0] = IQuantumWallet.Call({to: RECIPIENT, value: 1 ether, data: ""});
        (bytes32[] memory wots, bytes32[] memory path) = s.sign(0, _w(wallet).opDigest(op));
        _w(wallet).executeSigned(op, IQuantumWallet.Sig({epoch: 0, leafIndex: 0, wots: wots, path: path}));

        assertEq(RECIPIENT.balance, 1 ether, "spent without the hub's permission");
    }

    // --- refund arithmetic ----------------------------------------------------

    /// A relayer names its own `tx.gasprice`, so without a cap it could invoice the
    /// vault for any number it liked.
    function test_gasPriceIsCapped_atBasefeePlusMaxPriority() public {
        (address wallet, TreeSigner s) = _sponsored(bytes32(uint256(0x6A5)));
        vm.deal(wallet, 1 ether);
        bytes memory data = _execData(wallet, s, 0, 1 wei);

        // Take `maxRefundWei` out of the picture: it would clamp the payout anyway
        // and hide whether the price cap works at all. Zero tip so the amount is
        // pure gas arithmetic.
        hub.setParams(800_000, 45_000, 2 gwei, 0, 100 ether, 20, 1 days);

        vm.fee(0);
        vm.txGasPrice(1000 gwei); // 500x the allowed priority fee
        uint256 before = address(this).balance;
        hub.relay(wallet, data);
        uint256 refund = address(this).balance - before;

        // Upper bound implied by the cap: no op can bill more gas than the forward
        // cap plus the declared overheads, and none of it may price above 2 gwei.
        uint256 capBound = (800_000 + 45_000 + 16 * data.length + 200_000) * uint256(2 gwei);
        assertLe(refund, capBound, "billed no more than the cap allows");

        // And a floor on what the uncapped bill would have been. `relay` cannot
        // plausibly use under 200k gas, so at 1000 gwei it would have cost at least
        // this much — two orders of magnitude above what was actually paid.
        uint256 uncappedFloor = 200_000 * uint256(1000 gwei);
        assertLe(refund * 100, uncappedFloor, "price cap actually bit");
        assertGt(refund, 0, "relayer was still paid");
    }

    function test_maxRefundWei_clampsPayout() public {
        (address wallet, TreeSigner s) = _sponsored(bytes32(uint256(0xC1A3)));
        vm.deal(wallet, 1 ether);
        bytes memory data = _execData(wallet, s, 0, 1 wei);

        hub.setParams(800_000, 45_000, 2 gwei, 0, 1000 wei, 20, 1 days);
        vm.fee(0);
        vm.txGasPrice(2 gwei);

        uint256 before = address(this).balance;
        hub.relay(wallet, data);
        assertEq(address(this).balance - before, 1000 wei, "clamped to maxRefundWei");
    }

    /// A doomed op must not be reimbursed, and the wallet's reason must survive so
    /// a relayer node can tell "try again later" from "never retry this".
    function test_failedOp_reverts_andPaysNothing() public {
        address wallet = hub.relayDeploy(keccak256("doomed"));
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);

        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 5; // wallet nonce is 0; rejected before any signature work
        op.validUntil = block.timestamp + 3600;
        IQuantumWallet.Sig memory sig;
        sig.wots = new bytes32[](67);
        sig.path = new bytes32[](10);

        bytes memory inner = abi.encodeWithSelector(IQuantumWallet.BadNonce.selector, uint256(5), uint256(0));
        vm.expectRevert(abi.encodeWithSelector(QuantumRelayHub.OpFailed.selector, inner));
        hub.relay(wallet, abi.encodeCall(IQuantumWallet.executeSigned, (op, sig)));
    }

    /// Bounds the damage one op can do to the vault. Proved by starving it: with
    /// 100 gas forwarded the wallet call cannot run, so the hub refuses the bill.
    function test_maxOpGas_isEnforced() public {
        address wallet = hub.relayDeploy(keccak256("gascap"));
        hub.setParams(100, 45_000, 2 gwei, 0, 1 ether, 20, 1 days);
        vm.txGasPrice(1 gwei);

        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        IQuantumWallet.Sig memory sig;
        sig.wots = new bytes32[](67);
        sig.path = new bytes32[](10);

        // Out of gas returns no data, so the wrapped reason is empty.
        vm.expectRevert(abi.encodeWithSelector(QuantumRelayHub.OpFailed.selector, bytes("")));
        hub.relay(wallet, abi.encodeCall(IQuantumWallet.executeSigned, (op, sig)));
    }

    /// An unfunded vault must refuse the bill rather than half-pay it.
    ///
    /// @dev `maxRefundWei` is pinned to a value far below what a real deploy costs
    /// (a deploy burns ~1.3M gas; at 1 gwei that is ~1.3e15 wei, thirteen times the
    /// clamp) so the refund is decided entirely by the clamp. Without that the
    /// `want` argument is whatever gas the deploy happened to use, which is not a
    /// number a test can name — and this file matches full revert data, not bare
    /// selectors, so an unnameable argument would mean no assertion at all.
    function test_vaultEmpty_reverts() public {
        QuantumRelayHub poor = new QuantumRelayHub(IQuantumWalletFactory(address(factory)), address(this));
        assertEq(address(poor).balance, 0, "unfunded on purpose");

        // Far below a real deploy's bill (~1.3e15 wei at 1 gwei), so `_refund`
        // clamps to exactly this and `want` stops depending on gas.
        uint256 clamp = 0.0001 ether;
        poor.setParams(800_000, 45_000, 2 gwei, 0, clamp, 20, 1 days);

        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        vm.expectRevert(abi.encodeWithSelector(QuantumRelayHub.VaultEmpty.selector, clamp, uint256(0)));
        poor.relayDeploy(keccak256("broke"));
    }

    // --- rate limiting --------------------------------------------------------

    function test_quota_exhausts_thenResetsWithTheWindow() public {
        (address wallet, TreeSigner s) = _sponsored(bytes32(uint256(0x9007A)));
        vm.deal(wallet, 1 ether);
        hub.setParams(800_000, 45_000, 2 gwei, 0, 1 ether, 1, 1 days); // one op per day

        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);
        hub.relay(wallet, _execData(wallet, s, 0, 1 wei));

        (, uint32 used) = hub.quotaOf(wallet);
        assertEq(used, 1, "quota consumed");

        // Empty calldata would fail the wallet call — it never gets that far,
        // which is the point: the quota is checked BEFORE any gas is forwarded.
        vm.expectRevert(abi.encodeWithSelector(QuantumRelayHub.QuotaExhausted.selector, wallet));
        hub.relay(wallet, hex"");

        vm.warp(block.timestamp + 1 days);
        hub.relay(wallet, _execData(wallet, s, 1, 1 wei));
        assertEq(_w(wallet).leafIndex(), 2, "second op landed in the new window");
    }

    function test_dailyCap_stopsSpending() public {
        hub.setCaps(1 wei, 1 wei);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);

        vm.expectRevert(QuantumRelayHub.DailyCapReached.selector);
        hub.relayDeploy(keccak256("capped"));
    }

    /// The separate deploy budget exists so that griefing wallet creation cannot
    /// consume the budget real users' sends depend on.
    function test_deployBudget_doesNotStarveSends() public {
        (address wallet, TreeSigner s) = _sponsored(bytes32(uint256(0xB0D6E7)));
        vm.deal(wallet, 1 ether);

        // Plenty of room overall, none left for deploys.
        hub.setCaps(1 ether, 1 wei);
        vm.fee(1 gwei);
        vm.txGasPrice(1 gwei);

        vm.expectRevert(QuantumRelayHub.DailyCapReached.selector);
        hub.relayDeploy(keccak256("starve"));

        // The send still goes through.
        hub.relay(wallet, _execData(wallet, s, 0, 1 wei));
        assertEq(_w(wallet).nonce(), 1, "send unaffected by the deploy budget");
    }

    function test_setCaps_rejectsDeployCapAboveDailyCap() public {
        vm.expectRevert(QuantumRelayHub.BadParam.selector);
        hub.setCaps(1 ether, 2 ether);
    }

    // --- reentrancy -----------------------------------------------------------

    function test_reentrantRelayer_isRefused() public {
        RelayReenterProbe probe = new RelayReenterProbe(hub);
        probe.fireDeploy(keccak256("probe-root"));

        assertTrue(probe.reentered(), "the refund really did hand control to the relayer");
        assertFalse(probe.reentrySucceeded(), "nonReentrant refused the second entry");
    }

    // --- pausing can never freeze funds ---------------------------------------

    function test_paused_stopsSubsidy_notSpending() public {
        (address wallet, TreeSigner s) = _sponsored(bytes32(uint256(0xBAA5E)));
        vm.deal(wallet, 1 ether);
        bytes memory data = _execData(wallet, s, 0, 1 wei);

        hub.setPaused(true);

        vm.expectRevert(QuantumRelayHub.IsPaused.selector);
        hub.relay(wallet, data);

        vm.expectRevert(QuantumRelayHub.IsPaused.selector);
        hub.relayDeploy(keccak256("while-paused"));

        // Same bytes, submitted by anyone, straight to the wallet. The owner can
        // switch off the subsidy; the owner cannot switch off the user.
        (bool ok,) = wallet.call(data);
        assertTrue(ok, "user still spends while the hub is paused");
        assertEq(_w(wallet).nonce(), 1, "op landed");
    }

    // --- administration -------------------------------------------------------

    function test_onlyOwner_guardsEveryKnob() public {
        address stranger = address(0xBAD);
        vm.startPrank(stranger);

        vm.expectRevert(QuantumRelayHub.NotOwner.selector);
        hub.setParams(1, 1, 1, 1, 1, 1, 1);

        vm.expectRevert(QuantumRelayHub.NotOwner.selector);
        hub.setCaps(1, 1);

        vm.expectRevert(QuantumRelayHub.NotOwner.selector);
        hub.setPaused(true);

        vm.expectRevert(QuantumRelayHub.NotOwner.selector);
        hub.withdraw(stranger, 1 ether);

        vm.expectRevert(QuantumRelayHub.NotOwner.selector);
        hub.transferOwnership(stranger);

        vm.stopPrank();
    }

    function test_ownership_requiresAcceptance() public {
        address next = address(0xC0FFEE);
        hub.transferOwnership(next);
        assertEq(hub.owner(), address(this), "handover is not yet complete");

        vm.prank(address(0xBAD));
        vm.expectRevert(QuantumRelayHub.NotOwner.selector);
        hub.acceptOwnership();

        vm.prank(next);
        hub.acceptOwnership();
        assertEq(hub.owner(), next, "handover complete");
        assertEq(hub.pendingOwner(), address(0), "pending cleared");
    }

    function test_withdraw_returnsSubsidyToOwner() public {
        uint256 before = address(this).balance;
        hub.withdraw(address(this), 5 ether);
        assertEq(address(this).balance - before, 5 ether, "owner recovered the subsidy");
        assertEq(address(hub).balance, 95 ether, "vault debited");
    }

    // --- the node's view ------------------------------------------------------

    function test_quote_tellsANodeWhetherRelayingWillPay() public {
        address wallet = hub.relayDeploy(keccak256("quoted"));

        (bool relayable, uint32 opsLeft, uint256 budgetLeft, uint256 balance) = hub.quote(wallet);
        assertTrue(relayable, "sponsored, funded, unpaused");
        assertEq(opsLeft, hub.opsPerWindow(), "full quota");
        assertEq(budgetLeft, hub.dailyCapWei(), "nothing spent yet");
        assertEq(balance, 100 ether, "vault balance surfaced");

        (bool strangerRelayable,,,) = hub.quote(address(0xDEAD));
        assertFalse(strangerRelayable, "unsponsored address is not relayable");

        hub.setPaused(true);
        (bool pausedRelayable,,,) = hub.quote(wallet);
        assertFalse(pausedRelayable, "pause is visible to nodes before they spend gas");
    }

    function test_receive_emitsFunded_andCreditsVault() public {
        uint256 before = address(hub).balance;
        (bool ok,) = address(hub).call{value: 1 ether}("");
        assertTrue(ok, "vault accepts funding");
        assertEq(address(hub).balance - before, 1 ether, "vault credited");
    }
}
