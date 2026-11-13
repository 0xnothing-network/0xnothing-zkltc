// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NusdNftMarketplaceV2} from "../../src/0xpixel/NusdNftMarketplaceV2.sol";
import {ZeroXPixelV2} from "../../src/0xpixel/ZeroXPixelV2.sol";
import {MarketplaceBurnableNusdMock} from "../mocks/NusdMarketplaceMocks.sol";
import {
    EpochMutantNoOperatorEpoch,
    EpochMutantCountsOnlyChanges,
    EpochMutantCountsOnlyTransfers
} from "./mocks/EpochMutants.sol";

interface IReviewNft {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferNFT(address to, uint256 tokenId) external;
    function listingEpoch(uint256 tokenId, address operator) external view returns (uint256);
}

/// Stateful model of the E-01 fix of the 2026-11 audit, written during the adversarial review.
///
/// Model: a listing is "untouched" from list() until the first transfer of its token (by anyone,
/// through any entry point, including the market itself), the first approve() that changes the
/// token's approved address, or the first setApprovalForAll(market, x) by its seller that changes
/// that approval. The claim under attack:
///
///     a listing can be bought  <=>  it is active, untouched, the market is not paused and the
///                                   collection is allowed
///
/// Both directions are checked after every step with a real buy that is rolled back, for every
/// listing ever created in the run. Left to right is "no resurrection"; right to left is "nobody
/// else can end a live listing". With countNoOps = true an approval that changes nothing counts as
/// a touch too, which is how the first version of the fix behaved (review finding R-M-01).
abstract contract AuditMarketplaceModel is TestBase {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA201);
    address internal constant OPERATOR = address(0x09E7A7);
    address internal constant STRANGER = address(0x57A6E7);
    address internal constant PROBER = address(0x9208E2);
    uint256 internal constant PRICE = 100 ether;
    uint256 internal constant STEPS = 40;

    struct Tracked {
        uint256 listingId;
        uint256 tokenId;
        address seller;
        bool moved;
        bool seenInactive;
    }

    MarketplaceBurnableNusdMock internal nusd;
    IReviewNft internal pixel;
    NusdNftMarketplaceV2 internal market;
    Tracked[] internal tracked;
    uint256[2] internal tokens;
    bool internal countNoOps;
    bool internal paused;
    bool internal allowed = true;
    uint256 internal salesSeen;
    uint256 internal deadProbes;

    error ProbeResult(bool bought);
    error RunFinished();

    event log_named_uint(string key, uint256 value);
    event log_named_string(string key, string value);

    /// Deploys the collection and mints two tokens to ALICE.
    function _deployNft() internal virtual returns (address nft, uint256 first, uint256 second);

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MarketplaceBurnableNusdMock();
        (address nft, uint256 first, uint256 second) = _deployNft();
        pixel = IReviewNft(nft);
        tokens[0] = first;
        tokens[1] = second;
        address[] memory collections = new address[](1);
        collections[0] = nft;
        market = new NusdNftMarketplaceV2(address(nusd), address(this), collections);
        address[4] memory funded = [ALICE, BOB, CAROL, PROBER];
        for (uint256 i; i < funded.length; ++i) {
            nusd.mint(funded[i], 1_000_000_000 ether);
            vm.prank(funded[i]);
            nusd.approve(address(market), type(uint256).max);
        }
    }

    function _run(uint256 seed) internal {
        uint256 mode = seed % 3; // 0 single approvals, 1 approval for all, 2 both
        if (mode != 0) {
            vm.prank(ALICE);
            pixel.setApprovalForAll(address(market), true);
        }
        for (uint256 i; i < 2; ++i) {
            if (mode != 1) {
                vm.prank(ALICE);
                pixel.approve(address(market), tokens[i]);
            }
        }
        for (uint256 i; i < 2; ++i) {
            vm.prank(ALICE);
            uint256 listingId = market.list(address(pixel), tokens[i], PRICE);
            tracked.push(Tracked(listingId, tokens[i], ALICE, false, false));
        }
        _check();
        for (uint256 step; step < STEPS; ++step) {
            _act(uint256(keccak256(abi.encode(seed, step))), true);
            _check();
        }
    }

    /// Runs one seed and always reverts, so that a caller can try many seeds from the same state.
    function runAndRevert(uint256 seed) external {
        require(msg.sender == address(this), "ONLY_SELF");
        _run(seed);
        revert RunFinished();
    }

    /// The first seed below `maxSeeds` on which the model is violated, with the message.
    function _firstViolation(uint256 maxSeeds) internal returns (bool caught, uint256 seed, string memory message) {
        for (seed = 0; seed < maxSeeds; ++seed) {
            try this.runAndRevert(seed) {
                revert("RUN_DID_NOT_REVERT");
            } catch (bytes memory data) {
                if (data.length == 4 && bytes4(data) == RunFinished.selector) continue;
                if (data.length >= 68 && bytes4(data) == bytes4(0x08c379a0)) {
                    assembly ("memory-safe") {
                        message := add(data, 0x44)
                    }
                } else {
                    message = "non-string revert";
                }
                return (true, seed, message);
            }
        }
        return (false, maxSeeds, "");
    }

    // ------------------------------------------------------------------ actions

    function _act(uint256 r, bool allowCycle) private {
        uint256 kind = r % 17;
        uint256 tokenId = tokens[(r >> 8) % 2];
        address owner = pixel.ownerOf(tokenId);
        address other = _holder((r >> 16) % 3);
        bool flag = ((r >> 24) & 1) == 1;
        bool flag2 = ((r >> 32) & 1) == 1;
        if (kind == 0) _tokenApprove(owner, address(market), tokenId);
        else if (kind == 1) _tokenApprove(owner, address(0), tokenId);
        else if (kind == 2) _tokenApprove(owner, flag ? CAROL : OPERATOR, tokenId);
        else if (kind == 3) _tokenApprove(OPERATOR, address(market), tokenId);
        else if (kind == 4) _tokenApprove(OPERATOR, address(0), tokenId);
        else if (kind == 5) _setOperator(_holder((r >> 40) % 3), address(market), flag2);
        else if (kind == 6) _setOperator(_holder((r >> 40) % 3), OPERATOR, flag2);
        else if (kind == 7) _strangerNoise(tokenId, flag);
        else if (kind == 8) _transfer(owner, owner, other, tokenId, (r >> 48) % 3);
        else if (kind == 9) _transfer(OPERATOR, owner, other, tokenId, 0);
        else if (kind == 10 || kind == 11) _list(owner, tokenId);
        else if (kind == 12) _reprice(r >> 56);
        else if (kind == 13) _offerAndAccept(owner, tokenId, flag);
        else if (kind == 14) {
            if (allowCycle) _cycle(flag, r >> 64);
        } else if (kind == 15) {
            _realBuy(r >> 56);
        } else {
            _invalidate(r >> 56);
        }
    }

    function _holder(uint256 index) private pure returns (address) {
        return index == 0 ? ALICE : index == 1 ? BOB : CAROL;
    }

    function _tokenApprove(address caller, address to, uint256 tokenId) private {
        bool changes = pixel.getApproved(tokenId) != to;
        vm.prank(caller);
        try pixel.approve(to, tokenId) {
            if (countNoOps || changes) _markToken(tokenId);
        } catch {}
    }

    function _setOperator(address caller, address operator, bool value) private {
        bool changes = pixel.isApprovedForAll(caller, operator) != value;
        vm.prank(caller);
        pixel.setApprovalForAll(operator, value);
        if (operator == address(market) && (countNoOps || changes)) _markSeller(caller);
    }

    /// A wallet nobody approved: its own approvals are its own business, and it can touch nothing.
    function _strangerNoise(uint256 tokenId, bool value) private {
        address owner = pixel.ownerOf(tokenId);
        vm.prank(STRANGER);
        pixel.setApprovalForAll(address(market), value);
        vm.prank(STRANGER);
        try pixel.approve(address(market), tokenId) {
            revert("STRANGER_APPROVED");
        } catch {}
        vm.prank(STRANGER);
        try pixel.transferFrom(owner, STRANGER, tokenId) {
            revert("STRANGER_TRANSFERRED");
        } catch {}
    }

    function _transfer(address caller, address from, address to, uint256 tokenId, uint256 path) private {
        vm.prank(caller);
        if (path == 1) {
            try pixel.safeTransferFrom(from, to, tokenId) {
                _markToken(tokenId);
            } catch {}
        } else if (path == 2 && caller == from) {
            try pixel.transferNFT(to, tokenId) {
                _markToken(tokenId);
            } catch {}
        } else {
            try pixel.transferFrom(from, to, tokenId) {
                _markToken(tokenId);
            } catch {}
        }
    }

    function _list(address owner, uint256 tokenId) private {
        uint256 previous = market.tokenToListingId(address(pixel), tokenId);
        vm.prank(owner);
        try market.list(address(pixel), tokenId, PRICE) returns (uint256 listingId) {
            if (previous != 0) {
                assertFalse(_activeOf(previous), "a replaced listing is still active");
                assertTrue(tracked[_find(previous)].moved, "an untouched listing was replaced");
            }
            tracked.push(Tracked(listingId, tokenId, owner, false, false));
        } catch (bytes memory reason) {
            if (reason.length == 4 && bytes4(reason) == NusdNftMarketplaceV2.AlreadyListed.selector) {
                Tracked storage blocking = tracked[_find(previous)];
                assertTrue(blocking.seller == owner && !blocking.moved, "AlreadyListed for a listing the model calls dead");
            }
        }
    }

    function _reprice(uint256 r) private {
        Tracked storage t = tracked[r % tracked.length];
        bool expected = _expected(t);
        vm.prank(t.seller);
        try market.updateListingPrice(t.listingId, PRICE) {
            assertTrue(expected, "repriced a listing the model calls dead");
        } catch {
            assertFalse(expected, "an untouched listing could not be repriced");
        }
    }

    function _offerAndAccept(address owner, uint256 tokenId, bool accept) private {
        address offerer = owner == CAROL ? BOB : CAROL;
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 days);
        vm.prank(offerer);
        try market.makeOffer(address(pixel), tokenId, 50 ether, expiry, 50 ether) returns (uint256 offerId) {
            if (!accept) return;
            vm.prank(owner);
            try market.acceptOffer(offerId, 0) {
                _markToken(tokenId);
            } catch {}
        } catch {}
    }

    /// Switch the market off (pause or disallow), do one thing, switch it back on.
    function _cycle(bool pauseIt, uint256 r) private {
        if (pauseIt) {
            market.pause();
            paused = true;
        } else {
            market.setCollectionAllowed(address(pixel), false);
            allowed = false;
        }
        _check();
        _act(r, false);
        _check();
        if (pauseIt) {
            market.unpause();
            paused = false;
        } else {
            market.setCollectionAllowed(address(pixel), true);
            allowed = true;
        }
    }

    function _realBuy(uint256 r) private {
        Tracked storage t = tracked[r % tracked.length];
        address buyer = _holder((r >> 8) % 3);
        if (buyer == t.seller) buyer = _holder(((r >> 8) + 1) % 3);
        bool expected = _expected(t);
        vm.prank(buyer);
        try market.buy(t.listingId, PRICE, PRICE) {
            assertTrue(expected, "bought a listing the model calls dead");
            _markToken(t.tokenId);
        } catch {
            assertFalse(expected, "an untouched listing could not be bought");
        }
    }

    function _invalidate(uint256 r) private {
        Tracked storage t = tracked[r % tracked.length];
        bool active = _activeOf(t.listingId);
        vm.prank(STRANGER);
        try market.invalidateListing(t.listingId) {
            assertTrue(active && (t.moved || !allowed), "a stranger removed an untouched listing");
        } catch {
            assertTrue(!active || (!t.moved && allowed), "a dead listing could not be removed");
        }
    }

    // ------------------------------------------------------------------ model and checks

    function _markToken(uint256 tokenId) private {
        for (uint256 i; i < tracked.length; ++i) {
            if (tracked[i].tokenId == tokenId) tracked[i].moved = true;
        }
    }

    function _markSeller(address seller) private {
        for (uint256 i; i < tracked.length; ++i) {
            if (tracked[i].seller == seller) tracked[i].moved = true;
        }
    }

    function _find(uint256 listingId) private view returns (uint256) {
        for (uint256 i; i < tracked.length; ++i) {
            if (tracked[i].listingId == listingId) return i;
        }
        revert("UNTRACKED_LISTING");
    }

    function _activeOf(uint256 listingId) internal view returns (bool active) {
        (,,,, active,) = market.listings(listingId);
    }

    function _expected(Tracked storage t) private view returns (bool) {
        return _activeOf(t.listingId) && !t.moved && !paused && allowed;
    }

    function _check() private {
        for (uint256 i; i < tracked.length; ++i) {
            Tracked storage t = tracked[i];
            bool active = _activeOf(t.listingId);
            if (t.seenInactive) assertFalse(active, "an inactive listing became active again");
            if (!active) t.seenInactive = true;

            bool expected = active && !t.moved && !paused && allowed;
            bool actual = _canBuy(t.listingId);
            assertTrue(actual == expected, actual ? "a touched listing sold" : "an untouched listing did not sell");
            if (actual) ++salesSeen;
            else ++deadProbes;

            // With its seller as owner, the number equals the stored one exactly while untouched:
            // the sum of the two counters never returns to an earlier value.
            if (pixel.ownerOf(t.tokenId) == t.seller) {
                (,,,,, uint256 stored) = market.listings(t.listingId);
                bool same = pixel.listingEpoch(t.tokenId, address(market)) == stored;
                assertTrue(same == !t.moved, same ? "the epoch repeated" : "the epoch moved without cause");
            }
            if (active) {
                assertEq(market.tokenToListingId(address(pixel), t.tokenId), t.listingId, "token points elsewhere");
            }
        }
        assertEq(nusd.balanceOf(address(market)), market.totalLiabilitiesNusd(), "liabilities not backed");
    }

    function probeBuy(uint256 listingId) external {
        require(msg.sender == address(this), "ONLY_SELF");
        vm.prank(PROBER);
        try market.buy(listingId, PRICE, PRICE) {
            revert ProbeResult(true);
        } catch {
            revert ProbeResult(false);
        }
    }

    function _canBuy(uint256 listingId) internal returns (bool bought) {
        try this.probeBuy(listingId) {
            revert("PROBE_DID_NOT_REVERT");
        } catch (bytes memory data) {
            require(data.length == 36, "BAD_PROBE");
            bytes4 selector;
            uint256 value;
            assembly ("memory-safe") {
                selector := mload(add(data, 0x20))
                value := mload(add(data, 0x24))
            }
            require(selector == ProbeResult.selector, "BAD_PROBE_SELECTOR");
            bought = value != 0;
        }
    }
}

