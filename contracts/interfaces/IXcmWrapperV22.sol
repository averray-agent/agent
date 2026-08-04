// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IXcmWrapper} from "./IXcmWrapper.sol";

/**
 * @notice Constructive, parameter-staged XCM transport used by Bank v2.2.
 * @dev No mutating function accepts caller-supplied destination or message
 *      bytes. The wrapper is the only XCM message constructor.
 */
interface IXcmWrapperV22 {
    enum DispatchLeg {
        DepositFunding,
        DepositSell,
        WithdrawSell,
        WithdrawHome
    }

    struct RequestParameters {
        /// @dev Router input. For Withdraw this must equal context.shares.
        uint256 sellAmount;
        /// @dev Router minimum output and the request-bound amount returned home.
        uint256 minimumOutput;
        /// @dev Upper bound on the fresh dispatch-time asset-22 budget supplied
        ///      to DepositSell or WithdrawSell. WithdrawHome is self-budgeting.
        uint256 maxFeePerLeg;
        /// @dev Zero disables the deadline. A non-zero deadline blocks only
        ///      undispatched request legs, never terminalization or recovery.
        uint64 dispatchDeadline;
    }

    struct LegRecord {
        bytes32 destinationHash;
        bytes32 messageHash;
        uint64 refTime;
        uint64 proofSize;
        bool dispatched;
    }

    event RequestParametersStored(
        bytes32 indexed requestId,
        uint256 sellAmount,
        uint256 minimumOutput,
        uint256 maxFeePerLeg,
        uint64 dispatchDeadline
    );
    event RequestLegDispatched(
        bytes32 indexed requestId,
        DispatchLeg indexed leg,
        address indexed caller,
        bytes32 destinationHash,
        bytes32 messageHash,
        uint256 feeAmount
    );

    function xcmPrecompile() external view returns (address);

    function previewRequestId(IXcmWrapper.RequestContext calldata context) external pure returns (bytes32 requestId);

    function queueRequest(IXcmWrapper.RequestContext calldata context, RequestParameters calldata parameters)
        external
        returns (bytes32 requestId);

    function dispatchLeg(bytes32 requestId, DispatchLeg leg, uint256 feeAmount) external;

    function previewLegMessage(bytes32 requestId, DispatchLeg leg, uint256 feeAmount)
        external
        view
        returns (bytes memory destination, bytes memory message, IXcmWrapper.Weight memory maxWeight);

    function finalizeRequest(
        bytes32 requestId,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external;

    function getRequest(bytes32 requestId) external view returns (IXcmWrapper.RequestRecord memory);

    function getRequestParameters(bytes32 requestId) external view returns (RequestParameters memory);

    function previewRecoveryHomeId(bytes32 requestId, uint256 amount, uint64 nonce)
        external
        view
        returns (bytes32 recoveryId);

    function previewRecoveryHomeMessage(bytes32 requestId, uint256 amount, uint64 nonce)
        external
        view
        returns (bytes memory destination, bytes memory message);

    function dispatchRecoveryHome(bytes32 requestId, uint256 amount, uint64 nonce) external returns (bytes32 recoveryId);

    function releaseRecoveredAssetsToAdapter(bytes32 requestId, uint256 assets) external;
}
