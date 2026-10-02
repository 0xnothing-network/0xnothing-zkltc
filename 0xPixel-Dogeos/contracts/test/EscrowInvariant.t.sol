// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DogeosPixel} from "../src/DogeosPixel.sol";
import {PixelMarket} from "../src/PixelMarket.sol";

interface InvariantVm {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
}

/// @dev Generates mixed ownership changes, approvals, listings, fills, offers,
/// expiry/refunds and withdrawals across distinct real payout roles. All
/// successful actions run the production contracts rather than a copied model.
contract EscrowHandler {
    InvariantVm constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DogeosPixel public immutable nft;
    PixelMarket public immutable market;
    address[4] public actors = [address(0xA11CE), address(0xB0B), address(0xCA), address(0xFEE)];

    constructor(DogeosPixel n, PixelMarket m) { nft = n; market = m; }

    function list(uint256 tokenSeed, uint256 amountSeed) external {
        uint256 id = tokenSeed % 3 + 1;
        address owner = nft.ownerOf(id);
        vm.prank(owner); nft.approve(address(market), id);
        vm.prank(owner); market.list(id, amountSeed % 1 ether + 1, uint64(block.timestamp + 1000));
    }

    function transfer(uint256 tokenSeed, uint256 actorSeed) external {
        uint256 id = tokenSeed % 3 + 1;
        address owner = nft.ownerOf(id);
        vm.prank(owner); nft.transferNFT(actors[actorSeed % 4], id);
    }

    function changeApproval(uint256 tokenSeed, bool approved) external {
        uint256 id = tokenSeed % 3 + 1;
        vm.prank(nft.ownerOf(id)); nft.approve(approved ? address(market) : address(0), id);
    }

    function offer(uint256 tokenSeed, uint256 actorSeed, uint256 amountSeed) external {
        uint256 id = tokenSeed % 3 + 1;
        uint256 actor = actorSeed % 4;
        if (actors[actor] == nft.ownerOf(id)) actor = (actor + 1) % 4;
        vm.prank(actors[actor]); market.makeOffer{value:amountSeed % 1 ether + 1}(id, uint64(block.timestamp + 1000));
    }

    function buy(uint256 tokenSeed, uint256 actorSeed) external {
        uint256 id = tokenSeed % 3 + 1;
        if (!market.isListingActive(id)) return;
        (address seller, uint256 price,,, uint256 quote) = market.listings(id);
        uint256 actor = actorSeed % 4;
        if (actors[actor] == seller) actor = (actor + 1) % 4;
        vm.prank(actors[actor]); market.buy{value:price}(id, quote);
    }

    function cancelOffer(uint256 seed) external {
        if (market.offerCount() == 0) return;
        uint256 id = seed % market.offerCount() + 1;
        (address bidder,, uint256 amount,) = market.offers(id);
        if (amount == 0) return;
        vm.prank(bidder); market.cancelOffer(id);
    }

    function acceptOffer(uint256 seed) external {
        if (market.offerCount() == 0) return;
        uint256 id = seed % market.offerCount() + 1;
        (address bidder, uint256 token, uint256 amount, uint64 expiry) = market.offers(id);
        if (amount == 0 || expiry <= block.timestamp) return;
        address owner = nft.ownerOf(token);
        if (owner == bidder) return;
        vm.prank(owner); nft.approve(address(market), token);
        vm.prank(owner); market.acceptOffer(id);
    }

    function cancelListing(uint256 seed) external {
        uint256 token = seed % 3 + 1;
        (address seller,,,,) = market.listings(token);
        if (seller == address(0)) return;
        vm.prank(seller); market.cancelListing(token);
    }

    function withdraw(uint256 actorSeed, uint256 recipientSeed) external {
        address actor = actors[actorSeed % 4];
        if (market.credits(actor) == 0) return;
        vm.prank(actor); market.withdraw(payable(actors[recipientSeed % 4]));
    }

    function expire(uint256 seed) external { vm.warp(block.timestamp + seed % 5000 + 1); }
}

contract EscrowInvariantTest {
    struct FuzzSelector { address addr; bytes4[] selectors; }
    struct FuzzArtifactSelector { string artifact; bytes4[] selectors; }
    struct FuzzInterface { address addr; string[] artifacts; }
    InvariantVm constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DogeosPixel nft;
    PixelMarket market;
    EscrowHandler handler;
    address[] private targets;

    function targetContracts() external view returns (address[] memory) { return targets; }
    // Standard Foundry invariant configuration hooks; explicit empty selections
    // avoid fallback warnings and leave every handler action eligible.
    function targetArtifacts() external pure returns (string[] memory) { return new string[](0); }
    function excludeArtifacts() external pure returns (string[] memory) { return new string[](0); }
    function targetArtifactSelectors() external pure returns (FuzzArtifactSelector[] memory) { return new FuzzArtifactSelector[](0); }
    function targetSenders() external pure returns (address[] memory) { return new address[](0); }
    function excludeSenders() external pure returns (address[] memory) { return new address[](0); }
    function excludeContracts() external pure returns (address[] memory) { return new address[](0); }
    function targetInterfaces() external pure returns (FuzzInterface[] memory) { return new FuzzInterface[](0); }
    function targetSelectors() external pure returns (FuzzSelector[] memory) { return new FuzzSelector[](0); }
    function excludeSelectors() external pure returns (FuzzSelector[] memory) { return new FuzzSelector[](0); }

    function setUp() public {
        vm.warp(1000);
        nft = new DogeosPixel(); market = new PixelMarket(nft, address(0xFEE));
        handler = new EscrowHandler(nft, market);
        targets.push(address(handler));
        vm.deal(address(handler), 10000 ether);
        for (uint256 i; i < 4; ++i) vm.deal(handler.actors(i), 10000 ether);
        for (uint256 i; i < 3; ++i) {
            vm.prank(handler.actors(i));
            nft.mintPacked("Invariant", "", 8, abi.encodePacked(bytes1(uint8(i)), hex"0000123456"));
        }
    }

    function invariantEscrowAndCreditsAreFullyBackedAndIndependentlySum() public view {
        uint256 accounts;
        for (uint256 i; i < 4; ++i) accounts += market.credits(handler.actors(i));
        require(accounts == market.totalCredits(), "credit sum diverged");
        uint256 escrow;
        for (uint256 i = 1; i <= market.offerCount(); ++i) {
            (,, uint256 amount,) = market.offers(i);
            escrow += amount;
        }
        require(escrow == market.totalOfferEscrow(), "offer sum diverged");
        require(accounts + escrow == address(market).balance, "liabilities not exactly backed");
    }

    function invariantOwnershipEnumerationBalancesAndIndicesAgree() public view {
        uint256 enumerated;
        for (uint256 i; i < 4; ++i) {
            address owner = handler.actors(i);
            uint256[] memory tokens = nft.tokensOfOwner(owner);
            require(tokens.length == nft.balanceOf(owner), "enumeration/balance mismatch");
            enumerated += tokens.length;
            for (uint256 j; j < tokens.length; ++j) {
                require(nft.ownerOf(tokens[j]) == owner && nft.userTokenIndex(tokens[j]) == j, "wrong owner/index");
                for (uint256 k = j + 1; k < tokens.length; ++k) require(tokens[j] != tokens[k], "duplicate enumeration");
            }
        }
        require(enumerated == 3 && nft.totalSupply() == 3, "token lost or duplicated");
    }
}
