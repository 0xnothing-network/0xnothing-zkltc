// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {QuantumWalletFactory} from "../../src/QuantumWalletFactory.sol";
import {QuantumWallet} from "../../src/QuantumWallet.sol";
import {IQuantumWallet} from "../../src/interfaces/IQuantumWallet.sol";
import {IQuantumWalletFactory} from "../../src/interfaces/IQuantumWalletFactory.sol";

contract QuantumWalletFactoryTest is TestBase {
    QuantumWalletFactory internal factory;

    function setUp() public {
        factory = new QuantumWalletFactory();
    }

    function test_predict_deploy_sameAddress() public {
        bytes32 root0 = keccak256("alice-root");
        address predicted = factory.predictWallet(root0);
        assertTrue(predicted.code.length == 0, "counterfactual (no code yet)");
        address deployed = factory.deployWallet(root0);
        assertEq(deployed, predicted, "deployed == predicted");
        assertTrue(deployed.code.length > 0, "deployed code exists");
    }

    function test_secondDeploy_revertsAlreadyDeployed() public {
        bytes32 root0 = keccak256("bob-root");
        address predicted = factory.predictWallet(root0);
        factory.deployWallet(root0);
        // AlreadyDeployed carries the wallet address, so the expectation must be
        // the full ABI-encoded error — a bare 4-byte selector never matches.
        vm.expectRevert(abi.encodeWithSelector(IQuantumWalletFactory.AlreadyDeployed.selector, predicted));
        factory.deployWallet(root0);
    }

    function test_differentRoots_differentWallets() public {
        address a = factory.predictWallet(keccak256("root-a"));
        address b = factory.predictWallet(keccak256("root-b"));
        assertNotEq(a, b, "different secrets => different wallet addresses");
    }

    function test_sameRoot_differentFactory_differentAddress() public {
        bytes32 root0 = keccak256("multi-factory");
        QuantumWalletFactory other = new QuantumWalletFactory();
        address here = factory.predictWallet(root0);
        address elsewhere = other.predictWallet(root0);
        assertNotEq(here, elsewhere, "wallet bound to deploying factory");
    }

    function test_predictIsStableAcrossCalls() public {
        bytes32 root0 = keccak256("stable");
        assertEq(factory.predictWallet(root0), factory.predictWallet(root0), "predict deterministic");
    }

    function test_isWallet() public {
        bytes32 root0 = keccak256("member");
        address w = factory.deployWallet(root0);
        assertTrue(factory.isWallet(w), "own wallet recognized");
        assertFalse(factory.isWallet(address(0xBEEF)), "EOA is not a wallet");
        assertFalse(factory.isWallet(address(new QuantumWalletFactory())), "foreign contract is not a wallet");
        // A wallet deployed by another factory is not "ours".
        QuantumWalletFactory other = new QuantumWalletFactory();
        address foreign = other.deployWallet(keccak256("foreign"));
        assertFalse(factory.isWallet(foreign), "foreign wallet not ours");
        assertTrue(other.isWallet(foreign), "foreign factory recognizes its own");
    }

    function test_counterfactualFundsUncontrollableUntilDeploy() public {
        // Anyone can send funds to a predicted address before it exists. The
        // factory guarantees deployment lands on exactly that address.
        bytes32 root0 = keccak256("counterfactual-factory");
        address predicted = factory.predictWallet(root0);
        vm.deal(predicted, 1234 ether);
        assertEq(predicted.balance, 1234 ether, "pre-funded");
        assertTrue(predicted.code.length == 0, "still no code, nobody controls it");
        address deployed = factory.deployWallet(root0);
        assertEq(deployed, predicted, "activation at predicted address");
        assertEq(deployed.balance, 1234 ether, "balance lands in wallet");
        assertEq(IQuantumWallet(payable(deployed)).factory(), address(factory), "wallet points at factory");
    }

    function test_initCodeHash_derived_from_creationCode_and_factory() public view {
        // Consistency guard: prediction and deployment both hinge on this hash;
        // a mismatch would make the contract deploy to the wrong address (reverted
        // in deployWallet). Sanity check the shape, not the internal value.
        bytes32 h1 = factory.initCodeHash(keccak256("x"));
        bytes32 h2 = factory.initCodeHash(keccak256("y"));
        assertTrue(h1 != h2, "initCodeHash depends on root0");
    }
}
