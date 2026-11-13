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

import { IListingEpoch } from "./ListingEpochERC721.sol";

interface INusdBurnable {
    function burn(uint256 amount) external;
}

/// @title 0xPixel NUSD marketplace v2
/// @notice Same escrow/credit model as v1 with a fixed sale fee: 0.1% of the price is burned
///         (NUSD supply really shrinks) and 0.4% is credited to the artwork's creator. There is
///         no platform fee and no separate royalty.
///         A listing is bound to the ownership and approval it was created under: every allowed
///         collection reports a number that changes when a token is transferred or approved, and
///         a listing whose number has moved can no longer be bought, only removed. A token that
///         left its seller, or whose approval was withdrawn, never comes back on sale at an old
///         price.
///         An offer is a standing bid on one token, escrowed until it is accepted, cancelled or
///         expired. An account has one live offer per token (a new one replaces it), and a sale
///         through the market ends the offer its buyer or its seller still had on that token, so
///         nobody is left bidding on a token they have just held: the next owner could fill such
///         a bid against them.
contract NusdNftMarketplaceV2 is ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    struct Listing {
        address collection;
        uint256 tokenId;
        uint256 price;
        address seller;
        bool active;
        /// @dev The collection's listingEpoch for this token and this market when it was listed.
        uint256 epoch;
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
    error NonExactTransfer();
    error NothingToWithdraw();
    error InvalidPage();
    error InsufficientProceeds();
    error WalletPaymentExceeded();

    bytes32 public constant IMPLEMENTATION_ID = keccak256("0xpixel.nusd.marketplace.v2");
    uint256 public constant MAX_PRICE = type(uint128).max;
    uint256 public constant MAX_OFFER_DURATION = 30 days;
    uint256 public constant MAX_PAGE_SIZE = 100;
    uint16 public constant BURN_BPS = 10;
    uint16 public constant CREATOR_BPS = 40;

    IERC20 public immutable nusd;
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
    /// @notice The offer an account has on a token, zero if it has none. An offer keeps its slot
    ///         until it is cancelled, expired by a call, replaced, accepted or ended by a sale, so
    ///         a reader must check `expiresAt` to know whether it can still be accepted.
    mapping(address collection => mapping(uint256 tokenId => mapping(address offerer => uint256))) public offerIdOf;
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
    event SaleSettled(address indexed seller, address indexed buyer, address indexed collection, uint256 tokenId, uint256 price, uint256 burned, address creator, uint256 creatorFee);
    event NusdWithdrawn(address indexed account, address indexed recipient, uint256 amount);

    constructor(address token, address initialOwner, address[] memory collections)
        Ownable(initialOwner)
    {
        if (token.code.length == 0 || initialOwner == address(this) || collections.length == 0 || collections.length > 16
            || IERC20Metadata(token).decimals() != 18) revert InvalidConfiguration();
        nusd = IERC20(token);
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
        if (!_ownsAndApproves(collection, tokenId, msg.sender)) revert NotPurchasable();
        uint256 previousId = tokenToListingId[collection][tokenId];
        if (previousId != 0 && listings[previousId].active) {
            if (_purchasable(listings[previousId])) revert AlreadyListed();
            _removeListing(previousId);
            emit ListingInvalidated(previousId);
        }
        listingId = ++listingCount;
        listings[listingId] =
            Listing(collection, tokenId, price, msg.sender, true, IListingEpoch(collection).listingEpoch(tokenId, address(this)));
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
        if (!_purchasable(listing)) revert NotPurchasable();
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
        if (collectionAllowed[listing.collection] && _purchasable(listing)) revert NotPurchasable();
        _removeListing(listingId);
        emit ListingInvalidated(listingId);
    }

    function buy(uint256 listingId, uint256 expectedPrice, uint256 maxWalletPayment) external nonReentrant whenNotPaused {
        Listing memory listing = listings[listingId];
        if (!listing.active) revert Inactive();
        if (listing.price != expectedPrice) revert PriceChanged();
        if (listing.seller == msg.sender) revert Unauthorized();
        _requireCollection(listing.collection);
        if (!_purchasable(listing)) revert NotPurchasable();
        _removeListing(listingId);
        // The buyer's own offer on this token ends here, and its escrow pays for the purchase
        // before the wallet does.
        _refundOwnOffer(listing.collection, listing.tokenId, msg.sender);
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
        // One live offer per account and token: the old escrow becomes credit, which pays for the
        // new offer before the wallet does.
        _refundOwnOffer(collection, tokenId, msg.sender);
        _fund(msg.sender, price, maxWalletPayment);
        escrowedNusd += price;
        offerId = ++offerCount;
        offers[offerId] = Offer(collection, tokenId, msg.sender, price, expiresAt, true);
        offerIdOf[collection][tokenId][msg.sender] = offerId;
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
        if (!_ownsAndApproves(offer.collection, offer.tokenId, msg.sender)) revert NotPurchasable();
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

    /// @notice Splits a sale price into the burned amount, the creator fee and the seller's proceeds.
    /// @dev The creator is the ERC-2981 receiver, which both 0xPixel collections set to the artist.
    ///      If a collection cannot name one, the seller keeps the creator share.
    function quoteSale(address collection, uint256 tokenId, uint256 price)
        public view returns (uint256 burnAmount, address creator, uint256 creatorFee, uint256 sellerProceeds)
    {
        _requireCollection(collection);
        _requirePrice(price);
        burnAmount = price * BURN_BPS / 10_000;
        creatorFee = price * CREATOR_BPS / 10_000;
        creator = _creatorOf(collection, tokenId, price);
        sellerProceeds = price - burnAmount - creatorFee;
    }

    function _creatorOf(address collection, uint256 tokenId, uint256 price) private view returns (address) {
        if (!ERC165Checker.supportsInterface(collection, type(IERC2981).interfaceId)) return address(0);
        try IERC2981(collection).royaltyInfo(tokenId, price) returns (address receiver, uint256) {
            return receiver == address(this) ? address(0) : receiver;
        } catch {
            return address(0);
        }
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
        (uint256 burnAmount, address creator, uint256 creatorFee, uint256 sellerProceeds) = quoteSale(collection, tokenId, price);
        if (creator == address(0)) {
            sellerProceeds += creatorFee;
            creator = seller;
            creatorFee = 0;
        }
        if (sellerProceeds < minimumSellerProceeds) revert InsufficientProceeds();
        credits[seller] += sellerProceeds;
        if (creatorFee != 0) credits[creator] += creatorFee;
        totalCreditsNusd += sellerProceeds + creatorFee;
        totalVolumeNusd += price;
        ++totalSales;
        // An offer the seller made before the token was theirs ends with the sale. Left standing,
        // the buyer could put the token straight back to them at that old price.
        _refundOwnOffer(collection, tokenId, seller);
        // The sale price is already held here (wallet payment, buyer credit or offer escrow).
        if (burnAmount != 0) INusdBurnable(address(nusd)).burn(burnAmount);
        IERC721(collection).safeTransferFrom(seller, buyer, tokenId);
        emit SaleSettled(seller, buyer, collection, tokenId, price, burnAmount, creator, creatorFee);
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

    /// @dev Turns the escrow of the offer `account` has on the token, if any, back into credit.
    function _refundOwnOffer(address collection, uint256 tokenId, address account) private {
        uint256 offerId = offerIdOf[collection][tokenId][account];
        if (offerId != 0) _refundOffer(offerId);
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
        Offer storage offer = offers[offerId];
        offer.active = false;
        // Every way an offer ends comes through here, so the slot is taken exactly while it lives.
        delete offerIdOf[offer.collection][offer.tokenId][offer.offerer];
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
        if (
            collection.code.length == 0
                || (allowed
                    && (!ERC165Checker.supportsInterface(collection, type(IERC721).interfaceId)
                        || !ERC165Checker.supportsInterface(collection, type(IListingEpoch).interfaceId)))
        ) revert InvalidConfiguration();
        collectionAllowed[collection] = allowed;
        emit CollectionAllowed(collection, allowed);
    }

    function _requireCollection(address collection) private view {
        if (!collectionAllowed[collection]) revert CollectionNotAllowed();
    }

    function _requirePrice(uint256 price) private pure {
        if (price == 0 || price > MAX_PRICE) revert InvalidPrice();
    }

    /// @dev A listing can be bought while its seller still owns and approves the token and nothing
    ///      has happened to the token or the approval since it was listed.
    function _purchasable(Listing memory listing) private view returns (bool) {
        if (!_ownsAndApproves(listing.collection, listing.tokenId, listing.seller)) return false;
        try IListingEpoch(listing.collection).listingEpoch(listing.tokenId, address(this)) returns (uint256 epoch) {
            return epoch == listing.epoch;
        } catch {
            return false;
        }
    }

    function _ownsAndApproves(address collection, uint256 tokenId, address seller) private view returns (bool) {
        IERC721 nft = IERC721(collection);
        try nft.ownerOf(tokenId) returns (address currentOwner) {
            if (currentOwner != seller) return false;
        } catch { return false; }
        try nft.getApproved(tokenId) returns (address approved) {
            if (approved == address(this)) return true;
        } catch { return false; }
        try nft.isApprovedForAll(seller, address(this)) returns (bool approved) { return approved; }
        catch { return false; }
    }
}
