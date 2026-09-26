// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ArtworkNFT} from "./ArtworkNFT.sol";

/// @title ArtistFactory
/// @notice Creates inexpensive artist-specific ArtworkNFT clones.
contract ArtistFactory {
    address public immutable implementation;
    address public immutable auctionHouse;
    uint96 public immutable royaltyBps;
    mapping(address artist => address collection) public collectionOf;
    mapping(address artist => address[]) public collectionsOf;

    error InvalidArtist();
    event CollectionCreated(address indexed artist, address indexed collection);

    constructor(address auctionHouse_, uint96 royaltyBps_) {
        auctionHouse = auctionHouse_; royaltyBps = royaltyBps_;
        implementation = address(new ArtworkNFT());
    }

    function createCollection(string calldata name_, string calldata symbol_) external returns (address collection) {
        if (msg.sender == address(0)) revert InvalidArtist();
        collection = Clones.clone(implementation);
        ArtworkNFT(collection).initialize(name_, symbol_, msg.sender, auctionHouse, msg.sender, royaltyBps);
        collectionOf[msg.sender] = collection;
        collectionsOf[msg.sender].push(collection);
        emit CollectionCreated(msg.sender, collection);
    }

    function getCollections(address artist) external view returns (address[] memory) {
        return collectionsOf[artist];
    }

    function artistTreasury(address artist) public pure returns (address) { return artist; }
}
