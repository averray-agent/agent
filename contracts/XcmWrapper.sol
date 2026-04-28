// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {IXcmWrapper} from "./interfaces/IXcmWrapper.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

/**
 * @title XcmWrapper
 * @notice Durable async request ledger for Polkadot Hub XCM-backed flows.
 *
 * This first implementation is intentionally transport-light. It gives
 * the platform the missing async state machine:
 *   - deterministic request ids
 *   - idempotent queue/finalize semantics
 *   - durable request records for indexers and recovery workflows
 *   - payload-hash tracking so retries cannot silently mutate the queued
 *     destination or message under the same request id
 *
 * Actual XCM dispatch can be layered in later without changing the core
 * request lifecycle contract between adapters, backend services, and
 * indexers.
 */
contract XcmWrapper is IXcmWrapper, ReentrancyGuard {
    address public constant DEFAULT_XCM_PRECOMPILE = 0x00000000000000000000000000000000000a0000;
    bytes1 internal constant XCM_SET_TOPIC_INSTRUCTION = 0x2c;
    uint256 internal constant XCM_SET_TOPIC_SUFFIX_LENGTH = 33;

    TreasuryPolicy public immutable policy;
    address public immutable override xcmPrecompile;

    mapping(bytes32 => RequestRecord) internal requests;
    mapping(bytes32 => bytes32) public requestDestinationHash;
    mapping(bytes32 => bytes32) public requestMessageHash;

    event RequestPayloadStored(
        bytes32 indexed requestId, bytes32 destinationHash, bytes32 messageHash, uint64 refTime, uint64 proofSize
    );

    error Unauthorized();
    error ProtocolPaused();
    error UnknownRequest();
    error InvalidRequest();
    error InvalidStatus();
    error InvalidTransition();
    error InvalidSetTopic();
    error PayloadMismatch();

    constructor(TreasuryPolicy policy_, address xcmPrecompile_) {
        policy = policy_;
        xcmPrecompile = xcmPrecompile_ == address(0) ? DEFAULT_XCM_PRECOMPILE : xcmPrecompile_;
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != policy.owner() && !policy.serviceOperators(msg.sender)) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (policy.paused()) revert ProtocolPaused();
        _;
    }

    function previewRequestId(RequestContext calldata context) public pure override returns (bytes32 requestId) {
        return keccak256(
            abi.encode(
                context.strategyId,
                context.kind,
                context.account,
                context.asset,
                context.recipient,
                context.assets,
                context.shares,
                context.nonce
            )
        );
    }

    function weighMessage(bytes calldata message) external view override returns (Weight memory weight) {
        if (xcmPrecompile.code.length == 0) {
            return Weight({refTime: 0, proofSize: 0});
        }

        (bool ok, bytes memory data) = xcmPrecompile.staticcall(abi.encodeWithSignature("weighMessage(bytes)", message));
        if (!ok || data.length == 0) {
            return Weight({refTime: 0, proofSize: 0});
        }

        return abi.decode(data, (Weight));
    }

    function queueRequest(
        RequestContext calldata context,
        bytes calldata destination,
        bytes calldata message,
        Weight calldata maxWeight
    ) external override nonReentrant whenNotPaused onlyOwnerOrOperator returns (bytes32 requestId) {
        _validateRequestContext(context);

        requestId = previewRequestId(context);
        _validateSetTopic(message, requestId);

        bytes32 destinationHash = keccak256(destination);
        bytes32 messageHash = keccak256(message);

        RequestRecord storage existing = requests[requestId];
        if (existing.context.account != address(0)) {
            if (requestDestinationHash[requestId] != destinationHash || requestMessageHash[requestId] != messageHash) {
                revert PayloadMismatch();
            }
            return requestId;
        }

        requests[requestId] = RequestRecord({
            context: RequestContext({
                strategyId: context.strategyId,
                kind: context.kind,
                account: context.account,
                asset: context.asset,
                recipient: context.recipient,
                assets: context.assets,
                shares: context.shares,
                nonce: context.nonce
            }),
            status: RequestStatus.Pending,
            settledAssets: 0,
            settledShares: 0,
            remoteRef: bytes32(0),
            failureCode: bytes32(0),
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        requestDestinationHash[requestId] = destinationHash;
        requestMessageHash[requestId] = messageHash;

        _emitQueuedEvents(requestId, context, destinationHash, messageHash, maxWeight);
    }

    function finalizeRequest(
        bytes32 requestId,
        RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external override nonReentrant whenNotPaused onlyOwnerOrOperator {
        if (status == RequestStatus.Unknown || status == RequestStatus.Pending) {
            revert InvalidStatus();
        }

        RequestRecord storage record = requests[requestId];
        if (record.context.account == address(0)) revert UnknownRequest();

        if (record.status == RequestStatus.Pending) {
            record.status = status;
            record.settledAssets = settledAssets;
            record.settledShares = settledShares;
            record.remoteRef = remoteRef;
            record.failureCode = failureCode;
            record.updatedAt = uint64(block.timestamp);
            emit RequestStatusUpdated(requestId, status, settledAssets, settledShares, remoteRef, failureCode);
            return;
        }

        if (
            record.status == status && record.settledAssets == settledAssets && record.settledShares == settledShares
                && record.remoteRef == remoteRef && record.failureCode == failureCode
        ) {
            return;
        }

        revert InvalidTransition();
    }

    function getRequest(bytes32 requestId) external view override returns (RequestRecord memory) {
        return requests[requestId];
    }

    function _emitQueuedEvents(
        bytes32 requestId,
        RequestContext calldata context,
        bytes32 destinationHash,
        bytes32 messageHash,
        Weight calldata maxWeight
    ) internal {
        emit RequestQueued(
            requestId,
            context.strategyId,
            context.kind,
            context.account,
            context.asset,
            context.recipient,
            context.assets,
            context.shares,
            context.nonce
        );
        emit RequestPayloadStored(requestId, destinationHash, messageHash, maxWeight.refTime, maxWeight.proofSize);
    }

    function _validateRequestContext(RequestContext calldata context) internal pure {
        if (
            context.strategyId == bytes32(0) || context.account == address(0) || context.asset == address(0)
                || context.recipient == address(0)
        ) revert InvalidRequest();
        if (context.assets == 0 && context.shares == 0) revert InvalidRequest();
    }

    function _validateSetTopic(bytes calldata message, bytes32 requestId) internal pure {
        if (message.length < XCM_SET_TOPIC_SUFFIX_LENGTH) revert InvalidSetTopic();
        if (message[message.length - XCM_SET_TOPIC_SUFFIX_LENGTH] != XCM_SET_TOPIC_INSTRUCTION) {
            revert InvalidSetTopic();
        }

        bytes32 topic;
        assembly {
            topic := calldataload(add(message.offset, sub(message.length, 32)))
        }
        if (topic != requestId) revert InvalidSetTopic();
    }
}
