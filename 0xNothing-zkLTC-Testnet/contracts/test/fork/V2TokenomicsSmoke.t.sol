// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { TestBase } from "../TestBase.sol";
import { DIAOracleAdapter } from "../../src/nusd/DIAOracleAdapter.sol";
import { OracleNUSDv2 } from "../../src/nusd/OracleNUSDv2.sol";
import { RewardStaking } from "../../src/rewards/RewardStaking.sol";
import { FeeSplitter } from "../../src/treasury/FeeSplitter.sol";
import { SurplusMintGovernor } from "../../src/governance/SurplusMintGovernor.sol";
import { ZeroXPumpV2 } from "../../src/pump/ZeroXPumpV2.sol";
import { NusdNftMarketplaceV2 } from "../../src/0xpixel/NusdNftMarketplaceV2.sol";

interface VmFork {
    function mockCall(address callee, bytes calldata data, bytes calldata returnData) external;
}

interface IRouterV2 {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory amounts);
    function accruedRouterFees(address token) external view returns (uint256);
    function distributeFees(address token) external returns (uint256);
    function feeSplitter() external view returns (address);
    function treasury() external view returns (address);
}

/// Operator smoke test of the DEPLOYED v2 tokenomics suite (deployments/liteforge-testnet/v2.json)
/// on a local LiteForge fork. Runs only when LITVM_RPC_URL is set; nothing is broadcast.
/// The DIA price is pinned to its live value whenever a test moves time past the 90-minute max age.
contract V2TokenomicsSmokeForkTest is TestBase {
    OracleNUSDv2 private constant NUSD = OracleNUSDv2(payable(0x1d041A8e575006D46Ae0Aa2E4869C5be0327874E));
    DIAOracleAdapter private constant ADAPTER = DIAOracleAdapter(0x3579B31e3241DE60F5F9462B3E0d759F346a49c8);
    address private constant TREASURY = 0xd840C91D9dB6c4761dE9F732977C3FAcc8976375;
    RewardStaking private constant STAKING = RewardStaking(0x735DFf17Df61F0bF1034603BcdE02f8Fa7B8CaE4);
    FeeSplitter private constant SPLITTER = FeeSplitter(payable(0x768A24803457B0E2F65d918815F7da8Ae1628E19));
    SurplusMintGovernor private constant GOVERNOR = SurplusMintGovernor(0x06a2CF180Ae568f3FAa487fB45dd8903c7114269);
    ZeroXPumpV2 private constant PUMP = ZeroXPumpV2(0x87Ae7e019C2e511eE97310215d5Ae358c28F47D9);
    NusdNftMarketplaceV2 private constant MARKET = NusdNftMarketplaceV2(0xA5e3EDfcba3b6fc40f3e41557f8a303a2AAC7e09);
    IRouterV2 private constant ROUTER = IRouterV2(0xF33fCB0Bd0795EAcbe4b1BB4E8c3d904483847F5);
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    address private constant PIXEL_V1 = 0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988;
    address private constant PIXEL_V2 = 0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB;
    address private constant CONTROLLER = 0x81DF1ba96a5b9F54ABF1eC1Ce232254fA58b180e;

    address private constant USER = address(0x5A0E);
    VmFork private constant vmf = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private pinnedPrice;

    function _fork() private returns (bool) {
        string memory rpcUrl = vm.envOr("LITVM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return false;
        vm.createSelectFork(rpcUrl);
        try ADAPTER.readPriceWad() returns (uint256 price, uint256, uint80) {
            pinnedPrice = price;
        } catch {
            pinnedPrice = 60 ether; // DIA stale at the fork block: pin a representative price.
        }
        _pinPrice();
        return true;
    }

    /// Keeps the NUSD oracle usable after `vm.warp` (only inside this local fork).
    function _pinPrice() private {
        vmf.mockCall(
            address(ADAPTER),
            abi.encodeWithSelector(DIAOracleAdapter.readPriceWad.selector),
            abi.encode(pinnedPrice, vm.getBlockTimestamp(), uint80(1))
        );
    }

    function _mintNusd(address account, uint256 amountNusd) private {
        uint256 collateral = (amountNusd * 1e18) / pinnedPrice + 1 ether;
        vm.deal(account, account.balance + collateral);
        vm.prank(account);
        NUSD.mintAtOracle{ value: collateral }(amountNusd, account);
    }

    function testForkV2Wiring() public {
        if (!_fork()) return;
        assertEq(NUSD.surplusMinter(), address(GOVERNOR), "surplus minter");
        assertEq(address(NUSD.oracle()), address(ADAPTER), "nusd oracle");
        assertEq(SPLITTER.rewardPool(), address(STAKING), "splitter pool");
        assertEq(SPLITTER.treasury(), TREASURY, "splitter treasury");
        assertEq(PUMP.feeRecipient(), address(SPLITTER), "pump fees");
        assertEq(PUMP.admin(), CONTROLLER, "pump admin is the graduation controller");
        assertEq(ROUTER.feeSplitter(), address(SPLITTER), "router splitter");
        assertEq(ROUTER.treasury(), TREASURY, "router treasury");
        assertEq(MARKET.IMPLEMENTATION_ID(), keccak256("0xpixel.nusd.marketplace.v2"), "market implementation");
        assertTrue(MARKET.collectionAllowed(PIXEL_V1) && MARKET.collectionAllowed(PIXEL_V2), "collections");
        assertEq(address(GOVERNOR.nusd()), address(NUSD), "governor nusd");
    }

    function testForkSwapAndPumpFeesReachPoolAndTreasury() public {
        if (!_fork()) return;
        _mintNusd(USER, 200 ether);

        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(NUSD), WZKLTC);
        uint256 accruedBefore = ROUTER.accruedRouterFees(address(NUSD));
        vm.startPrank(USER);
        NUSD.approve(address(ROUTER), 10 ether);
        ROUTER.swapExactTokensForTokens(10 ether, 0, path, USER, vm.getBlockTimestamp() + 60);
        vm.stopPrank();
        uint256 accrued = ROUTER.accruedRouterFees(address(NUSD));
        assertEq(accrued - accruedBefore, 0.01 ether, "0.1% of a NUSD input");

        uint256 poolBefore = NUSD.balanceOf(address(STAKING));
        uint256 treasuryBefore = NUSD.balanceOf(TREASURY);
        ROUTER.distributeFees(address(NUSD));
        assertEq(NUSD.balanceOf(address(STAKING)) - poolBefore, accrued / 2, "router half to pool");
        assertEq(NUSD.balanceOf(TREASURY) - treasuryBefore, accrued - accrued / 2, "router half to treasury");

        bytes32 commitment = keccak256(abi.encode("v2-fork-smoke", vm.getBlockTimestamp()));
        vm.startPrank(USER);
        NUSD.approve(address(PUMP), 5 ether);
        PUMP.reserveMarket(commitment);
        address token = PUMP.createMarket("Fork Smoke", "SMOKE", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
        PUMP.buy(token, 2 ether, 0, vm.getBlockTimestamp() + 60);
        vm.stopPrank();
        uint256 pumpFees = PUMP.accruedProtocolFeesNusd();
        poolBefore = NUSD.balanceOf(address(STAKING));
        PUMP.distributeFees();
        assertEq(NUSD.balanceOf(address(STAKING)) - poolBefore, pumpFees / 2, "pump half to pool");
    }

    function testForkFullRewardRound() public {
        if (!_fork()) return;
        _mintNusd(USER, 10_200 ether);
        vm.startPrank(USER);
        NUSD.approve(address(STAKING), 100 ether);
        STAKING.stake(100 ether, 30 days);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        _pinPrice();
        vm.prank(USER);
        NUSD.transfer(address(STAKING), 10_000 ether); // stands in for accumulated fees
        STAKING.trigger();

        (,, uint256 claimable) = STAKING.accountState(USER);
        // Other live stakers (if any) share the round; this wallet holds most of the weight.
        assertGt(claimable, 0, "nothing allocated");
        assertLe(claimable, 10_000 ether, "over-allocated");
        vm.prank(USER);
        STAKING.claim(USER);

        vm.warp(vm.getBlockTimestamp() + 30 days);
        uint256 positionId = STAKING.positionIdsOf(USER)[0];
        vm.prank(USER);
        STAKING.withdraw(positionId);
    }

    function testForkMarketplaceBurnsAndPaysCreator() public {
        if (!_fork()) return;
        (uint256 tokenId, address seller) = _eoaToken(PIXEL_V2);
        address buyer = address(0xB0B5);
        _mintNusd(buyer, 120 ether);

        vm.startPrank(seller);
        IERC721(PIXEL_V2).approve(address(MARKET), tokenId);
        uint256 listingId = MARKET.list(PIXEL_V2, tokenId, 100 ether);
        vm.stopPrank();

        (uint256 burnAmount, address creator, uint256 creatorFee, uint256 proceeds) = MARKET.quoteSale(PIXEL_V2, tokenId, 100 ether);
        assertEq(burnAmount, 0.1 ether, "0.1% burn");
        assertEq(creatorFee, 0.4 ether, "0.4% creator");
        uint256 supplyBefore = NUSD.totalSupply();
        uint256 sellerBefore = MARKET.credits(seller);
        uint256 creatorBefore = MARKET.credits(creator);

        vm.startPrank(buyer);
        IERC20(address(NUSD)).approve(address(MARKET), 100 ether);
        MARKET.buy(listingId, 100 ether, 100 ether);
        vm.stopPrank();

        assertEq(supplyBefore - NUSD.totalSupply(), burnAmount, "supply burned");
        assertEq(IERC721(PIXEL_V2).ownerOf(tokenId), buyer, "nft delivered");
        if (creator == seller) {
            assertEq(MARKET.credits(seller) - sellerBefore, proceeds + creatorFee, "creator-seller credit");
        } else {
            assertEq(MARKET.credits(seller) - sellerBefore, proceeds, "seller credit");
            assertEq(MARKET.credits(creator) - creatorBefore, creatorFee, "creator credit");
        }
        assertGe(NUSD.balanceOf(address(MARKET)), MARKET.escrowedNusd() + MARKET.totalCreditsNusd(), "market solvent");
    }

    function testForkSurplusVoteMintsBackToTwoX() public {
        if (!_fork()) return;
        vm.expectRevert(SurplusMintGovernor.TriggerNotReached.selector);
        GOVERNOR.propose();

        address[] memory voters = new address[](11);
        for (uint256 i; i < voters.length; ++i) {
            voters[i] = address(uint160(0xA000 + i));
            _mintNusd(voters[i], 100 ether);
            vm.prank(voters[i]);
            NUSD.approve(address(GOVERNOR), 100 ether);
        }
        // Push the reserve above 3x supply (covering adds collateral without minting).
        uint256 supply = NUSD.totalSupply();
        uint256 needed = (supply * 4 * 1e18) / pinnedPrice;
        vm.deal(address(this), needed);
        NUSD.coverReserve{ value: needed }();
        (, bool triggerReached) = NUSD.surplusMintCapacity();
        assertTrue(triggerReached, "3x reached");

        vm.prank(voters[0]);
        uint256 proposalId = GOVERNOR.propose();
        for (uint256 i = 1; i < voters.length; ++i) {
            vm.prank(voters[i]);
            GOVERNOR.vote(true);
        }
        vm.warp(vm.getBlockTimestamp() + 3 days);
        _pinPrice();
        uint256 poolBefore = NUSD.balanceOf(address(STAKING));
        uint256 treasuryBefore = NUSD.balanceOf(TREASURY);
        GOVERNOR.settle(proposalId);

        SurplusMintGovernor.Proposal memory proposal = GOVERNOR.getProposal(proposalId);
        assertTrue(proposal.executed, "passed vote minted");
        assertEq(NUSD.balanceOf(address(STAKING)) - poolBefore, proposal.mintedNusd / 2, "pool half");
        assertEq(NUSD.balanceOf(TREASURY) - treasuryBefore, proposal.mintedNusd - proposal.mintedNusd / 2, "treasury half");
        uint256 reserve = NUSD.reserveValueNusd();
        assertGe(reserve, 2 * NUSD.totalSupply(), "below 2x");
        assertLe(reserve, 2 * NUSD.totalSupply() + 2, "not minted down to 2x");

        vm.prank(voters[3]);
        GOVERNOR.withdraw(proposalId);
        assertGe(NUSD.balanceOf(voters[3]), 100 ether, "lock returned");
    }

    function _eoaToken(address collection) private view returns (uint256 tokenId, address holder) {
        for (uint256 id = 1; id <= 400; id++) {
            try IERC721(collection).ownerOf(id) returns (address owner) {
                if (owner.code.length == 0 && MARKET.tokenToListingId(collection, id) == 0) return (id, owner);
            } catch {}
        }
        revert("no EOA-held token found");
    }
}
