// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ArtworkNFT} from "../src/ArtworkNFT.sol";
import {ArtistFactory} from "../src/ArtistFactory.sol";
import {PatronEdition} from "../src/PatronEdition.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";

// Reverting seller contract
contract RevertingSeller is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
    receive() external payable {
        revert("I refuse ETH payments");
    }
}

// Reverting royalty receiver
contract RevertingRoyaltyReceiver {
    receive() external payable {
        revert("I refuse royalty ETH");
    }
}

// Reentrant attacker contract attempting to drain funds on refund
contract ReentrantAttacker is IERC721Receiver {
    AuctionHouse public auctionHouse;
    uint256 public lotId;
    uint256 public attackCount;

    constructor(AuctionHouse _auctionHouse) {
        auctionHouse = _auctionHouse;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function attackWithdraw() external payable {
        auctionHouse.withdrawRefund();
    }

    receive() external payable {
        if (attackCount == 0) {
            attackCount++;
            // Attempt recursive reentrancy into withdrawRefund
            auctionHouse.withdrawRefund();
        }
    }
}

contract RedTeamAuctionHouseTest is Test {
    AuctionHouse public auctionHouse;
    ArtistFactory public factory;
    PatronEdition public patron;
    ArtworkNFT public collection;

    address payable public treasury = payable(address(0x1001));
    address public artist = address(0x2001);
    address public bidder1 = address(0x3001);
    address public bidder2 = address(0x3002);
    address public attacker = address(0x4001);

    uint256 public lotId;
    uint256 public tokenId;

    function setUp() public {
        vm.deal(artist, 100 ether);
        vm.deal(bidder1, 100 ether);
        vm.deal(bidder2, 100 ether);
        vm.deal(attacker, 100 ether);

        auctionHouse = new AuctionHouse(treasury, 250, 300); // 2.5% protocol fee, 300s anti-snipe
        factory = new ArtistFactory(address(auctionHouse), 1000); // 10% royalty

        vm.prank(artist);
        address colAddr = factory.createCollection("RedTeam Art", "RTA");
        collection = ArtworkNFT(colAddr);

        vm.prank(artist);
        tokenId = collection.mint("ipfs://metadata-uri");

        // Create default lot
        vm.startPrank(artist);
        collection.setApprovalForAll(address(auctionHouse), true);
        lotId = auctionHouse.createLotWithBuyNow(
            address(collection),
            tokenId,
            1 ether, // reserve
            0.1 ether, // minIncrement
            uint64(block.timestamp),
            uint64(block.timestamp + 3600),
            2 ether // buyNowPrice
        );
        vm.stopPrank();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 1. State Machine Red-Team Attacks
    // ────────────────────────────────────────────────────────────────────────

    function test_AttackSettleBeforeEndReverts() public {
        vm.expectRevert(AuctionHouse.InvalidLot.selector);
        auctionHouse.settle(lotId);
    }

    function test_AttackSettleTwiceReverts() public {
        // Place valid bid
        vm.prank(bidder1);
        auctionHouse.placeBid{value: 1 ether}(lotId);

        // Warp past end
        vm.warp(block.timestamp + 3601);

        // Settle once
        auctionHouse.settle(lotId);

        // Second settle must revert
        vm.expectRevert(AuctionHouse.InvalidLot.selector);
        auctionHouse.settle(lotId);
    }

    function test_AttackCancelWithBidsReverts() public {
        vm.prank(bidder1);
        auctionHouse.placeBid{value: 1 ether}(lotId);

        vm.prank(artist);
        vm.expectRevert(AuctionHouse.NotSeller.selector);
        auctionHouse.cancel(lotId);
    }

    function test_AttackCancelAfterSettlementReverts() public {
        vm.warp(block.timestamp + 3601);
        auctionHouse.settle(lotId);

        vm.prank(artist);
        vm.expectRevert(AuctionHouse.NotSeller.selector);
        auctionHouse.cancel(lotId);
    }

    function test_AttackBidOnExpiredAuctionReverts() public {
        vm.warp(block.timestamp + 3601);
        vm.prank(bidder1);
        vm.expectRevert(AuctionHouse.AuctionNotLive.selector);
        auctionHouse.placeBid{value: 1.5 ether}(lotId);
    }

    function test_AttackBidOnSettledAuctionReverts() public {
        vm.warp(block.timestamp + 3601);
        auctionHouse.settle(lotId);

        vm.prank(bidder1);
        vm.expectRevert(AuctionHouse.AuctionNotLive.selector);
        auctionHouse.placeBid{value: 1.5 ether}(lotId);
    }

    function test_AttackBidOnCancelledAuctionReverts() public {
        vm.prank(artist);
        auctionHouse.cancel(lotId);

        vm.prank(bidder1);
        vm.expectRevert(AuctionHouse.AuctionNotLive.selector);
        auctionHouse.placeBid{value: 1.5 ether}(lotId);
    }

    function test_AttackBuyNowInsufficientPaymentReverts() public {
        vm.prank(bidder1);
        vm.expectRevert(AuctionHouse.BuyNowIncorrectAmount.selector);
        auctionHouse.buyNow{value: 1.99 ether}(lotId); // buyNowPrice is 2 ether
    }

    function test_AttackBuyNowOnAuctionWithoutBuyNowReverts() public {
        vm.startPrank(artist);
        uint256 token2 = collection.mint("ipfs://meta2");
        uint256 lot2 = auctionHouse.createLot(
            address(collection),
            token2,
            1 ether,
            0.1 ether,
            uint64(block.timestamp),
            uint64(block.timestamp + 3600)
        );
        vm.stopPrank();

        vm.prank(bidder1);
        vm.expectRevert(AuctionHouse.BuyNowUnavailable.selector);
        auctionHouse.buyNow{value: 5 ether}(lot2);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2. Adversarial Reverting Participants
    // ────────────────────────────────────────────────────────────────────────

    function test_MaliciousRevertingSellerSettlementSafePay() public {
        RevertingSeller badSeller = new RevertingSeller();

        // Mint token and transfer to badSeller
        vm.prank(artist);
        uint256 tId = collection.mint("ipfs://bad-seller");
        vm.prank(artist);
        collection.transferFrom(artist, address(badSeller), tId);

        // badSeller creates lot
        vm.startPrank(address(badSeller));
        collection.setApprovalForAll(address(auctionHouse), true);
        uint256 badLot = auctionHouse.createLot(
            address(collection),
            tId,
            1 ether,
            0.1 ether,
            uint64(block.timestamp),
            uint64(block.timestamp + 3600)
        );
        vm.stopPrank();

        // Bidder places winning bid
        vm.prank(bidder1);
        auctionHouse.placeBid{value: 2 ether}(badLot);

        // End auction and settle
        vm.warp(block.timestamp + 3601);

        // Settle MUST NOT revert, seller proceeds must be routed to refundable
        auctionHouse.settle(badLot);

        // NFT transferred to bidder1
        assertEq(collection.ownerOf(tId), bidder1);

        // badSeller balance must be held safely in refundable
        uint256 sellerProceeds = auctionHouse.refundable(address(badSeller));
        assertTrue(sellerProceeds > 0, "Seller funds must be in refundable");
    }

    function test_MaliciousRevertingSellerBuyNowSafePay() public {
        RevertingSeller badSeller = new RevertingSeller();

        vm.prank(artist);
        uint256 tId = collection.mint("ipfs://bad-seller-buynow");
        vm.prank(artist);
        collection.transferFrom(artist, address(badSeller), tId);

        vm.startPrank(address(badSeller));
        collection.setApprovalForAll(address(auctionHouse), true);
        uint256 badLot = auctionHouse.createLotWithBuyNow(
            address(collection),
            tId,
            1 ether,
            0.1 ether,
            uint64(block.timestamp),
            uint64(block.timestamp + 3600),
            3 ether
        );
        vm.stopPrank();

        // Bidder executes BuyNow
        vm.prank(bidder1);
        auctionHouse.buyNow{value: 3 ether}(badLot);

        assertEq(collection.ownerOf(tId), bidder1);
        assertTrue(auctionHouse.refundable(address(badSeller)) > 0, "Seller funds must be in refundable");
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3. Reentrancy and Double-Refund Attacks
    // ────────────────────────────────────────────────────────────────────────

    function test_AttackDoubleWithdrawRefundReverts() public {
        // Create an outbid situation
        vm.prank(bidder1);
        auctionHouse.placeBid{value: 1 ether}(lotId);

        vm.prank(bidder2);
        auctionHouse.placeBid{value: 1.2 ether}(lotId);

        // bidder1 has 1 ether in refundable
        assertEq(auctionHouse.refundable(bidder1), 1 ether);

        // First withdrawal succeeds
        vm.prank(bidder1);
        auctionHouse.withdrawRefund();
        assertEq(auctionHouse.refundable(bidder1), 0);

        // Second withdrawal MUST revert with NoRefund
        vm.prank(bidder1);
        vm.expectRevert(AuctionHouse.NoRefund.selector);
        auctionHouse.withdrawRefund();
    }

    function test_AttackReentrancyOnWithdrawRefundBlocked() public {
        ReentrantAttacker badActor = new ReentrantAttacker(auctionHouse);
        vm.deal(address(badActor), 10 ether);

        // BadActor places bid and gets outbid
        vm.prank(address(badActor));
        auctionHouse.placeBid{value: 1 ether}(lotId);

        vm.prank(bidder2);
        auctionHouse.placeBid{value: 1.5 ether}(lotId);

        // Verify badActor has 1 ether refundable
        assertEq(auctionHouse.refundable(address(badActor)), 1 ether);

        // Attempt reentrant drain: reentrancy guard blocks reentrancy, causing call to fail and revert TransferFailed
        vm.expectRevert(AuctionHouse.TransferFailed.selector);
        badActor.attackWithdraw();
    }

    // ────────────────────────────────────────────────────────────────────────
    // 4. Anti-Snipe Extension Verification
    // ────────────────────────────────────────────────────────────────────────

    function test_AntiSnipeExtensionExactBoundary() public {
        (,,,,,uint64 initialEnd,,,,,,) = auctionHouse.lots(lotId);

        // Warp to 10 seconds before end (inside 300s window)
        vm.warp(initialEnd - 10);
        uint256 bidTime = block.timestamp;
        vm.prank(bidder1);
        auctionHouse.placeBid{value: 1 ether}(lotId);

        // End must be extended to bidTime + 300
        (,,,,,uint64 newEnd,,,,,,) = auctionHouse.lots(lotId);
        assertEq(newEnd, uint64(bidTime + 300));
        assertTrue(newEnd > initialEnd, "Auction end should have been extended");
    }

    // ────────────────────────────────────────────────────────────────────────
    // 5. Global Accounting Conservation Across Adversarial Actions
    // ────────────────────────────────────────────────────────────────────────

    function test_GlobalAccountingConservationUnderAdversarialConditions() public {
        // Multi-bidder competition
        vm.prank(bidder1);
        auctionHouse.placeBid{value: 1 ether}(lotId);

        vm.prank(bidder2);
        auctionHouse.placeBid{value: 1.2 ether}(lotId);

        vm.prank(attacker);
        auctionHouse.placeBid{value: 1.5 ether}(lotId);

        // bidder1 withdraws
        vm.prank(bidder1);
        auctionHouse.withdrawRefund();

        // Assert contract balance strictly equals remaining liabilities
        uint256 expectedLiabilities = auctionHouse.refundable(bidder2) + 1.5 ether; // bidder2 outbid + attacker active bid
        assertEq(address(auctionHouse).balance, expectedLiabilities);
    }
}
