// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {HashSig} from "../../src/libs/HashSig.sol";
import {QuantumWallet} from "../../src/QuantumWallet.sol";
import {QuantumWalletFactory} from "../../src/QuantumWalletFactory.sol";
import {IQuantumWallet} from "../../src/interfaces/IQuantumWallet.sol";
import {IQuantumWalletFactory} from "../../src/interfaces/IQuantumWalletFactory.sol";
import {TreeSigner} from "../utils/TreeSigner.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {ReenterProbe} from "../mocks/ReenterProbe.sol";

/// Integration suite: a REAL full tree is signed by TreeSigner (SDK-equivalent
/// signing logic) and every op is executed against the deployed QuantumWallet.
contract QuantumWalletTest is TestBase {
    QuantumWalletFactory internal factory;

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new QuantumWalletFactory();
    }

    // --- plumbing -------------------------------------------------------------

    function _newWallet(bytes32 seed, address factory_) internal returns (address wallet, TreeSigner signer) {
        signer = new TreeSigner(seed);
        wallet = QuantumWalletFactory(factory_).deployWallet(signer.root());
    }

    function _sig(TreeSigner s, uint32 leaf, bytes32 digest) internal view returns (IQuantumWallet.Sig memory sig) {
        (bytes32[] memory wots, bytes32[] memory path) = s.sign(leaf, digest);
        sig = IQuantumWallet.Sig({epoch: 0, leafIndex: leaf, wots: wots, path: path});
    }

    function _garbageSig() internal view returns (IQuantumWallet.Sig memory sig) {
        sig.epoch = 0;
        sig.leafIndex = 0;
        sig.wots = new bytes32[](67);
        sig.path = new bytes32[](10);
    }

    function _wallet(address w) internal view returns (IQuantumWallet) {
        return IQuantumWallet(payable(w));
    }

    // --- replay/forgery pre-checks (no full tree needed) -----------------------

    function test_forgedSignature_rejected(uint256 rnd) public {
        bytes32 root0 = keccak256(abi.encode("forge", rnd));
        address w = factory.deployWallet(root0);
        IQuantumWallet.Sig memory bad = _garbageSig();

        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](0);

        vm.expectRevert(IQuantumWallet.Unauthorized.selector);
        _wallet(w).executeSigned(op, bad);
    }

    function test_wrongSignatureLength_rejected() public {
        address w = factory.deployWallet(keccak256("rootlen"));
        IQuantumWallet.Sig memory bad;
        bad.epoch = 0;
        bad.leafIndex = 0;
        bad.wots = new bytes32[](3); // must be 67
        bad.path = new bytes32[](10);

        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;

        vm.expectRevert(abi.encodeWithSelector(HashSig.WrongSignatureLength.selector, 3, HashSig.LEN));
        _wallet(w).executeSigned(op, bad);
    }

    function test_badNonce_rejected() public {
        address w = factory.deployWallet(keccak256("nonce"));
        IQuantumWallet.Sig memory bad = _garbageSig();
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 7; // wallet nonce is 0
        op.validUntil = block.timestamp + 3600;
        vm.expectRevert(abi.encodeWithSelector(IQuantumWallet.BadNonce.selector, 7, 0));
        _wallet(w).executeSigned(op, bad);
    }

    function test_expired_rejected() public {
        address w = factory.deployWallet(keccak256("expiry"));
        IQuantumWallet.Sig memory bad = _garbageSig();
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp - 1; // already expired
        vm.expectRevert(abi.encodeWithSelector(IQuantumWallet.Expired.selector, block.timestamp - 1, block.timestamp));
        _wallet(w).executeSigned(op, bad);
    }

    function test_outOfOrderLeaf_rejected() public {
        address w = factory.deployWallet(keccak256("leaforder"));
        IQuantumWallet.Sig memory bad;
        bad.epoch = 0;
        bad.leafIndex = 5; // wallet expects 0
        bad.wots = new bytes32[](67);
        bad.path = new bytes32[](10);
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        vm.expectRevert(abi.encodeWithSelector(IQuantumWallet.BadLeafIndex.selector, 5, 0));
        _wallet(w).executeSigned(op, bad);
    }

    // --- happy paths (real tree) ---------------------------------------------

    function test_nativeTransfer_and_nonceAdvance() public {
        (address w, TreeSigner s) = _newWallet(bytes32(uint256(0xABC)), address(factory));
        address recipient = address(0xBeef);
        vm.deal(w, 10 ether);

        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](1);
        op.calls[0] = IQuantumWallet.Call({to: recipient, value: 3 ether, data: ""});

        bytes32 d = _wallet(w).opDigest(op);
        IQuantumWallet.Sig memory sig = _sig(s, 0, d);
        _wallet(w).executeSigned(op, sig);

        assertEq(recipient.balance, 3 ether, "recipient got zkLTC");
        assertEq(w.balance, 7 ether, "wallet kept remainder");
        assertEq(_wallet(w).nonce(), 1, "nonce advanced");
        assertEq(_wallet(w).leafIndex(), 1, "leaf consumed");
        assertEq(_wallet(w).epoch(), 0, "epoch unchanged");
    }

    function test_replay_sameOp_rejected() public {
        (address w, TreeSigner s) = _newWallet(bytes32(uint256(0xBEEF)), address(factory));
        vm.deal(w, 1 ether);
        address recipient = address(0x1234);

        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](1);
        op.calls[0] = IQuantumWallet.Call({to: recipient, value: 0.5 ether, data: ""});

        bytes32 d = _wallet(w).opDigest(op);
        IQuantumWallet.Sig memory sig = _sig(s, 0, d);
        _wallet(w).executeSigned(op, sig);
        assertEq(recipient.balance, 0.5 ether, "first send ok");

        // Re-submit the exact same (op, sig): nonce already advanced -> revert.
        vm.expectRevert(abi.encodeWithSelector(IQuantumWallet.BadNonce.selector, 0, 1));
        _wallet(w).executeSigned(op, sig);
        assertEq(recipient.balance, 0.5 ether, "no double spend");
    }

    function test_erc20_batch_and_secondLeaf() public {
        (address w, TreeSigner s) = _newWallet(bytes32(uint256(0x1234)), address(factory));
        MockERC20 token = new MockERC20();
        address alice = address(0xA11CE);
        token.mint(w, 1000e18);

        // Batch: two calls in one op (transfer 60 + 40), proving arbitrary tokens + batching.
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](2);
        op.calls[0] = IQuantumWallet.Call({
            to: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", alice, 60e18)
        });
        op.calls[1] = IQuantumWallet.Call({
            to: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", address(0xB0B), 40e18)
        });

        bytes32 d = _wallet(w).opDigest(op);
        IQuantumWallet.Sig memory sig = _sig(s, 0, d);
        _wallet(w).executeSigned(op, sig);

        assertEq(token.balanceOf(alice), 60e18, "alice 60");
        assertEq(token.balanceOf(address(0xB0B)), 40e18, "bob 40");
        assertEq(token.balanceOf(w), 900e18, "wallet keeps rest");
        assertEq(_wallet(w).leafIndex(), 1, "leaf 0 used");

        // Second op must use leaf 1.
        IQuantumWallet.WalletOp memory op2;
        op2.walletNonce = 1;
        op2.validUntil = block.timestamp + 3600;
        op2.calls = new IQuantumWallet.Call[](1);
        op2.calls[0] = IQuantumWallet.Call({
            to: address(token),
            value: 0,
            data: abi.encodeWithSignature("transfer(address,uint256)", alice, 1e18)
        });
        bytes32 d2 = _wallet(w).opDigest(op2);
        IQuantumWallet.Sig memory sig2 = _sig(s, 1, d2);
        _wallet(w).executeSigned(op2, sig2);
        assertEq(token.balanceOf(alice), 61e18, "second op moved");
        assertEq(_wallet(w).leafIndex(), 2, "leaf 1 used");
    }

    function test_leafReuse_withinSignMessage_rejected() public {
        (address w, TreeSigner s) = _newWallet(bytes32(uint256(0x999)), address(factory));
        bytes32 msgHash = keccak256("hello eip1271");
        bytes32 d = _wallet(w).messageDigest(msgHash);
        IQuantumWallet.Sig memory sig = _sig(s, 0, d);
        _wallet(w).signMessage(msgHash, sig);
        assertEq(uint256(_wallet(w).leafIndex()), 1, "leaf consumed for message");

        // Reusing leaf 0 for another message must fail even though it would be a
        // different digest — strict sequential consumption prevents OTS reuse.
        bytes32 other = keccak256("other");
        bytes32 d2 = _wallet(w).messageDigest(other);
        IQuantumWallet.Sig memory replay = _sig(s, 0, d2);
        vm.expectRevert(abi.encodeWithSelector(IQuantumWallet.BadLeafIndex.selector, 0, 1));
        _wallet(w).signMessage(other, replay);
    }

    // --- EIP-1271 ---------------------------------------------------------------

    function test_eip1271_registerThenValidate() public {
        (address w, TreeSigner s) = _newWallet(bytes32(uint256(0x771)), address(factory));
        bytes32 msgHash = keccak256("typed data payload");

        // Before registration: not valid.
        // NOTE: assertTrue(x == y) rather than assertEq — bytes4 widens implicitly
        // to bytes32, so assertEq(bytes4,bytes4,string) has two viable overloads
        // and Solidity rejects the call as ambiguous.
        assertTrue(
            _wallet(w).isValidSignature(msgHash, "") == bytes4(0xffffffff),
            "not registered"
        );

        bytes32 d = _wallet(w).messageDigest(msgHash);
        IQuantumWallet.Sig memory sig = _sig(s, 0, d);
        _wallet(w).signMessage(msgHash, sig);

        assertTrue(
            _wallet(w).isValidSignature(msgHash, "") == bytes4(0x1626ba7e),
            "magic value"
        );
        assertTrue(
            _wallet(w).isValidSignature(keccak256("unrelated"), "") == bytes4(0xffffffff),
            "other still invalid"
        );
    }

    // --- rotate (key rotation, same address) -----------------------------------

    function test_rotateRoot_sameAddress_newTree() public {
        (address w, TreeSigner s0) = _newWallet(bytes32(uint256(0x1122)), address(factory));
        address recipient = address(0xC0FFEE);
        vm.deal(w, 5 ether);

        // Op on epoch0 leaf0.
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](1);
        op.calls[0] = IQuantumWallet.Call({to: recipient, value: 1 ether, data: ""});
        bytes32 d = _wallet(w).opDigest(op);
        _wallet(w).executeSigned(op, _sig(s0, 0, d));
        assertEq(_wallet(w).epoch(), 0, "epoch0 before rotate");

        // Build the replacement tree.
        TreeSigner s1 = new TreeSigner(bytes32(uint256(0x9988)));
        bytes32 newRoot = s1.root();

        // Rotate: authorized by the NEXT leaf (1) of the OLD tree.
        bytes32 rd = _wallet(w).rotateDigest(newRoot, 1);
        _wallet(w).rotateRoot(newRoot, 1, _sig(s0, 1, rd));

        assertEq(_wallet(w).merkleRoot(), newRoot, "root rotated");
        assertEq(_wallet(w).epoch(), 1, "epoch advanced");
        assertEq(_wallet(w).leafIndex(), 0, "leaf counter reset");
        assertEq(_wallet(w).factory(), address(factory), "factory unchanged");
        assertEq(w.balance, 4 ether, "funds intact across rotation");

        // Old-tree leaf (epoch0) can no longer authorize anything.
        IQuantumWallet.WalletOp memory op2;
        op2.walletNonce = 1;
        op2.validUntil = block.timestamp + 3600;
        op2.calls = new IQuantumWallet.Call[](0);
        bytes32 dOld = _wallet(w).opDigest(op2);
        // Sign with old tree epoch 0 (its leaf 2) => wrong epoch.
        IQuantumWallet.Sig memory sigOld = _sig(s0, 2, dOld);
        vm.expectRevert(abi.encodeWithSelector(IQuantumWallet.BadEpoch.selector, 0, 1));
        _wallet(w).executeSigned(op2, sigOld);

        // New tree (epoch1) leaf0 works.
        IQuantumWallet.WalletOp memory op3;
        op3.walletNonce = 1;
        op3.validUntil = block.timestamp + 3600;
        op3.calls = new IQuantumWallet.Call[](1);
        op3.calls[0] = IQuantumWallet.Call({to: recipient, value: 1 ether, data: ""});
        bytes32 dNew = _wallet(w).opDigest(op3);
        IQuantumWallet.Sig memory sigNew;
        {
            (bytes32[] memory wots, bytes32[] memory path) = s1.sign(0, dNew);
            sigNew = IQuantumWallet.Sig({epoch: 1, leafIndex: 0, wots: wots, path: path});
        }
        _wallet(w).executeSigned(op3, sigNew);
        assertEq(recipient.balance, 2 ether, "epoch1 op executed");
    }

    function test_rotateRoot_badNextEpoch_rejected() public {
        (address w, TreeSigner s) = _newWallet(bytes32(uint256(0x2222)), address(factory));
        TreeSigner s1 = new TreeSigner(bytes32(uint256(0x3333)));
        bytes32 newRoot = s1.root();
        bytes32 rd = _wallet(w).rotateDigest(newRoot, 2); // nextEpoch must be 1
        // Hoist the signature out of the call's argument list. `_sig` makes an
        // external TreeSigner.sign() call, and `vm.expectRevert` arms the NEXT
        // call — if that external call is evaluated inside rotateRoot's args it
        // consumes the expectRevert on a non-reverting call ("next call did not
        // revert"). Pre-computing to memory means rotateRoot is the next call.
        IQuantumWallet.Sig memory sig = _sig(s, 0, rd);
        vm.expectRevert(abi.encodeWithSelector(IQuantumWallet.InvalidRotateEpoch.selector, 2, 0));
        _wallet(w).rotateRoot(newRoot, 2, sig);
    }

    function test_reservedRotateLeaf_preventsBricking() public {
        (address w, TreeSigner s0) = _newWallet(bytes32(uint256(0xAAAA)), address(factory));
        uint32 n = uint32(HashSig.TREE_N); // 1024
        uint32 ops = n - 1; // leaves 0..1022 (1023) are spendable; 1023 is reserved

        for (uint32 i = 0; i < ops; ++i) {
            IQuantumWallet.WalletOp memory op;
            op.walletNonce = i;
            op.validUntil = block.timestamp + 3600;
            op.calls = new IQuantumWallet.Call[](0);
            bytes32 d = _wallet(w).opDigest(op);
            _wallet(w).executeSigned(op, _sig(s0, i, d));
        }
        assertEq(_wallet(w).leafIndex(), ops, "operational leaves spent");
        assertEq(_wallet(w).nonce(), ops, "nonce advanced in step");

        // An op that would need the reserved final leaf is refused.
        IQuantumWallet.WalletOp memory opX;
        opX.walletNonce = ops;
        opX.validUntil = block.timestamp + 3600;
        opX.calls = new IQuantumWallet.Call[](0);
        bytes32 dX = _wallet(w).opDigest(opX);
        // Hoist the signature out of the argument list (external TreeSigner.sign):
        // an external call inside executeSigned's args would consume the
        // vm.expectRevert below before executeSigned itself runs. See
        // test_rotateRoot_badNextEpoch_rejected for the full explanation.
        IQuantumWallet.Sig memory sigX = _sig(s0, ops, dX);
        vm.expectRevert(IQuantumWallet.TreeExhausted.selector);
        _wallet(w).executeSigned(opX, sigX);

        // Rotating with the reserved final leaf still succeeds — the wallet is
        // never bricked at the end of an epoch.
        TreeSigner s1 = new TreeSigner(bytes32(uint256(0xBBBB)));
        bytes32 rd = _wallet(w).rotateDigest(s1.root(), 1);
        _wallet(w).rotateRoot(s1.root(), 1, _sig(s0, ops, rd));
        assertEq(_wallet(w).epoch(), 1, "rotated using the reserved leaf");
        assertEq(_wallet(w).leafIndex(), 0, "fresh leaf counter after rotation");
    }

    // --- reentrancy -------------------------------------------------------------

    function test_reentrancy_blocked_stateRollsBack() public {
        (address w, TreeSigner s) = _newWallet(bytes32(uint256(0x5555)), address(factory));
        vm.deal(w, 1 ether);

        ReenterProbe probe = new ReenterProbe();

        // Attacker-crafted second op that would be submitted re-entrantly.
        IQuantumWallet.WalletOp memory evil;
        evil.walletNonce = 0;
        evil.validUntil = block.timestamp + 3600;
        evil.calls = new IQuantumWallet.Call[](0);
        probe.arm(w, evil, _garbageSig());

        // Innocent-looking op the OWNER signs: send 0 value to the probe and
        // trigger its `go()` which immediately re-enters the wallet.
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](1);
        op.calls[0] = IQuantumWallet.Call({to: address(probe), value: 0, data: abi.encodeWithSignature("go()")});

        bytes32 d = _wallet(w).opDigest(op);
        IQuantumWallet.Sig memory sig = _sig(s, 0, d);

        // The whole tx must revert (CallFailed because the re-entrant call
        // reverted with ReentrantCall) and no state may have advanced.
        bytes4 want = IQuantumWallet.CallFailed.selector;
        bool saw = false;
        try _wallet(w).executeSigned(op, sig) {
            assertTrue(false, "reentrant op should not succeed");
        } catch (bytes memory reason) {
            if (reason.length >= 4 && bytes4(reason) == want) saw = true;
        }
        assertTrue(saw, "reverted with CallFailed");
        assertEq(_wallet(w).nonce(), 0, "nonce rolled back");
        assertEq(_wallet(w).leafIndex(), 0, "leaf rolled back");
    }

    // --- counterfactual: receive before deploy, spend after ---------------------

    function test_receiveBeforeDeploy() public {
        // Build the signer FIRST: the wallet commits to the tree's ROOT, and that
        // root is a Merkle commitment derived FROM the seed. Deploying with the raw
        // seed (as this test originally did with keccak256("counterfactual")) makes
        // the wallet commit to a value no leaf can ever open, so executeSigned would
        // revert Unauthorized. Predict and deploy from s.root(), as _newWallet does.
        TreeSigner s = new TreeSigner(keccak256("counterfactual"));
        bytes32 root0 = s.root();
        address predicted = factory.predictWallet(root0);

        // Fund the not-yet-existing address (nobody can move these funds).
        vm.deal(predicted, 2 ether);
        assertEq(predicted.balance, 2 ether, "funds rest at address");

        // Deploy only when the user first acts.
        address w = factory.deployWallet(root0);
        assertEq(w, predicted, "deployed to predicted address");
        assertEq(w.balance, 2 ether, "funds preserved across activation");

        // Now they are controlled by the wallet's tree.
        address recipient = address(0x1DE);
        IQuantumWallet.WalletOp memory op;
        op.walletNonce = 0;
        op.validUntil = block.timestamp + 3600;
        op.calls = new IQuantumWallet.Call[](1);
        op.calls[0] = IQuantumWallet.Call({to: recipient, value: 1 ether, data: ""});
        bytes32 d = _wallet(w).opDigest(op);
        _wallet(w).executeSigned(op, _sig(s, 0, d));
        assertEq(recipient.balance, 1 ether, "pre-funded zkLTC spent");
    }
}
