// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStrategyAdapter} from "./IStrategyAdapter.sol";
import {IXcmWrapper} from "./IXcmWrapper.sol";
import {IXcmWrapperV22} from "./IXcmWrapperV22.sol";

interface IXcmV22CustodyAdapter is IStrategyAdapter {
    struct AdapterRequest {
        IXcmWrapper.RequestKind kind;
        IXcmWrapper.RequestStatus status;
        address account;
        address requester;
        address recipient;
        uint256 requestedAssets;
        uint256 requestedShares;
        uint256 settledAssets;
        uint256 settledShares;
        bytes32 remoteRef;
        bytes32 failureCode;
        bool settled;
    }

    function pendingDepositAssets() external view returns (uint256);

    function pendingWithdrawalShares() external view returns (uint256);

    function releaseAssetsToWrapper(bytes32 requestId, uint256 assets) external;

    function requiresRemoteRecovery(bytes32 requestId) external view returns (bool);

    function recoveryAssetsOutstanding(bytes32 requestId) external view returns (uint256);

    function releaseRecoveredAssets(bytes32 requestId, address recipient, uint256 assets) external;

    function getAdapterRequest(bytes32 requestId) external view returns (AdapterRequest memory);

    function xcmWrapper() external view returns (IXcmWrapperV22);
}
