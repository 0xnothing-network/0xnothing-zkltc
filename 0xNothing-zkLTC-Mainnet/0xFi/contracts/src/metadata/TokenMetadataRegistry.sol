// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TokenMetadataRegistry
/// @notice Immutable one-time image registration for externally owned ERC-20 tokens.
/// The registry deliberately fails closed when ownership cannot be proven and permanently
/// excludes protocol/core tokens supplied at deployment.
contract TokenMetadataRegistry {
    error ZeroToken();
    error DuplicateProtectedToken(address token);
    error ProtectedToken(address token);
    error AlreadyRegistered(address token);
    error TokenNotContract();
    error UnsupportedOwnership();
    error RenouncedOwnership();
    error NotTokenOwner();
    error InvalidImageURI();

    uint256 public constant MAX_IMAGE_URI_LENGTH = 2048;

    struct ImageRecord {
        string imageURI;
        address registrant;
        uint64 registeredAt;
    }

    mapping(address => bool) public isProtectedToken;
    mapping(address => ImageRecord) private _imageRecords;
    address[] private _registeredTokens;
    address[] private _protectedTokens;

    event TokenImageRegistered(
        address indexed token, address indexed registrant, uint256 indexed registrationId, string imageURI
    );

    constructor(address[] memory protectedTokens_) {
        uint256 length = protectedTokens_.length;
        for (uint256 i; i < length; ++i) {
            address token = protectedTokens_[i];
            if (token == address(0)) revert ZeroToken();
            if (isProtectedToken[token]) revert DuplicateProtectedToken(token);
            isProtectedToken[token] = true;
            _protectedTokens.push(token);
        }
    }

    /// @notice Permanently register an image URI for `token`.
    /// @dev The caller must be the nonzero address returned by a canonical `owner()` response.
    function registerImage(address token, string calldata imageURI_) external returns (uint256 registrationId) {
        if (token.code.length == 0) revert TokenNotContract();
        if (isProtectedToken[token]) revert ProtectedToken(token);
        if (bytes(_imageRecords[token].imageURI).length != 0) revert AlreadyRegistered(token);
        if (!_validImageURI(imageURI_)) revert InvalidImageURI();

        address tokenOwner = _tokenOwner(token);
        if (tokenOwner == address(0)) revert RenouncedOwnership();
        if (tokenOwner != msg.sender) revert NotTokenOwner();

        registrationId = _registeredTokens.length;
        _registeredTokens.push(token);
        _imageRecords[token] = ImageRecord({
            imageURI: imageURI_,
            registrant: msg.sender,
            // forge-lint: disable-next-line(unsafe-typecast)
            registeredAt: uint64(block.timestamp)
        });

        emit TokenImageRegistered(token, msg.sender, registrationId, imageURI_);
    }

    function imageRecord(address token) external view returns (ImageRecord memory) {
        return _imageRecords[token];
    }

    function imageURI(address token) external view returns (string memory) {
        return _imageRecords[token].imageURI;
    }

    function registrationCount() external view returns (uint256) {
        return _registeredTokens.length;
    }

    function registeredToken(uint256 registrationId) external view returns (address) {
        return _registeredTokens[registrationId];
    }

    function protectedTokenCount() external view returns (uint256) {
        return _protectedTokens.length;
    }

    function protectedToken(uint256 index) external view returns (address) {
        return _protectedTokens[index];
    }

    function _tokenOwner(address token) private view returns (address owner_) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSignature("owner()"));
        if (!success || data.length != 32) revert UnsupportedOwnership();

        uint256 encodedOwner;
        assembly ("memory-safe") {
            encodedOwner := mload(add(data, 0x20))
        }
        if (encodedOwner > type(uint160).max) revert UnsupportedOwnership();
        // The explicit upper-bound check above guarantees this cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        owner_ = address(uint160(encodedOwner));
    }

    function _validImageURI(string calldata imageURI_) private pure returns (bool) {
        bytes calldata value = bytes(imageURI_);
        uint256 length = value.length;
        if (length == 0 || length > MAX_IMAGE_URI_LENGTH) return false;

        bool ipfs = length > 7 && value[0] == "i" && value[1] == "p" && value[2] == "f" && value[3] == "s"
            && value[4] == ":" && value[5] == "/" && value[6] == "/";
        bool https = length > 8 && value[0] == "h" && value[1] == "t" && value[2] == "t" && value[3] == "p"
            && value[4] == "s" && value[5] == ":" && value[6] == "/" && value[7] == "/";
        if (!ipfs && !https) return false;

        for (uint256 i; i < length; ++i) {
            bytes1 character = value[i];
            if (character <= 0x20 || character == 0x7f) return false;
        }
        return true;
    }
}
