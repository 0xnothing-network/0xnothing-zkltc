// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { ERC165Checker } from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

contract NusdNftMarketplace is ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    struct Listing {
        address collection;
        uint256 tokenId;
        uint256 price;
        address seller;
        bool active;
    }

    struct Offer {
        address collection;
        uint256 tokenId;
        address offerer;
        uint256 price;
        uint64 expiresAt;
        bool active;
    }

    error InvalidConfiguration();
    error CollectionNotAllowed();
    error InvalidPrice();
    error InvalidExpiry();
    error Inactive();
    error Unauthorized();
    error NotPurchasable();
    error AlreadyListed();
    error PriceChanged();
    error InvalidRoyalty();
    error NonExactTransfer();
    error NothingToWithdraw();
    error InvalidPage();
    error InsufficientProceeds();
    error WalletPaymentExceeded();

    bytes32 public constant IMPLEMENTATION_ID = keccak256("0xpixel.nusd.marketplace.v2");
    uint256 public constant MAX_PRICE = type(uint128).max;
    uint256 public constant MAX_OFFER_DURATION = 30 days;
    uint256 public constant MAX_PAGE_SIZE = 100;
    uint16 public constant MAX_FEE_BPS = 500;
    /// @dev Bounds what a collection can take from a seller who is not present when a listing is bought.
    uint16 public constant MAX_ROYALTY_BPS = 1_000;

    IERC20 public immutable nusd;
    address public immutable feeRecipient;
    uint16 public immutable platformFeeBps;
    uint256 public listingCount;
    uint256 public offerCount;
    uint256 public escrowedNusd;
    uint256 public totalCreditsNusd;
    uint256 public totalVolumeNusd;
    uint256 public totalSales;
    mapping(address => bool) public collectionAllowed;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Offer) public offers;
    mapping(address => uint256) public credits;
    mapping(address => mapping(uint256 => uint256)) public tokenToListingId;
    uint256[] private _activeListings;
    uint256[] private _activeOffers;
    mapping(uint256 => uint256) private _listingIndex;
    mapping(uint256 => uint256) private _offerIndex;

    event CollectionAllowed(address indexed collection, bool allowed);
    event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 price);
    event ListingCancelled(uint256 indexed listingId);
    event ListingInvalidated(uint256 indexed listingId);
    event ListingPriceUpdated(uint256 indexed listingId, uint256 price);
    event Bought(uint256 indexed listingId, address indexed buyer, uint256 price);
    event OfferCreated(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address offerer, uint256 price, uint64 expiresAt);
    event OfferCancelled(uint256 indexed offerId, address indexed offerer, uint256 refund);
    event OfferAccepted(uint256 indexed offerId, address indexed seller, address indexed buyer, uint256 price);
    event SaleSettled(address indexed seller, address indexed buyer, address indexed collection, uint256 tokenId, uint256 price, uint256 fee, address royaltyReceiver, uint256 royalty);
    event NusdWithdrawn(address indexed account, address indexed recipient, uint256 amount);

    constructor(address token, address initialOwner, address treasury, uint16 feeBps, address[] memory collections)
        Ownable(initialOwner)
    {
        if (token.code.length == 0 || treasury == address(0) || treasury == address(this)
            || initialOwner == address(this) || feeBps > MAX_FEE_BPS || collections.length == 0 || collections.length > 16
            || IERC20Metadata(token).decimals() != 18) revert InvalidConfiguration();
        nusd = IERC20(token);
        feeRecipient = treasury;
        platformFeeBps = feeBps;
        for (uint256 index; index < collections.length; ++index) _allowCollection(collections[index], true);
    }

    function setCollectionAllowed(address collection, bool allowed) external onlyOwner {
        _allowCollection(collection, allowed);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function list(address collection, uint256 tokenId, uint256 price) external nonReentrant whenNotPaused returns (uint256 listingId) {
        _requireCollection(collection);
        _requirePrice(price);
        if (!_isListable(collection, tokenId, msg.sender)) revert NotPurchasable();
        uint256 previousId = tokenToListingId[collection][tokenId];
        if (previousId != 0 && listings[previousId].active) {
            Listing memory previous = listings[previousId];
            if (_isListable(collection, tokenId, previous.seller)) revert AlreadyListed();
            _removeListing(previousId);
            emit ListingInvalidated(previousId);
        }
        listingId = ++listingCount;
        listings[listingId] = Listing(collection, tokenId, price, msg.sender, true);
        tokenToListingId[collection][tokenId] = listingId;
        _listingIndex[listingId] = _activeListings.length;
        _activeListings.push(listingId);
        emit Listed(listingId, collection, tokenId, msg.sender, price);
    }

    function updateListingPrice(uint256 listingId, uint256 price) external nonReentrant whenNotPaused {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert Inactive();
        if (listing.seller != msg.sender) revert Unauthorized();
        _requireCollection(listing.collection);
        _requirePrice(price);
        if (!_isListable(listing.collection, listing.tokenId, listing.seller)) revert NotPurchasable();
        listing.price = price;
        emit ListingPriceUpdated(listingId, price);
    }

    function cancelListing(uint256 listingId) external nonReentrant {
        if (!listings[listingId].active) revert Inactive();
        if (listings[listingId].seller != msg.sender) revert Unauthorized();
        _removeListing(listingId);
        emit ListingCancelled(listingId);
    }

    function invalidateListing(uint256 listingId) external nonReentrant {
        Listing memory listing = listings[listingId];
        if (!listing.active) revert Inactive();
        if (collectionAllowed[listing.collection] && _isListable(listing.collection, listing.tokenId, listing.seller)) revert NotPurchasable();
        _removeListing(listingId);
        emit ListingInvalidated(listingId);
    }

    function buy(uint256 listingId, uint256 expectedPrice, uint256 maxWalletPayment) external nonReentrant whenNotPaused {
        Listing memory listing = listings[listingId];
        if (!listing.active) revert Inactive();
        if (listing.price != expectedPrice) revert PriceChanged();
        if (listing.seller == msg.sender) revert Unauthorized();
        _requireCollection(listing.collection);
        if (!_isListable(listing.collection, listing.tokenId, listing.seller)) revert NotPurchasable();
        _removeListing(listingId);
        _fund(msg.sender, listing.price, maxWalletPayment);
        _settle(listing.collection, listing.tokenId, listing.seller, msg.sender, listing.price, 0);
        emit Bought(listingId, msg.sender, listing.price);
    }

    function makeOffer(address collection, uint256 tokenId, uint256 price, uint64 expiresAt, uint256 maxWalletPayment)
        external nonReentrant whenNotPaused returns (uint256 offerId)
    {
        _requireCollection(collection);
        _requirePrice(price);
        if (expiresAt <= block.timestamp || uint256(expiresAt) > block.timestamp + MAX_OFFER_DURATION) revert InvalidExpiry();
        if (IERC721(collection).ownerOf(tokenId) == msg.sender) revert Unauthorized();
        _fund(msg.sender, price, maxWalletPayment);
        escrowedNusd += price;
        offerId = ++offerCount;
        offers[offerId] = Offer(collection, tokenId, msg.sender, price, expiresAt, true);
        _offerIndex[offerId] = _activeOffers.length;
        _activeOffers.push(offerId);
        emit OfferCreated(offerId, collection, tokenId, msg.sender, price, expiresAt);
    }

    function acceptOffer(uint256 offerId, uint256 minimumSellerProceeds) external nonReentrant whenNotPaused {
        Offer memory offer = offers[offerId];
        if (!offer.active) revert Inactive();
        if (block.timestamp >= offer.expiresAt) revert InvalidExpiry();
        if (offer.offerer == msg.sender) revert Unauthorized();
        _requireCollection(offer.collection);
        if (!_ownsAndApproves(offer.collection, offer.tokenId, msg.sender, true)) revert NotPurchasable();
        _removeOffer(offerId);
        escrowedNusd -= offer.price;
        uint256 listingId = tokenToListingId[offer.collection][offer.tokenId];
        if (listingId != 0) {
            _removeListing(listingId);
            emit ListingCancelled(listingId);
        }
        _settle(offer.collection, offer.tokenId, msg.sender, offer.offerer, offer.price, minimumSellerProceeds);
        emit OfferAccepted(offerId, msg.sender, offer.offerer, offer.price);
    }

    function cancelOffer(uint256 offerId) external nonReentrant {
        if (offers[offerId].offerer != msg.sender) revert Unauthorized();
        _refundOffer(offerId);
    }

    function expireOffer(uint256 offerId) external nonReentrant {
        if (block.timestamp < offers[offerId].expiresAt) revert InvalidExpiry();
        _refundOffer(offerId);
    }

    function withdrawNusd(address recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidConfiguration();
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        totalCreditsNusd -= amount;
        uint256 beforeBalance = nusd.balanceOf(recipient);
        nusd.safeTransfer(recipient, amount);
        if (nusd.balanceOf(recipient) != beforeBalance + amount) revert NonExactTransfer();
        emit NusdWithdrawn(msg.sender, recipient, amount);
    }

    function quoteSale(address collection, uint256 tokenId, uint256 price)
        public view returns (uint256 fee, address royaltyReceiver, uint256 royalty, uint256 sellerProceeds)
    {
        _requireCollection(collection);
        _requirePrice(price);
        fee = price * platformFeeBps / 10_000;
        if (ERC165Checker.supportsInterface(collection, type(IERC2981).interfaceId)) {
            (royaltyReceiver, royalty) = IERC2981(collection).royaltyInfo(tokenId, price);
            if (royalty > price * MAX_ROYALTY_BPS / 10_000 || (royalty != 0 && (royaltyReceiver == address(0) || royaltyReceiver == address(this)))) revert InvalidRoyalty();
        }
        sellerProceeds = price - fee - royalty;
    }

    function totalLiabilitiesNusd() external view returns (uint256) { return escrowedNusd + totalCreditsNusd; }
    function activeListingCount() external view returns (uint256) { return _activeListings.length; }
    function activeOfferCount() external view returns (uint256) { return _activeOffers.length; }

    function getActiveListings(uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_activeListings, offset, limit);
    }

    function getActiveOffers(uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_activeOffers, offset, limit);
    }

    function _settle(address collection, uint256 tokenId, address seller, address buyer, uint256 price, uint256 minimumSellerProceeds) private {
        (uint256 fee, address royaltyReceiver, uint256 royalty, uint256 sellerProceeds) = quoteSale(collection, tokenId, price);
        if (sellerProceeds < minimumSellerProceeds) revert InsufficientProceeds();
        credits[seller] += sellerProceeds;
        credits[feeRecipient] += fee;
        if (royalty != 0) credits[royaltyReceiver] += royalty;
        totalCreditsNusd += price;
        totalVolumeNusd += price;
        ++totalSales;
        IERC721(collection).safeTransferFrom(seller, buyer, tokenId);
        emit SaleSettled(seller, buyer, collection, tokenId, price, fee, royaltyReceiver, royalty);
    }

    function _collect(address account, uint256 amount) private {
        uint256 beforeBalance = nusd.balanceOf(address(this));
        nusd.safeTransferFrom(account, address(this), amount);
        if (nusd.balanceOf(address(this)) != beforeBalance + amount) revert NonExactTransfer();
    }

    function _fund(address account, uint256 amount, uint256 maxWalletPayment) private {
        uint256 creditUsed = credits[account] < amount ? credits[account] : amount;
        uint256 walletPayment = amount - creditUsed;
        if (walletPayment > maxWalletPayment) revert WalletPaymentExceeded();
        if (creditUsed != 0) {
            credits[account] -= creditUsed;
            totalCreditsNusd -= creditUsed;
        }
        if (walletPayment != 0) _collect(account, walletPayment);
    }

    function _refundOffer(uint256 offerId) private {
        Offer memory offer = offers[offerId];
        if (!offer.active) revert Inactive();
        _removeOffer(offerId);
        escrowedNusd -= offer.price;
        credits[offer.offerer] += offer.price;
        totalCreditsNusd += offer.price;
        emit OfferCancelled(offerId, offer.offerer, offer.price);
    }

    function _removeListing(uint256 listingId) private {
        Listing storage listing = listings[listingId];
        listing.active = false;
        delete tokenToListingId[listing.collection][listing.tokenId];
        uint256 index = _listingIndex[listingId];
        uint256 lastId = _activeListings[_activeListings.length - 1];
        _activeListings[index] = lastId;
        _listingIndex[lastId] = index;
        _activeListings.pop();
        delete _listingIndex[listingId];
    }

    function _removeOffer(uint256 offerId) private {
        offers[offerId].active = false;
        uint256 index = _offerIndex[offerId];
        uint256 lastId = _activeOffers[_activeOffers.length - 1];
        _activeOffers[index] = lastId;
        _offerIndex[lastId] = index;
        _activeOffers.pop();
        delete _offerIndex[offerId];
    }

    function _page(uint256[] storage ids, uint256 offset, uint256 limit) private view returns (uint256[] memory page) {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPage();
        if (offset >= ids.length) return new uint256[](0);
        uint256 length = ids.length - offset;
        if (length > limit) length = limit;
        page = new uint256[](length);
        for (uint256 index; index < length; ++index) page[index] = ids[offset + index];
    }

    function _allowCollection(address collection, bool allowed) private {
        if (collection.code.length == 0 || (allowed && !ERC165Checker.supportsInterface(collection, type(IERC721).interfaceId))) revert InvalidConfiguration();
        collectionAllowed[collection] = allowed;
        emit CollectionAllowed(collection, allowed);
    }

    function _requireCollection(address collection) private view {
        if (!collectionAllowed[collection]) revert CollectionNotAllowed();
    }

    function _requirePrice(uint256 price) private pure {
        if (price == 0 || price > MAX_PRICE) revert InvalidPrice();
    }

    /// @dev Listings ignore operator approvals. ERC-721 clears a token approval on every transfer, so a
    /// listing cannot become purchasable again at its old price when the NFT later returns to the seller.
    function _isListable(address collection, uint256 tokenId, address seller) private view returns (bool) {
        return _ownsAndApproves(collection, tokenId, seller, false);
    }

    function _ownsAndApproves(address collection, uint256 tokenId, address seller, bool allowOperator) private view returns (bool) {
        IERC721 nft = IERC721(collection);
        try nft.ownerOf(tokenId) returns (address currentOwner) {
            if (currentOwner != seller) return false;
        } catch { return false; }
        try nft.getApproved(tokenId) returns (address approved) {
            if (approved == address(this)) return true;
        } catch { return false; }
        if (!allowOperator) return false;
        try nft.isApprovedForAll(seller, address(this)) returns (bool approved) { return approved; }
        catch { return false; }
    }
}
