// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface IPatronEdition {
    function setLotLive(uint256 lotId, bool live) external;
    function mint(uint256 lotId, address recipient) external payable;
}

/// @title AuctionHouse
/// @notice Non-custodial timed English auctions with pull refunds and royalty support.
contract AuctionHouse is ReentrancyGuard, Pausable, AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant BPS = 10_000;
    uint256 public immutable antiSnipeWindow;
    address payable public protocolTreasury;
    address public patronEdition;
    uint256 public protocolFeeBps;
    uint256 public nextLotId = 1;

    struct Lot {
        address seller;
        uint64 start;
        bool settled;
        bool cancelled;
        address nft;
        uint64 end;
        address bidder;
        uint256 tokenId;
        uint256 reserve;
        uint256 minIncrement;
        uint256 highestBid;
        uint256 buyNowPrice;
    }
    mapping(uint256 lotId => Lot lot) public lots;
    mapping(address account => uint256 amount) public refundable;

    error InvalidLot(); error InvalidTime(); error InvalidFee(); error AuctionNotLive(); error BidTooLow(); error ReserveNotMet(); error AlreadySettled(); error NotSeller(); error TransferFailed(); error NoRefund(); error DirectETHNotAllowed(); error PatronEditionNotConfigured(); error PatronEditionClosed(); error BuyNowUnavailable(); error BuyNowIncorrectAmount();
    event LotCreated(uint256 indexed lotId, address indexed seller, address indexed nft, uint256 tokenId, uint256 reserve, uint256 minIncrement, uint64 start, uint64 end);
    event BuyNowConfigured(uint256 indexed lotId, uint256 buyNowPrice);
    event BuyNowExecuted(uint256 indexed lotId, address indexed buyer, uint256 amount);
    event BidPlaced(uint256 indexed lotId, address indexed bidder, uint256 amount, uint64 end);
    event BidWithdrawn(address indexed bidder, uint256 amount);
    event LotSettled(uint256 indexed lotId, address indexed winner, uint256 amount, uint256 protocolFee, uint256 royalty);
    event LotCancelled(uint256 indexed lotId);
    event PatronEditionConfigured(address indexed patronEdition);

    constructor(address payable treasury, uint256 feeBps, uint256 antiSnipeWindow_) {
        if (treasury == address(0) || feeBps > BPS) revert InvalidFee();
        protocolTreasury = treasury; protocolFeeBps = feeBps; antiSnipeWindow = antiSnipeWindow_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender); _grantRole(OPERATOR_ROLE, msg.sender);
    }

    function createLot(address nft, uint256 tokenId, uint256 reserve, uint256 minIncrement, uint64 start, uint64 end) external whenNotPaused returns (uint256 lotId) {
        return createLotWithBuyNow(nft, tokenId, reserve, minIncrement, start, end, 0);
    }

    function createLotWithBuyNow(address nft, uint256 tokenId, uint256 reserve, uint256 minIncrement, uint64 start, uint64 end, uint256 buyNowPrice) public whenNotPaused returns (uint256 lotId) {
        if (nft == address(0) || minIncrement == 0 || start >= end || end <= block.timestamp) revert InvalidLot();
        if (buyNowPrice > 0 && buyNowPrice < reserve) revert InvalidLot();
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        lotId = nextLotId++;
        lots[lotId] = Lot({
            seller: msg.sender,
            start: start,
            settled: false,
            cancelled: false,
            nft: nft,
            end: end,
            bidder: address(0),
            tokenId: tokenId,
            reserve: reserve,
            minIncrement: minIncrement,
            highestBid: 0,
            buyNowPrice: buyNowPrice
        });
        emit LotCreated(lotId, msg.sender, nft, tokenId, reserve, minIncrement, start, end);
        if (buyNowPrice > 0) emit BuyNowConfigured(lotId, buyNowPrice);
        if (patronEdition != address(0)) IPatronEdition(patronEdition).setLotLive(lotId, true);
    }

    function buyNow(uint256 lotId) external payable whenNotPaused nonReentrant {
        Lot storage lot = lots[lotId];
        if (lot.seller == address(0) || lot.cancelled || lot.settled || block.timestamp < lot.start || block.timestamp >= lot.end) revert AuctionNotLive();
        if (lot.buyNowPrice == 0) revert BuyNowUnavailable();
        if (msg.value < lot.buyNowPrice) revert BuyNowIncorrectAmount();

        lot.settled = true;
        if (patronEdition != address(0)) IPatronEdition(patronEdition).setLotLive(lotId, false);

        if (lot.bidder != address(0) && lot.highestBid > 0) {
            refundable[lot.bidder] += lot.highestBid;
        }

        uint256 salePrice = lot.buyNowPrice;
        uint256 excess = msg.value - salePrice;
        if (excess > 0) {
            (bool refundExcessOk,) = payable(msg.sender).call{value: excess}("");
            if (!refundExcessOk) refundable[msg.sender] += excess;
        }

        uint256 royalty = 0;
        address royaltyReceiver = address(0);
        try IERC2981(lot.nft).royaltyInfo(lot.tokenId, salePrice) returns (address receiver, uint256 amount) {
            if (receiver != address(0)) {
                royaltyReceiver = receiver;
                royalty = amount;
            }
        } catch {}

        uint256 protocolFee = (salePrice * protocolFeeBps) / BPS;
        if (protocolFee + royalty > salePrice) {
            if (protocolFee >= salePrice) {
                protocolFee = salePrice;
                royalty = 0;
            } else {
                royalty = salePrice - protocolFee;
            }
        }

        uint256 sellerAmount = salePrice - protocolFee - royalty;
        IERC721(lot.nft).safeTransferFrom(address(this), msg.sender, lot.tokenId);

        _safePay(payable(lot.seller), sellerAmount);
        if (protocolFee > 0) _safePay(protocolTreasury, protocolFee);
        if (royalty > 0 && royaltyReceiver != address(0)) _safePay(payable(royaltyReceiver), royalty);

        emit BuyNowExecuted(lotId, msg.sender, salePrice);
        emit LotSettled(lotId, msg.sender, salePrice, protocolFee, royalty);
    }

    function setPatronEdition(address patronEdition_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (patronEdition_ == address(0)) revert InvalidLot();
        patronEdition = patronEdition_;
        emit PatronEditionConfigured(patronEdition_);
    }

    function mintPatronEdition(uint256 lotId) external payable nonReentrant {
        Lot storage lot = lots[lotId];
        if (patronEdition == address(0)) revert PatronEditionNotConfigured();
        if (lot.seller == address(0) || lot.cancelled || lot.settled || block.timestamp < lot.start || block.timestamp >= lot.end) revert PatronEditionClosed();
        IPatronEdition(patronEdition).mint{value: msg.value}(lotId, msg.sender);
    }

    function placeBid(uint256 lotId) external payable whenNotPaused nonReentrant {
        Lot storage lot = lots[lotId];
        if (lot.seller == address(0) || lot.cancelled || lot.settled || block.timestamp < lot.start || block.timestamp >= lot.end) revert AuctionNotLive();
        uint256 minimum = lot.highestBid == 0 ? lot.reserve : lot.highestBid + lot.minIncrement;
        if (msg.value < minimum) revert BidTooLow();
        if (lot.bidder != address(0)) refundable[lot.bidder] += lot.highestBid;
        lot.bidder = msg.sender; lot.highestBid = msg.value;
        if (lot.end - uint64(block.timestamp) <= antiSnipeWindow) lot.end = uint64(block.timestamp + antiSnipeWindow);
        emit BidPlaced(lotId, msg.sender, msg.value, lot.end);
    }

    function withdrawRefund() external nonReentrant {
        uint256 amount = refundable[msg.sender]; if (amount == 0) revert NoRefund(); refundable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}(""); if (!ok) revert TransferFailed(); emit BidWithdrawn(msg.sender, amount);
    }

    function settle(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        if (lot.seller == address(0) || lot.settled || lot.cancelled || block.timestamp < lot.end) revert InvalidLot();
        lot.settled = true;
        if (patronEdition != address(0)) IPatronEdition(patronEdition).setLotLive(lotId, false);
        if (lot.bidder == address(0) || lot.highestBid < lot.reserve) { IERC721(lot.nft).safeTransferFrom(address(this), lot.seller, lot.tokenId); emit LotSettled(lotId, address(0), 0, 0, 0); return; }
        uint256 royalty = 0;
        address royaltyReceiver = address(0);
        try IERC2981(lot.nft).royaltyInfo(lot.tokenId, lot.highestBid) returns (address receiver, uint256 amount) {
            if (receiver != address(0)) {
                royaltyReceiver = receiver;
                royalty = amount;
            }
        } catch {}

        uint256 protocolFee = (lot.highestBid * protocolFeeBps) / BPS;
        if (protocolFee + royalty > lot.highestBid) {
            if (protocolFee >= lot.highestBid) {
                protocolFee = lot.highestBid;
                royalty = 0;
            } else {
                royalty = lot.highestBid - protocolFee;
            }
        }

        uint256 sellerAmount = lot.highestBid - protocolFee - royalty;
        IERC721(lot.nft).safeTransferFrom(address(this), lot.bidder, lot.tokenId);

        _safePay(payable(lot.seller), sellerAmount);
        if (protocolFee > 0) _safePay(protocolTreasury, protocolFee);
        if (royalty > 0 && royaltyReceiver != address(0)) _safePay(payable(royaltyReceiver), royalty);
        emit LotSettled(lotId, lot.bidder, lot.highestBid, protocolFee, royalty);
    }

    function cancel(uint256 lotId) external {
        Lot storage lot = lots[lotId]; if (msg.sender != lot.seller || lot.bidder != address(0) || lot.settled || lot.cancelled) revert NotSeller();
        lot.cancelled = true;
        if (patronEdition != address(0)) IPatronEdition(patronEdition).setLotLive(lotId, false);
        IERC721(lot.nft).safeTransferFrom(address(this), lot.seller, lot.tokenId); emit LotCancelled(lotId);
    }

    function setProtocolFee(uint256 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) { if (feeBps > BPS) revert InvalidFee(); protocolFeeBps = feeBps; }
    function setProtocolTreasury(address payable treasury) external onlyRole(DEFAULT_ADMIN_ROLE) { if (treasury == address(0)) revert InvalidFee(); protocolTreasury = treasury; }
    function pause() external onlyRole(OPERATOR_ROLE) { _pause(); }
    function unpause() external onlyRole(OPERATOR_ROLE) { _unpause(); }

    function _safePay(address payable recipient, uint256 amount) private {
        if (amount == 0 || recipient == address(0)) return;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) {
            refundable[recipient] += amount;
        }
    }

    receive() external payable {
        revert DirectETHNotAllowed();
    }
}
