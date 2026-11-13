// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PixelERC721} from "./PixelERC721.sol";

/// @notice What a marketplace reads to know that a listing is still the one its owner made.
interface IListingEpoch {
    /// @notice A number that, for as long as `tokenId` stays with one owner, only goes up, and goes
    ///         up whenever the token is transferred, its approved address changes, or that owner
    ///         changes `operator`'s approval for all tokens. While the owner and this number are both
    ///         unchanged, nothing has happened to the token or to `operator`'s right to move it.
    /// @dev It is a sum of a per-token and a per-owner count, so it can go down when the token moves
    ///      to another owner. Only the pair (owner, number) identifies a state: compare the owner
    ///      first, as NusdNftMarketplaceV2 does.
    function listingEpoch(uint256 tokenId, address operator) external view returns (uint256);
}

/// @notice ERC-721 that counts every transfer and every change of approval. A marketplace stores
///         the count when a token is listed and refuses the sale once it has moved, so a listing
///         can never come back to life after its token left the seller or the seller withdrew the
///         approval. Repeating an approval that is already in place changes nothing and is not
///         counted.
abstract contract ListingEpochERC721 is PixelERC721, IListingEpoch {
    mapping(uint256 tokenId => uint256) private _tokenEpoch;
    mapping(address owner => mapping(address operator => uint256)) private _operatorEpoch;

    /// @inheritdoc IListingEpoch
    function listingEpoch(uint256 tokenId, address operator) external view returns (uint256) {
        return _tokenEpoch[tokenId] + _operatorEpoch[_requireOwned(tokenId)][operator];
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IListingEpoch).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @dev Every transfer of an existing token counts, whether or not an approval was set. A mint
    ///      does not: nothing can have been listed before it.
    function _update(address to, uint256 tokenId, address auth) internal virtual override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            unchecked {
                ++_tokenEpoch[tokenId];
            }
        }
    }

    /// @dev Counts an approval that changes the approved address. The base contract also calls this
    ///      to clear the approval on a transfer, which is counted above whatever happens here.
    function _approve(address to, uint256 tokenId, address auth, bool emitEvent) internal virtual override {
        bool changes = _getApproved(tokenId) != to;
        super._approve(to, tokenId, auth, emitEvent);
        if (changes) {
            unchecked {
                ++_tokenEpoch[tokenId];
            }
        }
    }

    function _setApprovalForAll(address owner, address operator, bool approved) internal virtual override {
        bool changes = isApprovedForAll(owner, operator) != approved;
        super._setApprovalForAll(owner, operator, approved);
        if (changes) {
            unchecked {
                ++_operatorEpoch[owner][operator];
            }
        }
    }
}