/// The real collection and the real market.
contract AuditMarketplaceModelTest is AuditMarketplaceModel {
    function _deployNft() internal override returns (address nft, uint256 first, uint256 second) {
        ZeroXPixelV2 real = new ZeroXPixelV2();
        vm.startPrank(ALICE);
        first = real.mintPacked("first", "", 8, hex"000000ff0000");
        second = real.mintPacked("second", "", 8, hex"00000000ff00");
        vm.stopPrank();
        nft = address(real);
    }

    /// forge-config: default.fuzz.runs = 1000
    function testFuzzAudit_E01_aListingSellsOnlyWhileUntouched(uint256 seed) public {
        _run(seed);
        assertGe(salesSeen, 2, "both listings were live at the start");
    }

    /// One fixed run with its statistics, to show the fuzz above is not vacuous.
    function testAudit_E01_modelRunSample() public {
        _run(uint256(keccak256("review-market-sample")));
        emit log_named_uint("listings created in the run", tracked.length);
        emit log_named_uint("probes that bought", salesSeen);
        emit log_named_uint("probes that were refused", deadProbes);
        assertGt(tracked.length, 2, "the run listed again at least once");
        assertGt(deadProbes, 0, "and probed dead listings");
    }

    /// The same model with "a repeated approval is a touch" does not hold any more: the real
    /// collection keeps a listing through an approval that changes nothing (review finding R-M-01).
    function testAudit_E01_repeatedApprovalsNoLongerEndListings() public {
        countNoOps = true;
        (bool caught, uint256 seed, string memory message) = _firstViolation(100);
        emit log_named_uint("first seed with a repeated approval", seed);
        emit log_named_string("what the old model expected", message);
        assertTrue(caught, "a listing outlived a repeated approval within 100 seeds");
    }

    /// The scenario of R-M-01: a repeated approval ends nothing, and the two E-01 scenarios still
    /// end the listing.
    function testAudit_E01_scenariosOnTheRealCollection() public {
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), true);
        uint256 a = market.list(address(pixel), tokens[0], PRICE);
        uint256 b = market.list(address(pixel), tokens[1], PRICE);
        pixel.setApprovalForAll(address(market), true); // repeated
        pixel.approve(address(0), tokens[0]); // already none
        vm.stopPrank();
        assertTrue(_canBuy(a), "a repeated approval for all does not end the listing");
        assertTrue(_canBuy(b), "nor the other one");

        // Away and back under the approval for all.
        vm.prank(ALICE);
        pixel.transferFrom(ALICE, BOB, tokens[0]);
        vm.prank(BOB);
        pixel.transferFrom(BOB, ALICE, tokens[0]);
        assertFalse(_canBuy(a), "a transfer away and back still ends it");
        assertTrue(_canBuy(b), "the untouched token is still for sale");

        // Revoke and grant again.
        vm.startPrank(ALICE);
        pixel.setApprovalForAll(address(market), false);
        pixel.setApprovalForAll(address(market), true);
        vm.stopPrank();
        assertFalse(_canBuy(b), "revoke and re-approve still ends it");
        assertFalse(_canBuy(a), "and nothing came back");
    }
}

