// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PixelERC721} from "../../../src/0xpixel/PixelERC721.sol";
import {IListingEpoch} from "../../../src/0xpixel/ListingEpochERC721.sol";

/// Three deliberately broken copies of ListingEpochERC721, each with exactly one count missing.
/// They exist to show that the marketplace model in AuditMarketplaceModel.t.sol notices a listing
/// that comes back to life; a model that passed on these would prove nothing.
abstract contract EpochMutantBase is PixelERC721, IListingEpoch {
    mapping(uint256 tokenId => uint256) internal tokenEpoch;
    mapping(address owner => mapping(address operator => uint256)) internal operatorEpoch;

    constructor() PixelERC721("Mutant NFT", "MNFT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function transferNFT(address to, uint256 id) external {
        safeTransferFrom(msg.sender, to, id);
    }

    function listingEpoch(uint256 tokenId, address operator) external view returns (uint256) {
        return tokenEpoch[tokenId] + operatorEpoch[_requireOwned(tokenId)][operator];
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IListingEpoch).interfaceId || super.supportsInterface(interfaceId);
    }

    function _countTransfer(address from, uint256 tokenId) internal {
        if (from != address(0)) ++tokenEpoch[tokenId];
    }

    function _countApprovalChange(address to, uint256 tokenId) internal {
        if (_getApproved(tokenId) != to) ++tokenEpoch[tokenId];
    }

    function _countOperatorChange(address owner, address operator, bool approved) internal {
        if (isApprovedForAll(owner, operator) != approved) ++operatorEpoch[owner][operator];
    }
}

/// Broken: the approval for all is not counted. Revoking it and granting it again leaves the number
/// where it was (the second scenario of E-01).
contract EpochMutantNoOperatorEpoch is EpochMutantBase {
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        _countTransfer(from, tokenId);
    }

    function _approve(address to, uint256 tokenId, address auth, bool emitEvent) internal override {
        _countApprovalChange(to, tokenId);
        super._approve(to, tokenId, auth, emitEvent);
    }
}

/// Broken: a transfer is counted only through the approval it clears. A token listed under an
/// approval for all has no single approval to clear, so a transfer away and back is not counted
/// (the first scenario of E-01).
contract EpochMutantCountsOnlyChanges is EpochMutantBase {
    function _approve(address to, uint256 tokenId, address auth, bool emitEvent) internal override {
        _countApprovalChange(to, tokenId);
        super._approve(to, tokenId, auth, emitEvent);
    }

    function _setApprovalForAll(address owner, address operator, bool approved) internal override {
        _countOperatorChange(owner, operator, approved);
        super._setApprovalForAll(owner, operator, approved);
    }
}

/// Broken: approve() is not counted. Clearing the single approval and granting it again brings the
/// listing back.
contract EpochMutantCountsOnlyTransfers is EpochMutantBase {
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        _countTransfer(from, tokenId);
    }

    function _setApprovalForAll(address owner, address operator, bool approved) internal override {
        _countOperatorChange(owner, operator, approved);
        super._setApprovalForAll(owner, operator, approved);
    }
}
