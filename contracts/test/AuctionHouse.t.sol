// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ArtworkNFT} from "../src/ArtworkNFT.sol";
import {PatronEdition} from "../src/PatronEdition.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract ReceiverContract is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
    receive() external payable {}
}

contract RevertingReceiver {
    // Reverts on ETH receipt to test pull payment fallback
    receive() external payable {
        revert("ETH rejected");
    }
}

contract AuctionHouseTest is Test {
    AuctionHouse internal auction;
    ArtworkNFT internal nft;
    PatronEdition internal edition;
    ReceiverContract internal receiver;
    RevertingReceiver internal revertingSeller;

    address payable internal treasury = payable(address(0xBEEF));
    address internal seller = address(0x1111);
    address internal bidder1 = address(0x2222);
    address internal bidder2 = address(0x3333);

    uint256 internal constant PROTOCOL_FEE = 250; // 2.5%
    uint256 internal constant ANTI_SNIPE = 300;   // 300s

    function setUp() public {
        auction = new AuctionHouse(treasury, PROTOCOL_FEE, ANTI_SNIPE);
        nft = new ArtworkNFT();
        edition = new PatronEdition("local://patron/", address(this), 0.1 ether);
        auction.setPatronEdition(address(edition));
        edition.grantRole(edition.AUCTION_ROLE(), address(auction));
        receiver = new ReceiverContract();
        revertingSeller = new RevertingReceiver();

        nft.initialize("Test Art", "ART", seller, address(this), seller, 500);

        vm.startPrank(seller);
        nft.mint("local://nft/1.json");
        nft.approve(address(auction), 1);
        vm.stopPrank();
    }

    function test_ProtocolFeeConfigured() public view {
        assertEq(auction.protocolFeeBps(), PROTOCOL_FEE);
        assertEq(auction.antiSnipeWindow(), ANTI_SNIPE);
    }

    function test_CreateLot() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);

        vm.prank(seller);
        uint256 lotId = auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);

        assertEq(lotId, 1);
        assertEq(nft.ownerOf(1), address(auction));
    }

    function test_PatronEditionMintDuringLiveLot() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);

        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);

        vm.deal(bidder1, 1 ether);
        vm.prank(bidder1);
        auction.mintPatronEdition{value: 0.1 ether}(1);

        assertEq(edition.balanceOf(bidder1, edition.EDITION_ID()), 1);
        assertEq(address(edition).balance, 0.1 ether);
    }

    function testFuzz_PlaceBid(uint96 bidAmount) public {
        vm.assume(bidAmount >= 0.1 ether && bidAmount <= 1000 ether);

        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);

        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);

        vm.deal(bidder1, bidAmount);
        vm.prank(bidder1);
        auction.placeBid{value: bidAmount}(1);

        assertEq(address(auction).balance, bidAmount);
    }

    function testFuzz_OutbidRefund(uint96 bid1, uint96 bid2) public {
        uint256 firstBid = bound(uint256(bid1), 0.1 ether, 10 ether);
        uint256 secondBid = bound(uint256(bid2), firstBid + 0.01 ether, 20 ether);

        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);

        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);

        // Bidder 1
        vm.deal(bidder1, firstBid);
        vm.prank(bidder1);
        auction.placeBid{value: firstBid}(1);

        // Bidder 2 outbids
        vm.deal(bidder2, secondBid);
        vm.prank(bidder2);
        auction.placeBid{value: secondBid}(1);

        // Check refundable
        assertEq(auction.refundable(bidder1), firstBid);

        // Withdraw refund
        uint256 initialBal = bidder1.balance;
        vm.prank(bidder1);
        auction.withdrawRefund();

        assertEq(bidder1.balance, initialBal + firstBid);
        assertEq(auction.refundable(bidder1), 0);
    }

    function test_SettleSuccessfulAuction() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);

        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);

        vm.deal(bidder1, 1 ether);
        vm.prank(bidder1);
        auction.placeBid{value: 1 ether}(1);

        // Fast forward past end
        vm.warp(block.timestamp + 1 days + 1);

        auction.settle(1);

        assertEq(nft.ownerOf(1), bidder1);
    }

    function test_DirectETHReverts() public {
        vm.deal(bidder1, 1 ether);
        vm.prank(bidder1);
        (bool ok, ) = address(auction).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_NoBidSettlementReturnsNFT() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);
        vm.warp(end + 1);
        auction.settle(1);
        assertEq(nft.ownerOf(1), seller);
        vm.expectRevert(AuctionHouse.InvalidLot.selector);
        auction.settle(1);
    }

    function test_CancelBeforeBidReturnsNFT() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);
        vm.prank(seller);
        auction.cancel(1);
        assertEq(nft.ownerOf(1), seller);
        vm.expectRevert(AuctionHouse.NotSeller.selector);
        vm.prank(seller);
        auction.cancel(1);
    }

    function test_ExpiredLotRejectsBid() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 hours);
        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);
        vm.warp(end);
        vm.deal(bidder1, 1 ether);
        vm.expectRevert(AuctionHouse.AuctionNotLive.selector);
        vm.prank(bidder1);
        auction.placeBid{value: 0.1 ether}(1);
    }

    function test_DuplicatePatronEditionMintRejected() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);
        vm.deal(bidder1, 1 ether);
        vm.startPrank(bidder1);
        auction.mintPatronEdition{value: 0.1 ether}(1);
        vm.expectRevert();
        auction.mintPatronEdition{value: 0.1 ether}(1);
        vm.stopPrank();
    }

    function test_InvalidBidIncrementRejected() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        auction.createLot(address(nft), 1, 0.1 ether, 0.01 ether, start, end);
        vm.deal(bidder1, 1 ether);
        vm.expectRevert(AuctionHouse.BidTooLow.selector);
        vm.prank(bidder1);
        auction.placeBid{value: 0.099 ether}(1);
    }

    function test_ZeroAddressConstructorAndConfigurationRejected() public {
        vm.expectRevert(AuctionHouse.InvalidFee.selector);
        new AuctionHouse(payable(address(0)), 0, 0);
        vm.expectRevert(AuctionHouse.InvalidFee.selector);
        auction.setProtocolTreasury(payable(address(0)));
        vm.expectRevert(AuctionHouse.InvalidFee.selector);
        auction.setProtocolFee(10_001);
        vm.expectRevert(AuctionHouse.InvalidLot.selector);
        auction.setPatronEdition(address(0));
    }

    function test_PaymentFailureBecomesRecoverableRefund() public {
        AuctionHouse failingAuction = new AuctionHouse(payable(address(revertingSeller)), PROTOCOL_FEE, ANTI_SNIPE);
        ArtworkNFT nft2 = new ArtworkNFT();
        nft2.initialize("Second Art", "ART2", seller, address(this), seller, 500);
        vm.startPrank(seller);
        nft2.mint("local://nft/2.json");
        nft2.approve(address(failingAuction), 1);
        failingAuction.createLot(address(nft2), 1, 0.1 ether, 0.01 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days));
        vm.stopPrank();
        vm.deal(bidder1, 1 ether);
        vm.prank(bidder1);
        failingAuction.placeBid{value: 1 ether}(1);
        vm.warp(block.timestamp + 1 days + 1);
        failingAuction.settle(1);
        assertGt(failingAuction.refundable(address(revertingSeller)), 0);
    }

    function test_BuyNowInstantSettlement() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        auction.createLotWithBuyNow(address(nft), 1, 0.1 ether, 0.01 ether, start, end, 0.5 ether);

        vm.deal(bidder1, 1 ether);
        vm.prank(bidder1);
        auction.buyNow{value: 0.5 ether}(1);

        assertEq(nft.ownerOf(1), bidder1);
        (,,bool settled,,,,,,,,,) = auction.lots(1);
        assertTrue(settled);
    }

    function test_BuyNowRefundsPreviousBidder() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        auction.createLotWithBuyNow(address(nft), 1, 0.1 ether, 0.01 ether, start, end, 0.5 ether);

        vm.deal(bidder1, 1 ether);
        vm.prank(bidder1);
        auction.placeBid{value: 0.2 ether}(1);

        vm.deal(bidder2, 1 ether);
        vm.prank(bidder2);
        auction.buyNow{value: 0.5 ether}(1);

        assertEq(nft.ownerOf(1), bidder2);
        assertEq(auction.refundable(bidder1), 0.2 ether);
    }

    function invariant_EscrowCoversRefundableFunds() public view {
        uint256 refundableTotal = auction.refundable(bidder1) + auction.refundable(bidder2);
        assertGe(address(auction).balance, refundableTotal);
    }
}
