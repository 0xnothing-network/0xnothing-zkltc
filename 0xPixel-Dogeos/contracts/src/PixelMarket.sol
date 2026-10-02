// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DogeosPixel} from "./DogeosPixel.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Non-custodial fixed-price sales and escrowed DOGE offers for DOGEOSxPIXEL.
/// @dev Seller, creator and protocol earnings use pull payments. No external payout can block a sale.
contract PixelMarket is ReentrancyGuard {
    DogeosPixel public immutable nft;
    address public immutable feeRecipient;
    uint256 public constant FEE_BPS = 100;
    uint256 public constant MAX_DURATION = 365 days;
    struct Listing { address seller; uint256 price; uint64 expiry; uint256 nonce; uint256 id; }
    struct Offer { address bidder; uint256 tokenId; uint256 amount; uint64 expiry; }
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Offer) public offers;
    mapping(address => uint256) public credits;
    uint256 public listingCount;
    uint256 public offerCount;
    uint256 public totalCredits;
    uint256 public totalOfferEscrow;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 indexed listingId, uint256 price, uint64 expiry, uint256 nonce);
    event ListingCancelled(uint256 indexed tokenId, uint256 indexed listingId);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 royalty, uint256 fee, uint256 listingId);
    event OfferMade(uint256 indexed offerId, uint256 indexed tokenId, address indexed bidder, uint256 amount, uint64 expiry);
    event OfferCancelled(uint256 indexed offerId);
    event OfferAccepted(uint256 indexed offerId, uint256 indexed tokenId, address indexed seller, address buyer, uint256 amount, uint256 royalty, uint256 fee);
    event Withdrawn(address indexed account, address indexed recipient, uint256 amount);
    error Unauthorized(); error InvalidTerms(); error ApprovalRequired(); error ListingUnavailable();
    error PriceChanged(); error OfferUnavailable(); error NothingToWithdraw(); error PaymentFailed();

    constructor(DogeosPixel token, address recipient) {
        if (address(token) == address(0) || recipient == address(0)) revert InvalidTerms();
        nft = token; feeRecipient = recipient;
    }

    function _approved(uint256 tokenId, address owner) private view returns (bool) {
        return nft.getApproved(tokenId) == address(this) || nft.isApprovedForAll(owner, address(this));
    }
    function _terms(uint256 amount, uint64 expiry) private view {
        if (amount == 0 || expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert InvalidTerms();
    }
    function list(uint256 tokenId, uint256 price, uint64 expiry) external nonReentrant {
        if (nft.ownerOf(tokenId) != msg.sender) revert Unauthorized();
        if (!_approved(tokenId, msg.sender)) revert ApprovalRequired();
        _terms(price, expiry);
        uint256 id = ++listingCount;
        uint256 nonce = nft.ownershipNonce(tokenId);
        listings[tokenId] = Listing(msg.sender, price, expiry, nonce, id);
        emit Listed(tokenId, msg.sender, id, price, expiry, nonce);
    }
    function cancelListing(uint256 tokenId) external nonReentrant {
        Listing memory item = listings[tokenId];
        if (item.seller != msg.sender) revert Unauthorized();
        delete listings[tokenId];
        emit ListingCancelled(tokenId, item.id);
    }
    function isListingActive(uint256 tokenId) public view returns (bool) {
        Listing memory item = listings[tokenId];
        return item.seller != address(0) && item.expiry > block.timestamp &&
            item.nonce == nft.ownershipNonce(tokenId) && nft.ownerOf(tokenId) == item.seller && _approved(tokenId, item.seller);
    }
    function buy(uint256 tokenId, uint256 expectedListingId) external payable nonReentrant {
        Listing memory item = listings[tokenId];
        if (!isListingActive(tokenId) || item.seller == msg.sender) revert ListingUnavailable();
        if (item.id != expectedListingId || msg.value != item.price) revert PriceChanged();
        delete listings[tokenId];
        (uint256 royalty, uint256 fee) = _settle(tokenId, item.seller, msg.value);
        nft.safeTransferFrom(item.seller, msg.sender, tokenId);
        emit Sold(tokenId, item.seller, msg.sender, msg.value, royalty, fee, item.id);
    }
    function makeOffer(uint256 tokenId, uint64 expiry) external payable nonReentrant returns (uint256 id) {
        if (nft.ownerOf(tokenId) == msg.sender) revert InvalidTerms();
        _terms(msg.value, expiry);
        id = ++offerCount;
        offers[id] = Offer(msg.sender, tokenId, msg.value, expiry);
        totalOfferEscrow += msg.value;
        emit OfferMade(id, tokenId, msg.sender, msg.value, expiry);
    }
    /// @notice A bidder may cancel at any time, including after expiry. Funds become withdrawable.
    function cancelOffer(uint256 id) external nonReentrant {
        Offer memory item = offers[id];
        if (item.bidder != msg.sender) revert Unauthorized();
        delete offers[id];
        totalOfferEscrow -= item.amount;
        _credit(msg.sender, item.amount);
        emit OfferCancelled(id);
    }
    function acceptOffer(uint256 id) external nonReentrant {
        Offer memory item = offers[id];
        if (item.amount == 0 || item.expiry <= block.timestamp) revert OfferUnavailable();
        if (nft.ownerOf(item.tokenId) != msg.sender || item.bidder == msg.sender) revert Unauthorized();
        if (!_approved(item.tokenId, msg.sender)) revert ApprovalRequired();
        delete offers[id];
        totalOfferEscrow -= item.amount;
        Listing memory listing = listings[item.tokenId];
        if (listing.id != 0) { delete listings[item.tokenId]; emit ListingCancelled(item.tokenId, listing.id); }
        (uint256 royalty, uint256 fee) = _settle(item.tokenId, msg.sender, item.amount);
        nft.safeTransferFrom(msg.sender, item.bidder, item.tokenId);
        emit OfferAccepted(id, item.tokenId, msg.sender, item.bidder, item.amount, royalty, fee);
    }
    function _settle(uint256 tokenId, address seller, uint256 amount) private returns (uint256 royalty, uint256 fee) {
        (address creator, uint256 creatorAmount) = nft.royaltyInfo(tokenId, amount);
        royalty = creatorAmount; fee = amount / 100;
        _credit(creator, royalty); _credit(feeRecipient, fee); _credit(seller, amount - royalty - fee);
    }
    function _credit(address account, uint256 amount) private { credits[account] += amount; totalCredits += amount; }
    function withdraw(address payable recipient) external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        if (recipient == address(0)) revert InvalidTerms();
        credits[msg.sender] = 0; totalCredits -= amount;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert PaymentFailed();
        emit Withdrawn(msg.sender, recipient, amount);
    }
}
