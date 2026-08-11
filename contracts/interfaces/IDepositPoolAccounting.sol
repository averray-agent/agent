// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Cash-accounting callback exposed only to a DepositPool's immutable adapter.
interface IDepositPoolAccounting {
    /// @dev The adapter must call this only after `assets` USDC has been transferred
    ///      into the pool buffer. Remote inventory assertions never call it.
    function recordVenueReturn(bytes32 adapterRequestId, uint256 assets) external;
}
