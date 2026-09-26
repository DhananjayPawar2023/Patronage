// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PatronEdition} from "../src/PatronEdition.sol";

contract PatronEditionTest is Test {
    PatronEdition internal edition;
    address internal admin = address(0xA001);
    address internal auctioneer = address(0xA002);
    address internal user = address(0xA003);
    address payable internal treasury = payable(address(0xA004));
    uint256 internal constant MINT_PRICE = 0.1 ether;
    uint256 internal constant LOT_ID = 1;

    function setUp() public {
        edition = new PatronEdition("local://patron/", admin, MINT_PRICE);
        
        vm.startPrank(admin);
        edition.grantRole(edition.AUCTION_ROLE(), auctioneer);
        vm.stopPrank();
    }

    function test_MintAndWithdraw() public {
        // Set lot live
        vm.prank(auctioneer);
        edition.setLotLive(LOT_ID, true);

        // Mint
        vm.deal(user, 1 ether);
        // The auction house role performs the mint for the recipient.
        vm.deal(auctioneer, 1 ether);
        vm.prank(auctioneer);
        edition.mint{value: MINT_PRICE}(LOT_ID, user);

        assertEq(address(edition).balance, MINT_PRICE);

        // Withdraw by admin
        uint256 initialTreasuryBalance = treasury.balance;
        
        vm.prank(admin);
        edition.withdraw(treasury);

        assertEq(address(edition).balance, 0);
        assertEq(treasury.balance, initialTreasuryBalance + MINT_PRICE);
    }

    function test_RevertIfNonAdminWithdraws() public {
        vm.deal(auctioneer, 1 ether);
        vm.prank(auctioneer);
        edition.setLotLive(LOT_ID, true);

        vm.prank(auctioneer);
        edition.mint{value: MINT_PRICE}(LOT_ID, user);

        vm.prank(user);
        vm.expectRevert();
        edition.withdraw(treasury);
    }
}
