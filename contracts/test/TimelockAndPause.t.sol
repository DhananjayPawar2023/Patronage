// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ArtworkNFT} from "../src/ArtworkNFT.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract TimelockAndPauseTest is Test {
    AuctionHouse internal auction;
    ArtworkNFT internal impl;
    ArtworkNFT internal nft;
    TimelockController internal timelock;

    address payable internal treasury = payable(address(0xBEEF));
    address internal guardian = address(0x1111); // Emergency Guardian (Fast-path)
    address internal proposer = address(0x2222); // Proposer for Timelock
    address internal seller = address(0x3333);
    address internal bidder = address(0x4444);

    uint256 internal constant INITIAL_FEE = 250; // 2.5%
    uint256 internal constant TIMELOCK_DELAY = 48 hours;

    function setUp() public {
        // 1. Deploy 48-hour TimelockController
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // Anyone can execute after delay

        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(this));

        // 2. Deploy AuctionHouse
        auction = new AuctionHouse(treasury, INITIAL_FEE, 900);

        // 3. Grant OPERATOR_ROLE to emergency guardian (fast path)
        auction.grantRole(auction.OPERATOR_ROLE(), guardian);

        // 4. Grant DEFAULT_ADMIN_ROLE to TimelockController (governance/parameter changes)
        auction.grantRole(auction.DEFAULT_ADMIN_ROLE(), address(timelock));

        // 5. Revoke deployer roles
        auction.renounceRole(auction.DEFAULT_ADMIN_ROLE(), address(this));
        auction.renounceRole(auction.OPERATOR_ROLE(), address(this));

        // 6. Setup NFT and create lot
        impl = new ArtworkNFT();
        nft = ArtworkNFT(Clones.clone(address(impl)));
        nft.initialize("Patron Art", "ART", seller, address(this), seller, 500);

        vm.startPrank(seller);
        nft.mint("local://meta.json");
        nft.approve(address(auction), 1);
        auction.createLot(address(nft), 1, 0.5 ether, 0.05 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days));
        vm.stopPrank();

        // 7. Fund bidder and place bid so refundable balance can be created
        vm.deal(bidder, 10 ether);
        vm.prank(bidder);
        auction.placeBid{value: 0.6 ether}(1);

        // Bidder 2 outbids bidder 1 to generate refundable balance
        address bidder2 = address(0x5555);
        vm.deal(bidder2, 10 ether);
        vm.prank(bidder2);
        auction.placeBid{value: 0.7 ether}(1);

        // Verify bidder 1 now has 0.6 ETH refundable
        assertEq(auction.refundable(bidder), 0.6 ether);
    }

    /// @notice Test that emergency pause() executes IMMEDIATELY without timelock delay
    function test_FastPathPauseExecutesImmediately() public {
        // Guardian can pause immediately
        vm.prank(guardian);
        auction.pause();

        assertTrue(auction.paused(), "Contract must be paused");

        // Subsequent bid must revert due to pause
        address bidder3 = address(0x6666);
        vm.deal(bidder3, 10 ether);
        vm.prank(bidder3);
        vm.expectRevert();
        auction.placeBid{value: 0.8 ether}(1);
    }

    /// @notice Test that withdrawRefund() STILL WORKS while the contract is paused
    function test_WithdrawRefundWorksWhilePaused() public {
        // 1. Pause contract
        vm.prank(guardian);
        auction.pause();
        assertTrue(auction.paused());

        // 2. Bidder pulls their refund while paused
        uint256 balanceBefore = bidder.balance;
        vm.prank(bidder);
        auction.withdrawRefund();
        uint256 balanceAfter = bidder.balance;

        assertEq(balanceAfter - balanceBefore, 0.6 ether, "Bidder must receive full refund even while paused");
        assertEq(auction.refundable(bidder), 0, "Refundable mapping must be cleared");
    }

    /// @notice Test that parameter/fee changes CANNOT be called directly by guardian or anyone else
    function test_ParameterChangeRequiresTimelock() public {
        // Direct call from guardian must revert (only Timelock has DEFAULT_ADMIN_ROLE)
        vm.prank(guardian);
        vm.expectRevert();
        auction.setProtocolFee(500);

        // Direct call from proposer must also revert
        vm.prank(proposer);
        vm.expectRevert();
        auction.setProtocolFee(500);
    }

    /// @notice Test that parameter changes succeed when routed through the 48-hour Timelock
    function test_ParameterChangeExecutesAfterTimelockDelay() public {
        bytes memory data = abi.encodeWithSelector(auction.setProtocolFee.selector, 500);
        bytes32 salt = bytes32(uint256(12345));

        // 1. Proposer schedules the transaction on TimelockController
        vm.prank(proposer);
        timelock.schedule(address(auction), 0, data, bytes32(0), salt, TIMELOCK_DELAY);

        // 2. Attempting to execute immediately must revert
        vm.expectRevert();
        timelock.execute(address(auction), 0, data, bytes32(0), salt);

        // 3. Fast-forward past the 48-hour delay
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1 seconds);

        // 4. Execute the timelocked call
        timelock.execute(address(auction), 0, data, bytes32(0), salt);

        // 5. Verify protocol fee was updated to 5.0% (500 BPS)
        assertEq(auction.protocolFeeBps(), 500, "Protocol fee must be updated after timelock delay");
    }
}
