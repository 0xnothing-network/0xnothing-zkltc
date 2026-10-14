pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { PixelERC721 } from "../../src/0xpixel/PixelERC721.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { NusdNftMarketplace } from "../../src/0xpixel/NusdNftMarketplace.sol";

contract MarketplaceNusdMock is ERC20 {
    bool public taxed;
    bool public rejectTransfer;

    constructor() ERC20("NUSD", "NUSD") {}
    function mint(address account, uint256 amount) external { _mint(account, amount); }
    function setTaxed(bool value) external { taxed = value; }
    function setRejectTransfer(bool value) external { rejectTransfer = value; }

    function _update(address from, address to, uint256 value) internal override {
        require(!rejectTransfer, "TRANSFER_REJECTED");
        if (taxed && from != address(0) && to != address(0) && value > 1) {
            super._update(from, address(0), 1);
            super._update(from, to, value - 1);
        } else super._update(from, to, value);
    }
}

contract MarketplaceNftBuyerMock is IERC721Receiver {
    NusdNftMarketplace private immutable market;
    bool public rejectNft;
    bool public reentryBlocked;

    constructor(NusdNftMarketplace marketplace) { market = marketplace; }
    function setRejectNft(bool value) external { rejectNft = value; }
    function buy(MarketplaceNusdMock token, uint256 listingId, uint256 price) external {
        token.approve(address(market), price);
        market.buy(listingId, price, price);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        require(!rejectNft, "NFT_REJECTED");
        try market.withdrawNusd(address(this)) { revert("REENTRY_SUCCEEDED"); }
        catch (bytes memory reason) {
            require(bytes4(reason) == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "WRONG_REENTRY_ERROR");
            reentryBlocked = true;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract MarketplaceNftMock is PixelERC721 {
    address public royaltyReceiver;
    uint256 public royaltyBps;
    bool public royalties = true;
    bool public brokenRoyalty;

    constructor(address creator) PixelERC721("Marketplace NFT", "MNFT") { royaltyReceiver = creator; }
    function mint(address recipient, uint256 tokenId) external { _mint(recipient, tokenId); }
    function setRoyalty(address recipient, uint256 bps) external { royaltyReceiver = recipient; royaltyBps = bps; }
    function setRoyalties(bool enabled, bool broken) external { royalties = enabled; brokenRoyalty = broken; }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return royalties && interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }

    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        require(!brokenRoyalty, "BROKEN_ROYALTY");
        return (royaltyReceiver, price * royaltyBps / 10_000);
    }
}

/// @dev NUSD v2 exposes `burn`; the v2 marketplace burns its 0.1% share through it.
contract MarketplaceBurnableNusdMock is MarketplaceNusdMock {
    function burn(uint256 amount) external { _burn(msg.sender, amount); }
}
