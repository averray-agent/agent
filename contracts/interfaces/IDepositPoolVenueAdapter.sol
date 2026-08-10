// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Async boundary between DepositPool and one immutable venue lane.
/// @dev Hydration movement is request/dispatch/observe/settle. Exposing a
///      synchronous deploy or recall would falsely report remote movement as
///      complete in the staging transaction.
interface IDepositPoolVenueAdapter {
    enum RequestKind {
        Deploy,
        Recall
    }

    enum RequestStatus {
        None,
        Pending,
        Succeeded,
        Failed
    }

    struct Request {
        RequestKind kind;
        RequestStatus status;
        uint256 requestedAssets;
        uint256 settledAssets;
        uint64 returnBy;
        bool claimed;
    }

    function asset() external view returns (address);

    /// @notice Pool assets in local custody, in flight, or observed at venue.
    function managedAssets(address pool) external view returns (uint256);

    /// @notice Accept assets already transferred by the pool into an async lane.
    function requestDeploy(uint256 assets, uint64 returnBy) external returns (bytes32 requestId);

    /// @notice Request assets back before the deployment's pool-derived deadline.
    function requestRecall(uint256 assets, uint64 returnBy) external returns (bytes32 requestId);

    function getRequest(bytes32 requestId) external view returns (Request memory);

    /// @notice Finalize a terminal request. Recall assets are transferred to the pool here.
    function claimSettled(bytes32 requestId) external returns (uint256 settledAssets);
}
