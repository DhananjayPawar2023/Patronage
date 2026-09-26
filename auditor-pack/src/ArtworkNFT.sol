// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ArtworkNFT
/// @notice One-of-one artwork collection controlled by an approved artist.
contract ArtworkNFT is ERC721URIStorage, ERC2981, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint256 public nextTokenId = 1;
    address public creator;
    bool public initialized;
    string private _customName;
    string private _customSymbol;

    error InvalidCreator(); error AlreadyInitialized();

    constructor() ERC721("Patronage Artwork", "PATRON") {}

    /// @notice Initializes a minimal-proxy clone exactly once.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address creator_,
        address minter,
        address royaltyReceiver,
        uint96 royaltyBps
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (creator_ == address(0) || minter == address(0) || royaltyReceiver == address(0)) revert InvalidCreator();
        initialized = true; creator = creator_;
        nextTokenId = 1;
        _customName = name_; _customSymbol = symbol_;
        _grantRole(DEFAULT_ADMIN_ROLE, creator_); _grantRole(MINTER_ROLE, creator_); _grantRole(MINTER_ROLE, minter); _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    /// @notice Mints artwork token to the creator.
    function mint(string calldata metadataUri) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(creator, tokenId);
        _setTokenURI(tokenId, metadataUri);
    }

    function name() public view override returns (string memory) {
        return bytes(_customName).length > 0 ? _customName : super.name();
    }

    function symbol() public view override returns (string memory) {
        return bytes(_customSymbol).length > 0 ? _customSymbol : super.symbol();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
