// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PlatformRegistry
/// @notice Registry for deployed platform components and approved artists.
contract PlatformRegistry is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    mapping(bytes32 key => address component) public components;
    mapping(address artist => bool approved) public approvedArtists;
    event ComponentSet(bytes32 indexed key, address indexed component);
    event ArtistApprovalSet(address indexed artist, bool approved);

    constructor(address admin) { _grantRole(DEFAULT_ADMIN_ROLE, admin); _grantRole(OPERATOR_ROLE, admin); }
    function setComponent(bytes32 key, address component) external onlyRole(DEFAULT_ADMIN_ROLE) { components[key] = component; emit ComponentSet(key, component); }
    function setArtistApproval(address artist, bool approved) external onlyRole(OPERATOR_ROLE) { approvedArtists[artist] = approved; emit ArtistApprovalSet(artist, approved); }
}