/// The model against three broken counters. Each test passes when the model notices the listing
/// that came back, which is what gives the passing fuzz above its meaning.
contract AuditMarketplaceModelCatchesNoOperatorEpochTest is AuditMarketplaceModel {
    function _deployNft() internal override returns (address nft, uint256 first, uint256 second) {
        EpochMutantNoOperatorEpoch mutant = new EpochMutantNoOperatorEpoch();
        mutant.mint(ALICE, 1);
        mutant.mint(ALICE, 2);
        return (address(mutant), 1, 2);
    }

    function testAudit_E01_modelCatches_missingOperatorCounter() public {
        (bool caught, uint256 seed, string memory message) = _firstViolation(100);
        emit log_named_uint("first violating seed", seed);
        emit log_named_string("violation", message);
        assertTrue(caught, "the model saw the revoke / re-approve resurrection");
    }
}

contract AuditMarketplaceModelCatchesOnlyChangesTest is AuditMarketplaceModel {
    function _deployNft() internal override returns (address nft, uint256 first, uint256 second) {
        EpochMutantCountsOnlyChanges mutant = new EpochMutantCountsOnlyChanges();
        mutant.mint(ALICE, 1);
        mutant.mint(ALICE, 2);
        return (address(mutant), 1, 2);
    }

    function testAudit_E01_modelCatches_transfersNotCountedUnderApprovalForAll() public {
        (bool caught, uint256 seed, string memory message) = _firstViolation(100);
        emit log_named_uint("first violating seed", seed);
        emit log_named_string("violation", message);
        assertTrue(caught, "the model saw the transfer away and back resurrection");
    }
}

contract AuditMarketplaceModelCatchesOnlyTransfersTest is AuditMarketplaceModel {
    function _deployNft() internal override returns (address nft, uint256 first, uint256 second) {
        EpochMutantCountsOnlyTransfers mutant = new EpochMutantCountsOnlyTransfers();
        mutant.mint(ALICE, 1);
        mutant.mint(ALICE, 2);
        return (address(mutant), 1, 2);
    }

    function testAudit_E01_modelCatches_approveNotCounted() public {
        (bool caught, uint256 seed, string memory message) = _firstViolation(100);
        emit log_named_uint("first violating seed", seed);
        emit log_named_string("violation", message);
        assertTrue(caught, "the model saw the approve(0) / approve(market) resurrection");
    }
}
