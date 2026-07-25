// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract ZeroxPixel {
    uint256 public constant MAX_GRID = 64;
    uint256 public constant MAX_NAME_LENGTH = 32;
    uint256 public constant MAX_RECTS = MAX_GRID * MAX_GRID;
    uint256 public constant MAX_PIXEL_DATA_LENGTH = 2 + (MAX_RECTS * 12);
    uint96 public constant CREATOR_ROYALTY_BPS = 100;

    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;
    bytes4 private constant ERC721_METADATA_INTERFACE_ID = 0x5b5e139f;
    bytes4 private constant ERC2981_INTERFACE_ID = 0x2a55205a;
    bytes4 private constant ERC721_RECEIVED = 0x150b7a02;
    uint96 private constant FEE_DENOMINATOR = 10000;

    uint256 private _tokenIds;
    uint256 private _locked = 1;

    address payable public immutable devWallet;
    address private _royaltyReceiver;
    uint96 private _royaltyFeeNumerator;

    struct PixelArt {
        string name;
        string pixelData;
        address creator;
        uint64 mintedAt;
        uint8 gridSize;
        bytes32 artworkHash;
    }

    mapping(uint256 => PixelArt) private _tokenData;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    mapping(bytes32 => uint256) public artworkRegistry;
    mapping(address => uint256[]) public userTokens;
    mapping(uint256 => uint256) public userTokenIndex;
    mapping(address => uint256) public pendingWithdrawals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(address indexed creator, uint256 indexed tokenId, string name);
    event ArtworkRegistered(bytes32 indexed artworkHash, uint256 indexed tokenId, uint256 gridSize);
    event RoyaltyUpdated(address indexed receiver, uint96 feeNumerator);
    event Withdrawal(address indexed account, uint256 amount);

    modifier nonReentrant() {
        require(_locked != 2, "Reentrancy");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address payable _devWallet, address royaltyReceiver, uint96 royaltyFeeNumerator) {
        require(_devWallet != address(0), "Zero dev wallet");
        devWallet = _devWallet;

        if (royaltyReceiver != address(0) && royaltyFeeNumerator > 0) {
            _setRoyalty(royaltyReceiver, royaltyFeeNumerator);
        }
    }

    receive() external payable {
        pendingWithdrawals[devWallet] += msg.value;
    }

    function name() external pure returns (string memory) {
        return "0xPixel";
    }

    function symbol() external pure returns (string memory) {
        return "0xP";
    }

    function balanceOf(address owner) public view returns (uint256) {
        require(owner != address(0), "Zero address");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "Token does not exist");
        return owner;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_owners[tokenId] != address(0), "Token does not exist");
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        require(to != owner, "Approval to owner");
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "Not authorized");

        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "Approval to caller");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "Not authorized");
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        require(_checkOnERC721Received(from, to, tokenId, data), "Invalid receiver");
    }

    function transferNFT(address to, uint256 id) external nonReentrant {
        require(msg.sender == ownerOf(id), "Not owner");
        _transfer(msg.sender, to, id);
    }

    function mint(string calldata artName, uint256 grid, string calldata px)
        external
        nonReentrant
        returns (uint256)
    {
        bytes calldata nameBytes = bytes(artName);
        bytes calldata pixelBytes = bytes(px);

        require(nameBytes.length != 0 && nameBytes.length <= MAX_NAME_LENGTH, "Invalid name");
        require(grid == 8 || grid == 16 || grid == 32 || grid == 64, "Invalid grid size");
        _validatePackedPixels(pixelBytes, grid);

        bytes32 h = keccak256(abi.encodePacked(px, grid));
        require(artworkRegistry[h] == 0, "Artwork already exists");

        unchecked {
            ++_tokenIds;
        }
        uint256 id = _tokenIds;

        artworkRegistry[h] = id;
        _tokenData[id] = PixelArt({
            name: artName,
            pixelData: px,
            creator: msg.sender,
            mintedAt: uint64(block.timestamp),
            gridSize: uint8(grid),
            artworkHash: h
        });

        _mint(msg.sender, id);

        emit Minted(msg.sender, id, artName);
        emit ArtworkRegistered(h, id, grid);

        return id;
    }

    function tokenData(uint256 id)
        external
        view
        returns (
            string memory artName,
            uint256 gridSize,
            string memory pixelData,
            address creator,
            uint256 mintedAt,
            bytes32 artworkHash
        )
    {
        require(_owners[id] != address(0), "Token does not exist");
        PixelArt storage art = _tokenData[id];
        return (
            art.name,
            uint256(art.gridSize),
            art.pixelData,
            art.creator,
            uint256(art.mintedAt),
            art.artworkHash
        );
    }

    function checkOriginal(string calldata px, uint256 grid) external view returns (bool) {
        return artworkRegistry[keccak256(abi.encodePacked(px, grid))] == 0;
    }

    function getCreator(string calldata px, uint256 grid) external view returns (address) {
        uint256 id = artworkRegistry[keccak256(abi.encodePacked(px, grid))];
        return id == 0 ? address(0) : _tokenData[id].creator;
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        require(_owners[id] != address(0), "Token does not exist");

        PixelArt storage art = _tokenData[id];
        string memory svg = _generateSVG(art.pixelData, uint256(art.gridSize));
        string memory json = string(
            abi.encodePacked(
                '{"name":"',
                _escapeJSON(art.name),
                '","description":"Fully on-chain pixel art NFT on LitVM","image":"data:image/svg+xml;base64,',
                _base64(bytes(svg)),
                '","attributes":[{"trait_type":"Grid Size","value":',
                _toString(uint256(art.gridSize)),
                '},{"trait_type":"Creator","value":"',
                _addressToHex(art.creator),
                '"},{"trait_type":"Minted At","value":',
                _toString(uint256(art.mintedAt)),
                "}]}"
            )
        );

        return string(abi.encodePacked("data:application/json;base64,", _base64(bytes(json))));
    }

    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        address creator = _tokenData[tokenId].creator;
        if (creator != address(0)) {
            receiver = creator;
            royaltyAmount = (salePrice * CREATOR_ROYALTY_BPS) / FEE_DENOMINATOR;
        } else {
            receiver = _royaltyReceiver;
            royaltyAmount = (salePrice * _royaltyFeeNumerator) / FEE_DENOMINATOR;
        }
    }

    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external {
        require(msg.sender == devWallet, "Only dev");
        _setRoyalty(receiver, feeNumerator);
    }

    function deleteDefaultRoyalty() external {
        require(msg.sender == devWallet, "Only dev");
        _royaltyReceiver = address(0);
        _royaltyFeeNumerator = 0;
        emit RoyaltyUpdated(address(0), 0);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "No funds");
        pendingWithdrawals[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");

        emit Withdrawal(msg.sender, amount);
    }

    function withdrawDev(uint256 amount) external nonReentrant {
        require(msg.sender == devWallet, "Only dev");
        require(amount > 0, "amount=0");
        require(address(this).balance >= amount, "Insufficient balance");

        (bool ok, ) = devWallet.call{value: amount}("");
        require(ok, "Withdraw failed");

        emit Withdrawal(devWallet, amount);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC165_INTERFACE_ID
            || interfaceId == ERC721_INTERFACE_ID
            || interfaceId == ERC721_METADATA_INTERFACE_ID
            || interfaceId == ERC2981_INTERFACE_ID;
    }

    function _mint(address to, uint256 tokenId) internal {
        require(to != address(0), "Zero address");
        require(_owners[tokenId] == address(0), "Already minted");

        unchecked {
            ++_balances[to];
        }
        _owners[tokenId] = to;
        _addUserToken(to, tokenId);

        emit Transfer(address(0), to, tokenId);
        require(_checkOnERC721Received(address(0), to, tokenId, ""), "Invalid receiver");
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(to != address(0), "Zero address");
        require(ownerOf(tokenId) == from, "Wrong owner");

        delete _tokenApprovals[tokenId];

        unchecked {
            --_balances[from];
            ++_balances[to];
        }
        _owners[tokenId] = to;
        _removeUserToken(from, tokenId);
        _addUserToken(to, tokenId);

        emit Transfer(from, to, tokenId);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf(tokenId);
        return spender == owner || _tokenApprovals[tokenId] == spender || _operatorApprovals[owner][spender];
    }

    function _addUserToken(address to, uint256 tokenId) internal {
        userTokens[to].push(tokenId);
        userTokenIndex[tokenId] = userTokens[to].length - 1;
    }

    function _removeUserToken(address from, uint256 tokenId) internal {
        uint256 idx = userTokenIndex[tokenId];
        uint256[] storage tokens = userTokens[from];
        uint256 last = tokens[tokens.length - 1];

        if (last != tokenId) {
            tokens[idx] = last;
            userTokenIndex[last] = idx;
        }

        tokens.pop();
        delete userTokenIndex[tokenId];
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data)
        internal
        returns (bool)
    {
        if (to.code.length == 0) return true;

        (bool ok, bytes memory result) = to.call(
            abi.encodeWithSelector(ERC721_RECEIVED, msg.sender, from, tokenId, data)
        );
        return ok && result.length == 32 && abi.decode(result, (bytes4)) == ERC721_RECEIVED;
    }

    function _setRoyalty(address receiver, uint96 feeNumerator) internal {
        require(receiver != address(0), "Zero address");
        require(feeNumerator <= FEE_DENOMINATOR, "Royalty too high");
        _royaltyReceiver = receiver;
        _royaltyFeeNumerator = feeNumerator;
        emit RoyaltyUpdated(receiver, feeNumerator);
    }

    function _validatePackedPixels(bytes calldata data, uint256 grid) internal pure {
        uint256 len = data.length;
        require(len > 2 && len <= MAX_PIXEL_DATA_LENGTH, "Invalid pixel data");
        require(data[0] == "0" && (data[1] == "x" || data[1] == "X"), "Invalid pixel data");

        uint256 bodyLen = len - 2;
        require(bodyLen % 12 == 0, "Invalid packed data");

        for (uint256 i = 2; i < len; ) {
            uint256 x = _hexByteCalldata(data, i);
            uint256 y = _hexByteCalldata(data, i + 2);
            uint256 count = _hexByteCalldata(data, i + 4);
            require(count > 0, "Invalid run");
            require(x < grid && y < grid && x + count <= grid, "Pixel out of bounds");

            unchecked {
                i += 12;
            }
        }
    }

    function _generateSVG(string memory pixelData, uint256 gridSize) internal pure returns (string memory) {
        bytes memory data = bytes(pixelData);
        uint256 len = data.length;
        uint256 count = (len - 2) / 12;
        bytes[] memory parts = new bytes[](count + 2);

        parts[0] = abi.encodePacked(
            "<svg xmlns='http://www.w3.org/2000/svg' width='",
            _toString(gridSize),
            "' height='",
            _toString(gridSize),
            "' viewBox='0 0 ",
            _toString(gridSize),
            " ",
            _toString(gridSize),
            "' shape-rendering='crispEdges'>"
        );

        uint256 idx = 1;
        for (uint256 i = 2; i + 12 <= len; ) {
            uint256 x = _hexByteMemory(data, i);
            uint256 y = _hexByteMemory(data, i + 2);
            uint256 run = _hexByteMemory(data, i + 4);
            uint256 r = _hexByteMemory(data, i + 6);
            uint256 g = _hexByteMemory(data, i + 8);
            uint256 b = _hexByteMemory(data, i + 10);

            parts[idx++] = abi.encodePacked(
                "<rect x='",
                _toString(x),
                "' y='",
                _toString(y),
                "' width='",
                _toString(run),
                "' height='1' fill='rgb(",
                _toString(r),
                ",",
                _toString(g),
                ",",
                _toString(b),
                ")'/>"
            );

            unchecked {
                i += 12;
            }
        }

        parts[idx] = bytes("</svg>");
        return string(_join(parts));
    }

    function _hexByteCalldata(bytes calldata data, uint256 i) internal pure returns (uint256) {
        return (_hexToVal(uint8(data[i])) << 4) | _hexToVal(uint8(data[i + 1]));
    }

    function _hexByteMemory(bytes memory data, uint256 i) internal pure returns (uint256) {
        return (_hexToVal(uint8(data[i])) << 4) | _hexToVal(uint8(data[i + 1]));
    }

    function _hexToVal(uint8 c) internal pure returns (uint256) {
        if (c >= 48 && c <= 57) return c - 48;
        if (c >= 97 && c <= 102) return c - 87;
        if (c >= 65 && c <= 70) return c - 55;
        revert("Invalid hex");
    }

    function _escapeJSON(string memory value) internal pure returns (string memory) {
        bytes memory input = bytes(value);
        uint256 extra = 0;

        for (uint256 i = 0; i < input.length; ) {
            bytes1 c = input[i];
            if (c == '"' || c == "\\") {
                unchecked {
                    ++extra;
                }
            }
            unchecked {
                ++i;
            }
        }

        if (extra == 0) return value;

        bytes memory output = new bytes(input.length + extra);
        uint256 k = 0;
        for (uint256 i = 0; i < input.length; ) {
            bytes1 c = input[i];
            if (c == '"' || c == "\\") output[k++] = "\\";
            output[k++] = c;
            unchecked {
                ++i;
            }
        }

        return string(output);
    }

    function _addressToHex(address account) internal pure returns (string memory) {
        bytes20 value = bytes20(account);
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";

        for (uint256 i = 0; i < 20; ) {
            out[2 + i * 2] = alphabet[uint8(value[i] >> 4)];
            out[3 + i * 2] = alphabet[uint8(value[i] & 0x0f)];
            unchecked {
                ++i;
            }
        }

        return string(out);
    }

    function _join(bytes[] memory parts) internal pure returns (bytes memory) {
        uint256 total = 0;
        for (uint256 i = 0; i < parts.length; ) {
            total += parts[i].length;
            unchecked {
                ++i;
            }
        }

        bytes memory result = new bytes(total);
        uint256 ptr = 0;
        for (uint256 i = 0; i < parts.length; ) {
            bytes memory part = parts[i];
            for (uint256 j = 0; j < part.length; ) {
                result[ptr++] = part[j];
                unchecked {
                    ++j;
                }
            }
            unchecked {
                ++i;
            }
        }
        return result;
    }

    function _base64(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        bytes memory result = new bytes(encodedLen);

        uint256 i = 0;
        uint256 j = 0;
        while (i + 3 <= data.length) {
            uint256 input = (uint8(data[i]) << 16) | (uint8(data[i + 1]) << 8) | uint8(data[i + 2]);
            result[j++] = table[(input >> 18) & 0x3F];
            result[j++] = table[(input >> 12) & 0x3F];
            result[j++] = table[(input >> 6) & 0x3F];
            result[j++] = table[input & 0x3F];
            unchecked {
                i += 3;
            }
        }

        if (i + 1 == data.length) {
            uint256 input = uint8(data[i]) << 16;
            result[j++] = table[(input >> 18) & 0x3F];
            result[j++] = table[(input >> 12) & 0x3F];
            result[j++] = "=";
            result[j++] = "=";
        } else if (i + 2 == data.length) {
            uint256 input = (uint8(data[i]) << 16) | (uint8(data[i + 1]) << 8);
            result[j++] = table[(input >> 18) & 0x3F];
            result[j++] = table[(input >> 12) & 0x3F];
            result[j++] = table[(input >> 6) & 0x3F];
            result[j++] = "=";
        }

        return string(result);
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";

        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            unchecked {
                ++digits;
                temp /= 10;
            }
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            unchecked {
                --digits;
            }
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }

        return string(buffer);
    }
}
