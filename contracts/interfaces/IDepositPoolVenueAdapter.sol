// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal boundary between DepositPool and a clock-controlled venue lane.
/// @dev Packet 1 defines the hook only. A production implementation and venue wiring
///      belong to packet 2.
interface IDepositPoolVenueAdapter {
    function asset() external view returns (address);

    /// @notice Assets currently managed for one pool, including venue yield or loss.
    function managedAssets(address pool) external view returns (uint256);

    /// @notice Account for assets already transferred by the pool and bind them to
    ///         the pool-selected return deadline.
    function deploy(uint256 assets, uint64 returnBy) external;

    /// @notice Return at least the requested assets to the calling pool.
    function recall(uint256 assets) external returns (uint256 returnedAssets);
}
