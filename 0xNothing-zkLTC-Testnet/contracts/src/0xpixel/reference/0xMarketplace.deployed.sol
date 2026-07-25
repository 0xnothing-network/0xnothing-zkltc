// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/interfaces/IERC2981.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IOwnable {
    function owner() external view returns (address);
}

contract ZeroxMarketplace is ReentrancyGuard, Ownable, Pausable {
    address payable public immutable devWallet;
    uint256 public constant PLATFORM_FEE_BPS = 40;
    uint256 public constant MAX_PRICE = 1000 ether;

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
        bool active;
    }

    mapping(address => string) public collectionNames;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Offer) public offers;

    uint256 private _listingIdCounter;
    uint256 private _offerIdCounter;

    mapping(address => mapping(uint256 => uint256)) public tokenToListingId;

    event Listed(uint256 indexed listingId, address indexed collection, uint256 tokenId, address seller, uint256 price);
    event ListingCancelled(uint256 indexed listingId);
    event OfferCreated(uint256 indexed offerId, address indexed collection, uint256 tokenId, address offerer, uint256 price);
    event OfferCancelled(uint256 indexed offerId);
    event OfferAccepted(uint256 indexed offerId, address buyer);
    event Bought(uint256 indexed listingId, address buyer, uint256 price);
    event CollectionNameUpdated(address indexed collection, string name);
    event ListingInvalidated(uint256 indexed listingId);

    constructor(address payable _devWallet) Ownable(msg.sender) {
        require(_devWallet != address(0), "Invalid dev wallet");
        devWallet = _devWallet;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setCollectionName(address collection, string calldata name) external whenNotPaused {
        require(collection != address(0) && collection.code.length > 0, "Invalid collection");
        require(bytes(name).length <= 64, "Name too long");

        try IOwnable(collection).owner() returns (address collectionOwner) {
            require(msg.sender == collectionOwner, "Only collection owner");
        } catch {
            require(bytes(collectionNames[collection]).length == 0, "Name already set");
        }

        collectionNames[collection] = name;
        emit CollectionNameUpdated(collection, name);
    }

    function list(address collection, uint256 tokenId, uint256 price) 
        external 
        nonReentrant 
        whenNotPaused 
    {
        require(collection != address(0) && collection.code.length > 0, "Invalid collection");
        require(price > 0 && price <= MAX_PRICE, "Invalid price");

        IERC721 nft = IERC721(collection);
        require(nft.ownerOf(tokenId) == msg.sender, "Not owner");
        require(
            nft.isApprovedForAll(msg.sender, address(this)) || 
            nft.getApproved(tokenId) == address(this),
            "Not approved"
        );

        uint256 existing = tokenToListingId[collection][tokenId];
        require(existing == 0 || !listings[existing].active, "Already listed");

        _listingIdCounter++;
        uint256 listingId = _listingIdCounter;

        listings[listingId] = Listing({
            collection: collection,
            tokenId: tokenId,
            price: price,
            seller: msg.sender,
            active: true
        });

        tokenToListingId[collection][tokenId] = listingId;

        emit Listed(listingId, collection, tokenId, msg.sender, price);
    }

    function cancelListing(uint256 listingId) external nonReentrant whenNotPaused {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");
        require(
            listing.seller == msg.sender || msg.sender == owner(),
            "Not seller"
        );

        listing.active = false;
        delete tokenToListingId[listing.collection][listing.tokenId];

        emit ListingCancelled(listingId);
    }

    function buy(uint256 listingId) external payable nonReentrant whenNotPaused {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");
        require(msg.value == listing.price, "Incorrect payment");
        require(listing.seller != msg.sender, "Seller cannot buy");

        address collection = listing.collection;
        uint256 tokenId = listing.tokenId;
        uint256 price = listing.price;
        address seller = listing.seller;

        IERC721 nft = IERC721(collection);
        require(nft.ownerOf(tokenId) == seller, "Seller not owner");
        require(
            nft.isApprovedForAll(seller, address(this)) ||
            nft.getApproved(tokenId) == address(this),
            "Not approved"
        );

        listing.active = false;
        delete tokenToListingId[collection][tokenId];

        _processPurchase(collection, tokenId, seller, price, msg.sender);

        emit Bought(listingId, msg.sender, price);
    }

    function makeOffer(address collection, uint256 tokenId, uint256 price) 
        external 
        payable 
        nonReentrant 
        whenNotPaused 
    {
        require(collection != address(0) && collection.code.length > 0, "Invalid collection");
        require(price > 0 && price <= MAX_PRICE, "Invalid price");
        require(msg.value == price, "Must send exact amount");

        IERC721 nft = IERC721(collection);
        require(nft.ownerOf(tokenId) != msg.sender, "Cannot offer on own NFT");

        _offerIdCounter++;
        uint256 offerId = _offerIdCounter;

        offers[offerId] = Offer({
            collection: collection,
            tokenId: tokenId,
            offerer: msg.sender,
            price: price,
            active: true
        });

        emit OfferCreated(offerId, collection, tokenId, msg.sender, price);
    }

    function acceptOffer(uint256 offerId) external nonReentrant whenNotPaused {
        Offer storage offer = offers[offerId];
        require(offer.active, "Not active");

        address collection = offer.collection;
        uint256 tokenId = offer.tokenId;
        address buyer = offer.offerer;
        uint256 price = offer.price;

        IERC721 nft = IERC721(collection);
        require(nft.ownerOf(tokenId) == msg.sender, "Only owner can accept");
        require(
            nft.isApprovedForAll(msg.sender, address(this)) ||
            nft.getApproved(tokenId) == address(this),
            "Not approved"
        );

        offer.active = false;
        uint256 listingId = tokenToListingId[collection][tokenId];
        if (listingId != 0 && listings[listingId].active) {
            listings[listingId].active = false;
            delete tokenToListingId[collection][tokenId];
            emit ListingCancelled(listingId);
        }

        _processPurchase(collection, tokenId, msg.sender, price, buyer);

        emit OfferAccepted(offerId, buyer);
    }

    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.active, "Not active");
        require(offer.offerer == msg.sender || msg.sender == owner(), "Not offerer");

        address offerer = offer.offerer;
        uint256 price = offer.price;
        offer.active = false;
        (bool success, ) = payable(offerer).call{value: price}("");
        require(success, "Refund failed");

        emit OfferCancelled(offerId);
    }

    function _processPurchase(
        address collection,
        uint256 tokenId,
        address seller,
        uint256 price,
        address buyer
    ) internal {
        uint256 devFee = (price * PLATFORM_FEE_BPS) / 10000;
        uint256 sellerProceeds = price - devFee;
        uint256 royaltyAmountPaid = 0;
        address royaltyReceiverPaid = address(0);

        try IERC2981(collection).royaltyInfo(tokenId, price) returns (address royaltyReceiver, uint256 royaltyAmount) {
            if (
                royaltyReceiver != address(0) &&
                royaltyAmount > 0 &&
                royaltyAmount <= sellerProceeds
            ) {
                sellerProceeds -= royaltyAmount;
                royaltyAmountPaid = royaltyAmount;
                royaltyReceiverPaid = royaltyReceiver;
            }
        } catch {}

        IERC721(collection).safeTransferFrom(seller, buyer, tokenId);

        if (royaltyAmountPaid > 0) {
            (bool royaltySent, ) = payable(royaltyReceiverPaid).call{value: royaltyAmountPaid}("");
            require(royaltySent, "Royalty failed");
        }

        (bool sellerSent, ) = payable(seller).call{value: sellerProceeds}("");
        require(sellerSent, "Payment to seller failed");

        (bool devSent, ) = devWallet.call{value: devFee}("");
        require(devSent, "Dev fee failed");
    }

    function getActiveListings(uint256 offset, uint256 limit) 
        external 
        view 
        returns (uint256[] memory) 
    {
        uint256[] memory result = new uint256[](limit);
        uint256 count = 0;

        for (uint256 i = offset + 1; i <= _listingIdCounter && count < limit; i++) {
            if (listings[i].active) {
                result[count] = i;
                count++;
            }
        }

        assembly {
            mstore(result, count)
        }
        return result;
    }

    function invalidateListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Not active");

        IERC721 nft = IERC721(listing.collection);
        bool invalid = nft.ownerOf(listing.tokenId) != listing.seller ||
            (
                nft.getApproved(listing.tokenId) != address(this) &&
                !nft.isApprovedForAll(listing.seller, address(this))
            );

        require(invalid, "Listing valid");

        listing.active = false;
        delete tokenToListingId[listing.collection][listing.tokenId];

        emit ListingInvalidated(listingId);
    }

    function getListingByToken(address collection, uint256 tokenId) 
        external 
        view 
        returns (uint256, Listing memory) 
    {
        uint256 id = tokenToListingId[collection][tokenId];
        return (id, listings[id]);
    }
}
