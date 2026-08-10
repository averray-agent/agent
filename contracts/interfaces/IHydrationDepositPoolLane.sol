// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {IXcmV22CustodyAdapter} from "./IXcmV22CustodyAdapter.sol";

/// @notice Exact async surface consumed from a dedicated HydrationUsdcAdapterV22.
interface IHydrationDepositPoolLane {
    function policy() external view returns (TreasuryPolicy);
    function asset() external view returns (address);
    function agentAccountCore() external view returns (address);
    function totalAssets() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function pendingDepositAssets() external view returns (uint256);
    function requiresRemoteRecovery(bytes32 requestId) external view returns (bool);
    function recoveryAssetsOutstanding(bytes32 requestId) external view returns (uint256);

    function requestDeposit(
        address account,
        uint256 assets,
        uint256 sellAmount,
        uint256 minimumShares,
        uint256 maxFeePerLeg,
        uint64 dispatchDeadline,
        uint64 nonce
    ) external returns (bytes32 requestId);

    function requestWithdraw(
        address account,
        uint256 shares,
        address recipient,
        uint256 minimumAssets,
        uint256 remoteFeeBudget,
        uint64 dispatchDeadline,
        uint64 nonce
    ) external returns (bytes32 requestId);

    function getAdapterRequest(bytes32 requestId) external view returns (IXcmV22CustodyAdapter.AdapterRequest memory);

    function releaseRecoveredAssets(bytes32 requestId, address recipient, uint256 assets) external;
}
