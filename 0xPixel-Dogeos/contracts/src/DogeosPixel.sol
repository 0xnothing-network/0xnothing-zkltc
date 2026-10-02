// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PixelERC721} from "./PixelERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {PixelBase64} from "./PixelBase64.sol";
import {PixelData} from "./PixelData.sol";
import {PixelRenderer} from "./PixelRenderer.sol";

/// @notice Free, immutable, fully on-chain pixel art NFTs with bounded 256x256 canvases.
/// @dev A run is [x, y, countMinusOne, red, green, blue]. Unpainted cells are transparent.
contract DogeosPixel is PixelERC721, IERC2981 {
    uint256 public constant VERSION = 2;
    uint256 public constant MAX_GRID = 256;
    uint256 public constant MAX_NAME_LENGTH = 64;
    uint256 public constant MAX_DESCRIPTION_LENGTH = 1024;
    uint256 public constant MAX_RUNS = 4096;
    uint256 public constant MAX_RECTS = MAX_RUNS;
    uint256 public constant MAX_PACKED_DATA_LENGTH = MAX_RECTS * 6;
    uint256 public constant MAX_PIXEL_DATA_LENGTH = 2 + (MAX_RECTS + MAX_GRID) * 12;
    uint96 public constant CREATOR_ROYALTY_BPS = 100;

    error InvalidName();
    error InvalidDescription();
    error InvalidUTF8();
    error InvalidGrid();
    error InvalidPixels();
    error PixelOutOfBounds();
    error NonCanonicalPixels();
    error ArtworkAlreadyExists();
    error ReentrantCall();

    struct PixelArt {
        string name;
        string description;
        address creator;
        uint64 mintedAt;
        uint16 gridSize;
        uint16 dataLength;
        address first;
        address second;
        bytes32 artworkHash;
    }

    uint256 public totalSupply;
    uint256 private _lock = 1;
    mapping(uint256 => PixelArt) private _art;
    mapping(bytes32 => uint256) public artworkRegistry;
    mapping(address => uint256[]) public userTokens;
    mapping(uint256 => uint256) public userTokenIndex;
    mapping(uint256 => uint256) public ownershipNonce;
    struct Collection { address owner; string name; string description; uint64 createdAt; }
    uint256 public collectionCount;
    mapping(uint256 => Collection) public collections;
    mapping(uint256 => uint256) public tokenCollection;
    event CollectionCreated(uint256 indexed collectionId, address indexed owner, string name, string description);
    event CollectionUpdated(uint256 indexed collectionId, string name, string description);
    event TokenCollectionChanged(uint256 indexed tokenId, uint256 indexed previousCollection, uint256 indexed collectionId);
    error NotTokenOwner();
    error NotCollectionOwner();
    error MustOwnPixel();

    event Minted(address indexed creator, uint256 indexed tokenId, string name);
    event ArtworkRegistered(bytes32 indexed artworkHash, uint256 indexed tokenId, uint256 gridSize);

    modifier nonReentrant() {
        if (_lock != 1) revert ReentrantCall();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() PixelERC721("DOGEOSxPIXEL", "DXP") {}

    function createCollection(string calldata title, string calldata description) external returns (uint256 id) {
        if (balanceOf(msg.sender) == 0) revert MustOwnPixel();
        _validateCollection(title, description);
        id = ++collectionCount;
        collections[id] = Collection(msg.sender, title, description, uint64(block.timestamp));
        emit CollectionCreated(id, msg.sender, title, description);
    }

    function updateCollection(uint256 id, string calldata title, string calldata description) external {
        if (collections[id].owner != msg.sender) revert NotCollectionOwner();
        _validateCollection(title, description);
        collections[id].name = title;
        collections[id].description = description;
        emit CollectionUpdated(id, title, description);
    }

    function setTokenCollection(uint256 id, uint256 collectionId) external {
        if (ownerOf(id) != msg.sender) revert NotTokenOwner();
        if (collectionId != 0 && collections[collectionId].owner != msg.sender) revert NotCollectionOwner();
        uint256 previous = tokenCollection[id];
        tokenCollection[id] = collectionId;
        emit TokenCollectionChanged(id, previous, collectionId);
    }

    function _validateCollection(string calldata title, string calldata description) private pure {
        if (bytes(title).length == 0 || bytes(title).length > MAX_NAME_LENGTH) revert InvalidName();
        if (bytes(description).length > MAX_DESCRIPTION_LENGTH) revert InvalidDescription();
        _validateUTF8(bytes(title));
        _validateUTF8(bytes(description));
    }

    function mintPacked(string calldata artName, string calldata description, uint256 grid, bytes calldata pixels)
        external nonReentrant returns (uint256 id)
    {
        if (bytes(artName).length == 0 || bytes(artName).length > MAX_NAME_LENGTH) revert InvalidName();
        if (bytes(description).length > MAX_DESCRIPTION_LENGTH) revert InvalidDescription();
        _validateUTF8(bytes(artName));
        _validateUTF8(bytes(description));
        _validatePixels(pixels, grid);
        bytes32 artworkHash = _hash(pixels, grid);
        if (artworkRegistry[artworkHash] != 0) revert ArtworkAlreadyExists();
        (address first, address second) = PixelData.write(pixels);
        id = ++totalSupply;
        artworkRegistry[artworkHash] = id;
        _art[id] = PixelArt({
            name: artName,
            description: description,
            creator: msg.sender,
            mintedAt: uint64(block.timestamp),
            gridSize: uint16(grid),
            dataLength: uint16(pixels.length),
            first: first,
            second: second,
            artworkHash: artworkHash
        });
        _safeMint(msg.sender, id);
        emit Minted(msg.sender, id, artName);
        emit ArtworkRegistered(artworkHash, id, grid);
    }

    function tokenData(uint256 id) external view returns (
        string memory artName, uint256 gridSize, string memory pixelData,
        address creator, uint256 mintedAt, bytes32 artworkHash
    ) {
        _requireOwned(id);
        PixelArt storage art = _art[id];
        return (art.name, art.gridSize, PixelRenderer.legacyHex(_pixels(art)), art.creator, art.mintedAt, art.artworkHash);
    }

    function tokenPackedData(uint256 id) external view returns (
        string memory artName, string memory description, uint256 gridSize, bytes memory pixelData,
        address creator, uint256 mintedAt, bytes32 artworkHash
    ) {
        _requireOwned(id);
        PixelArt storage art = _art[id];
        return (art.name, art.description, art.gridSize, _pixels(art), art.creator, art.mintedAt, art.artworkHash);
    }

    function checkOriginalPacked(bytes calldata pixels, uint256 grid) external view returns (bool) {
        _validatePixels(pixels, grid);
        return artworkRegistry[_hash(pixels, grid)] == 0;
    }

    function getCreatorPacked(bytes calldata pixels, uint256 grid) external view returns (address) {
        _validatePixels(pixels, grid);
        return _art[artworkRegistry[_hash(pixels, grid)]].creator;
    }

    function transferNFT(address to, uint256 id) external {
        safeTransferFrom(msg.sender, to, id);
    }

    function tokensOfOwner(address owner) external view returns (uint256[] memory) {
        return userTokens[owner];
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        PixelArt storage art = _art[id];
        string memory image = PixelBase64.encode(bytes(PixelRenderer.svg(_pixels(art), art.gridSize)));
        bytes memory json = abi.encodePacked(
            '{"name":"', PixelRenderer.escapeJSON(art.name),
            '","description":"', PixelRenderer.escapeJSON(art.description),
            '","image":"data:image/svg+xml;base64,', image,
            '","attributes":[{"trait_type":"Grid Size","value":', PixelRenderer.toString(art.gridSize),
            '},{"trait_type":"Creator","value":"', PixelRenderer.toHex(uint160(art.creator), 20),
            '"},{"trait_type":"Minted At","value":', PixelRenderer.toString(art.mintedAt),
            '},{"trait_type":"Run Count","value":', PixelRenderer.toString(art.dataLength / 6),
            '},{"trait_type":"Encoding Version","value":2}],"artwork_hash":"',
            PixelRenderer.toHex(uint256(art.artworkHash), 32), '"}'
        );
        return string(abi.encodePacked("data:application/json;base64,", PixelBase64.encode(json)));
    }

    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 amount) {
        _requireOwned(tokenId);
        // Divide first to avoid overflowing for arbitrarily large salePrice values.
        return (_art[tokenId].creator, salePrice / 100);
    }

    function supportsInterface(bytes4 interfaceId) public view override(PixelERC721, IERC165) returns (bool) {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 id, address auth) internal override returns (address from) {
        from = super._update(to, id, auth);
        if (from == to) return from;
        ++ownershipNonce[id];
        if (from != address(0)) {
            uint256 index = userTokenIndex[id];
            uint256[] storage owned = userTokens[from];
            uint256 last = owned[owned.length - 1];
            if (last != id) {
                owned[index] = last;
                userTokenIndex[last] = index;
            }
            owned.pop();
            delete userTokenIndex[id];
        }
        if (to != address(0)) {
            userTokenIndex[id] = userTokens[to].length;
            userTokens[to].push(id);
        }
    }

    function _pixels(PixelArt storage art) private view returns (bytes memory) {
        return PixelData.read(art.first, art.second, art.dataLength);
    }

    function _hash(bytes calldata pixels, uint256 grid) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint16(grid), pixels));
    }

    function _validatePixels(bytes calldata pixels, uint256 grid) private pure {
        if (grid != 8 && grid != 16 && grid != 32 && grid != 64 && grid != 128 && grid != 256) revert InvalidGrid();
        if (pixels.length == 0 || pixels.length > MAX_PACKED_DATA_LENGTH || pixels.length % 6 != 0) {
            revert InvalidPixels();
        }
        uint256 previousY;
        uint256 previousEnd;
        uint256 previousColor;
        for (uint256 i; i < pixels.length; i += 6) {
            uint256 x;
            uint256 y;
            uint256 count;
            uint256 color;
            // Payload length was checked above. One calldata load decodes the
            // six-byte run without allocating/copying slices for each color.
            assembly ("memory-safe") {
                let run := calldataload(add(pixels.offset, i))
                x := byte(0, run)
                y := byte(1, run)
                count := add(byte(2, run), 1)
                color := and(shr(208, run), 0xffffff)
            }
            uint256 end = x + count;
            if (x >= grid || y >= grid || end > grid) revert PixelOutOfBounds();
            if (i != 0 && (y < previousY || (y == previousY &&
                (x < previousEnd || (x == previousEnd && color == previousColor))))) {
                revert NonCanonicalPixels();
            }
            previousY = y;
            previousEnd = end;
            previousColor = color;
        }
    }

    function _validateUTF8(bytes calldata text) private pure {
        for (uint256 i; i < text.length;) {
            uint8 head = uint8(text[i]);
            if (head < 0x80) { ++i; continue; }
            uint256 continuation;
            uint8 secondMin = 0x80;
            uint8 secondMax = 0xbf;
            if (head >= 0xc2 && head <= 0xdf) continuation = 1;
            else if (head >= 0xe0 && head <= 0xef) {
                continuation = 2;
                if (head == 0xe0) secondMin = 0xa0;
                if (head == 0xed) secondMax = 0x9f;
            } else if (head >= 0xf0 && head <= 0xf4) {
                continuation = 3;
                if (head == 0xf0) secondMin = 0x90;
                if (head == 0xf4) secondMax = 0x8f;
            } else revert InvalidUTF8();
            if (i + continuation >= text.length) revert InvalidUTF8();
            uint8 second = uint8(text[i + 1]);
            if (second < secondMin || second > secondMax) revert InvalidUTF8();
            for (uint256 j = 2; j <= continuation; ++j) {
                uint8 next = uint8(text[i + j]);
                if (next < 0x80 || next > 0xbf) revert InvalidUTF8();
            }
            i += continuation + 1;
        }
    }
}

