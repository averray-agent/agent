// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXcmStrategyAdapter} from "./IXcmStrategyAdapter.sol";

/**
 * @notice Request-scoped custody hook used by XcmWrapperV2.
 *
 * The wrapper never receives an open allowance. It asks the registered adapter
 * to release the exact assets committed by one already-recorded request.
 */
interface IXcmV2CustodyAdapter is IXcmStrategyAdapter {
    function releaseAssetsToWrapper(bytes32 requestId, uint256 assets) external;

    function requiresRemoteRecovery(bytes32 requestId) external view returns (bool);

    function releaseRecoveredAssets(bytes32 requestId, address recipient, uint256 assets) external;
}
