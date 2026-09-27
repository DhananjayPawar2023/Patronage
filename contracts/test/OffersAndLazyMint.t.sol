// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ArtworkNFT} from "../src/ArtworkNFT.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract OffersAndLazyMintTest is Test, IERC721Receiver {
    AuctionHouse internal auction;
    ArtworkNFT internal impl;
    ArtworkNFT internal nft;

    address payable internal treasury = payable(address(0xBEEF));
    uint256 internal artistPk = 0xA11CE;
    address internal artist;
    address internal buyer = address(0x2222);
    address internal outbidder = address(0x3333);

    uint256 internal constant PROTOCOL_FEE = 250; // 2.5%
    uint256 internal constant ANTI_SNIPE = 300;   // 300s
    uint96 internal constant ROYALTY_BPS = 500;   // 5.0%

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}

    function setUp() public {
        artist = vm.addr(artistPk);
        auction = new AuctionHouse(treasury, PROTOCOL_FEE, ANTI_SNIPE);

        impl = new ArtworkNFT();
        nft = ArtworkNFT(Clones.clone(address(impl)));
        nft.initialize(
            "Patron Art",
            "PATRON",
            artist,
            address(auction),
            artist,
            ROYALTY_BPS
        );

        vm.deal(buyer, 10 ether);
        vm.deal(outbidder, 10 ether);
        vm.deal(artist, 1 ether);
    }

    function test_MakeAndCancelOffer() public {
        // Mint token to artist
        vm.prank(artist);
        uint256 tokenId = nft.mint("ipfs://token1");

        // Buyer makes offer
        vm.prank(buyer);
        auction.makeOffer{value: 0.5 ether}(address(nft), tokenId);

        (address offerBuyer, uint256 amount, uint64 createdAt, uint256 counterAmount) = auction.offers(address(nft), tokenId, buyer);
        assertEq(offerBuyer, buyer);
        assertEq(amount, 0.5 ether);
        assertEq(counterAmount, 0);
        assertGt(createdAt, 0);

        // Buyer cancels offer
        vm.prank(buyer);
        auction.cancelOffer(address(nft), tokenId);

        (, uint256 amountAfter,,) = auction.offers(address(nft), tokenId, buyer);
        assertEq(amountAfter, 0);
        assertEq(auction.refundable(buyer), 0.5 ether);

        // Buyer withdraws refund
        uint256 buyerBalanceBefore = buyer.balance;
        vm.prank(buyer);
        auction.withdrawRefund();
        assertEq(buyer.balance, buyerBalanceBefore + 0.5 ether);
    }

    function test_CounterOfferBySeller() public {
        vm.prank(artist);
        uint256 tokenId = nft.mint("ipfs://token2");

        // Buyer makes offer
        vm.prank(buyer);
        auction.makeOffer{value: 0.3 ether}(address(nft), tokenId);

        // Artist counters with 0.45 ETH
        vm.prank(artist);
        auction.counterOffer(address(nft), tokenId, buyer, 0.45 ether);

        (,,, uint256 counterAmount) = auction.offers(address(nft), tokenId, buyer);
        assertEq(counterAmount, 0.45 ether);

        // Non-seller cannot counter
        vm.expectRevert(AuctionHouse.NotSeller.selector);
        vm.prank(outbidder);
        auction.counterOffer(address(nft), tokenId, buyer, 0.4 ether);
    }

    function test_AcceptOfferOnUnauctionedToken() public {
        vm.prank(artist);
        uint256 tokenId = nft.mint("ipfs://token3");

        // Artist approves auction house
        vm.prank(artist);
        nft.setApprovalForAll(address(auction), true);

        // Buyer makes offer of 1 ETH
        vm.prank(buyer);
        auction.makeOffer{value: 1.0 ether}(address(nft), tokenId);

        uint256 artistBalBefore = artist.balance;
        uint256 treasuryBalBefore = treasury.balance;

        // Artist accepts offer
        vm.prank(artist);
        auction.acceptOffer(address(nft), tokenId, buyer);

        // Token belongs to buyer
        assertEq(nft.ownerOf(tokenId), buyer);

        // Protocol fee: 2.5% = 0.025 ETH
        assertEq(treasury.balance - treasuryBalBefore, 0.025 ether);

        // Artist gets royalty (5% = 0.05 ETH) + net sale (0.925 ETH) = 0.975 ETH
        assertEq(artist.balance - artistBalBefore, 0.975 ether);

        // Offer is cleared
        (, uint256 remainingAmount,,) = auction.offers(address(nft), tokenId, buyer);
        assertEq(remainingAmount, 0);
    }

    function test_AcceptOfferOnAuctionedTokenWithoutBids() public {
        vm.prank(artist);
        uint256 tokenId = nft.mint("ipfs://token4");

        vm.prank(artist);
        nft.approve(address(auction), tokenId);

        // Artist creates auction lot
        vm.prank(artist);
        uint256 lotId = auction.createLot(
            address(nft),
            tokenId,
            1.0 ether,
            0.1 ether,
            uint64(block.timestamp),
            uint64(block.timestamp + 86400)
        );

        // Buyer makes offer below reserve (0.6 ether)
        vm.prank(buyer);
        auction.makeOffer{value: 0.6 ether}(address(nft), tokenId);

        // Artist accepts offer
        vm.prank(artist);
        auction.acceptOffer(address(nft), tokenId, buyer);

        // Token transferred to buyer
        assertEq(nft.ownerOf(tokenId), buyer);

        // Lot marked settled
        (,, bool settled,,,,,,,,,) = auction.lots(lotId);
        assertTrue(settled);
    }

    function test_CannotAcceptOfferIfAuctionHasBids() public {
        vm.prank(artist);
        uint256 tokenId = nft.mint("ipfs://token5");

        vm.prank(artist);
        nft.approve(address(auction), tokenId);

        vm.prank(artist);
        uint256 lotId = auction.createLot(
            address(nft),
            tokenId,
            0.5 ether,
            0.05 ether,
            uint64(block.timestamp),
            uint64(block.timestamp + 86400)
        );

        // An outbidder places a valid bid meeting reserve
        vm.prank(outbidder);
        auction.placeBid{value: 0.5 ether}(lotId);

        // A buyer makes an offer
        vm.prank(buyer);
        auction.makeOffer{value: 0.8 ether}(address(nft), tokenId);

        // Artist trying to accept offer reverts because auction already has active bids
        vm.expectRevert(AuctionHouse.BidPlacedError.selector);
        vm.prank(artist);
        auction.acceptOffer(address(nft), tokenId, buyer);
    }

    function test_EIP712LazyMint() public {
        ArtworkNFT.NFTVoucher memory voucher = ArtworkNFT.NFTVoucher({
            nft: address(nft),
            tokenId: 10,
            minPrice: 0.25 ether,
            uri: "ipfs://bafybeilazymint10",
            artist: artist,
            nonce: 1001,
            deadline: block.timestamp + 1 hours
        });

        bytes32 digest = nft.hashVoucher(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(artistPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        uint256 artistBalBefore = artist.balance;

        // Collector redeems voucher paying 0.25 ETH
        vm.prank(buyer);
        uint256 mintedId = nft.mintWithVoucher{value: 0.25 ether}(voucher, signature);

        assertEq(mintedId, 10);
        assertEq(nft.ownerOf(10), buyer);
        assertEq(nft.tokenURI(10), "ipfs://bafybeilazymint10");
        assertEq(artist.balance - artistBalBefore, 0.25 ether);

        // Replay of same voucher reverts
        vm.expectRevert(ArtworkNFT.VoucherAlreadyRedeemed.selector);
        vm.prank(buyer);
        nft.mintWithVoucher{value: 0.25 ether}(voucher, signature);
    }

    function test_ExpiredVoucherReverts() public {
        ArtworkNFT.NFTVoucher memory voucher = ArtworkNFT.NFTVoucher({
            nft: address(nft),
            tokenId: 15,
            minPrice: 0.25 ether,
            uri: "ipfs://bafybeilazymint15",
            artist: artist,
            nonce: 1005,
            deadline: block.timestamp + 100
        });

        bytes32 digest = nft.hashVoucher(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(artistPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Warp time past deadline
        vm.warp(block.timestamp + 101);

        vm.expectRevert(ArtworkNFT.VoucherExpired.selector);
        vm.prank(buyer);
        nft.mintWithVoucher{value: 0.25 ether}(voucher, signature);
    }

    function test_ZeroDeadlineVoucherReverts() public {
        ArtworkNFT.NFTVoucher memory voucher = ArtworkNFT.NFTVoucher({
            nft: address(nft),
            tokenId: 16,
            minPrice: 0.25 ether,
            uri: "ipfs://bafybeilazymint16",
            artist: artist,
            nonce: 1006,
            deadline: 0
        });

        bytes32 digest = nft.hashVoucher(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(artistPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert(ArtworkNFT.VoucherExpired.selector);
        vm.prank(buyer);
        nft.mintWithVoucher{value: 0.25 ether}(voucher, signature);
    }

    function test_VoucherWrongSignerReverts() public {
        ArtworkNFT.NFTVoucher memory voucher = ArtworkNFT.NFTVoucher({
            nft: address(nft),
            tokenId: 17,
            minPrice: 0.25 ether,
            uri: "ipfs://bafybeilazymint17",
            artist: artist,
            nonce: 1007,
            deadline: block.timestamp + 1 hours
        });

        bytes32 digest = nft.hashVoucher(voucher);
        // Signed by attacker (outbidder) instead of artist
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEADBEEF, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert(ArtworkNFT.InvalidSignature.selector);
        vm.prank(buyer);
        nft.mintWithVoucher{value: 0.25 ether}(voucher, signature);
    }

    function test_VoucherWrongArtistReverts() public {
        ArtworkNFT.NFTVoucher memory voucher = ArtworkNFT.NFTVoucher({
            nft: address(nft),
            tokenId: 18,
            minPrice: 0.25 ether,
            uri: "ipfs://bafybeilazymint18",
            artist: address(0x9999), // wrong artist (not creator of collection)
            nonce: 1008,
            deadline: block.timestamp + 1 hours
        });

        bytes32 digest = nft.hashVoucher(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(artistPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert(ArtworkNFT.InvalidVoucher.selector);
        vm.prank(buyer);
        nft.mintWithVoucher{value: 0.25 ether}(voucher, signature);
    }

    function test_VoucherWrongNftReverts() public {
        ArtworkNFT.NFTVoucher memory voucher = ArtworkNFT.NFTVoucher({
            nft: address(0x8888), // wrong nft contract
            tokenId: 19,
            minPrice: 0.25 ether,
            uri: "ipfs://bafybeilazymint19",
            artist: artist,
            nonce: 1009,
            deadline: block.timestamp + 1 hours
        });

        bytes32 digest = nft.hashVoucher(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(artistPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert(ArtworkNFT.InvalidVoucher.selector);
        vm.prank(buyer);
        nft.mintWithVoucher{value: 0.25 ether}(voucher, signature);
    }

    function test_LazyMintUnderpricedFails() public {
        ArtworkNFT.NFTVoucher memory voucher = ArtworkNFT.NFTVoucher({
            nft: address(nft),
            tokenId: 11,
            minPrice: 0.5 ether,
            uri: "ipfs://bafybeilazymint11",
            artist: artist,
            nonce: 1002,
            deadline: block.timestamp + 1 hours
        });

        bytes32 digest = nft.hashVoucher(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(artistPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        // Collector tries paying 0.4 ETH (less than 0.5 ETH minPrice)
        vm.expectRevert(ArtworkNFT.InsufficientPayment.selector);
        vm.prank(buyer);
        nft.mintWithVoucher{value: 0.4 ether}(voucher, signature);
    }

    function test_ImplementationCannotBeInitialized() public {
        vm.expectRevert(ArtworkNFT.AlreadyInitialized.selector);
        impl.initialize("Attacker", "ATT", address(0x999), address(auction), address(0x999), 500);
    }

    function test_CloneCannotBeInitializedTwice() public {
        vm.expectRevert(ArtworkNFT.AlreadyInitialized.selector);
        nft.initialize("Second", "SEC", artist, address(auction), artist, 500);
    }

    function test_CloneRolesAndRoyaltyAssigned() public view {
        assertTrue(nft.hasRole(nft.DEFAULT_ADMIN_ROLE(), artist));
        assertTrue(nft.hasRole(nft.MINTER_ROLE(), artist));
        assertTrue(nft.hasRole(nft.MINTER_ROLE(), address(auction)));
        assertEq(nft.creator(), artist);

        (address receiver, uint256 royaltyAmount) = nft.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
        assertEq(royaltyAmount, 0.05 ether); // 500 bps = 5%
    }
}
