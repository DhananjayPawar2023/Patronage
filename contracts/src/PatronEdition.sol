// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PatronEdition
/// @notice Soulbound support token minted by the auction house during a live lot.
contract PatronEdition is ERC1155, AccessControl {
    bytes32 public constant AUCTION_ROLE = keccak256("AUCTION_ROLE");
    uint256 public constant EDITION_ID = 1;
    uint256 public mintPrice;
    mapping(uint256 lotId => bool live) public lotLive;
    mapping(uint256 lotId => mapping(address recipient => bool minted)) public lotRecipientMinted;

    error NonTransferable();
    error InvalidPrice();
    error LotNotLive();
    error AlreadyMinted();
    error IncorrectPayment();
    error WithdrawFailed();
    event PatronMinted(uint256 indexed lotId, address indexed recipient);

    constructor(string memory baseUri, address admin, uint256 mintPrice_) ERC1155(baseUri) {
        if (admin == address(0) || mintPrice_ == 0) revert InvalidPrice();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AUCTION_ROLE, admin);
        mintPrice = mintPrice_;
    }

    function setLotLive(uint256 lotId, bool live) external onlyRole(AUCTION_ROLE) { lotLive[lotId] = live; }

    function mint(uint256 lotId, address recipient) external payable onlyRole(AUCTION_ROLE) {
        if (!lotLive[lotId]) revert LotNotLive();
        if (lotRecipientMinted[lotId][recipient]) revert AlreadyMinted();
        if (msg.value != mintPrice) revert IncorrectPayment();
        lotRecipientMinted[lotId][recipient] = true;
        _mint(recipient, EDITION_ID, 1, "");
        emit PatronMinted(lotId, recipient);
    }

    function withdraw(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (bool success, ) = to.call{value: address(this).balance}("");
        if (!success) revert WithdrawFailed();
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
