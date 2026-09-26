// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Treasury
/// @notice Holds protocol ETH and allows governed withdrawals.
contract Treasury is AccessControl {
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    error TransferFailed();
    event Withdrawal(address indexed recipient, uint256 amount);
    constructor(address admin) { _grantRole(DEFAULT_ADMIN_ROLE, admin); _grantRole(TREASURER_ROLE, admin); }
    function withdraw(address payable recipient, uint256 amount) external onlyRole(TREASURER_ROLE) { (bool ok,) = recipient.call{value: amount}(""); if (!ok) revert TransferFailed(); emit Withdrawal(recipient, amount); }
    receive() external payable {}
}
