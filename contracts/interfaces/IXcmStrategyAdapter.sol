// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStrategyAdapter} from "./IStrategyAdapter.sol";
import {IXcmWrapper} from "./IXcmWrapper.sol";

interface IXcmStrategyAdapter is IStrategyAdapter {
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

    function requestDeposit(
        address account,
        uint256 assets,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external returns (bytes32 requestId);

    function requestWithdraw(
        address account,
        uint256 shares,
        address recipient,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external returns (bytes32 requestId);

    function settleRequest(
        bytes32 requestId,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external;

    function getAdapterRequest(bytes32 requestId) external view returns (AdapterRequest memory);
}
