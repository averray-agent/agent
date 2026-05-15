// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {IXcmWrapper} from "./interfaces/IXcmWrapper.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

interface IXcmPrecompile {
    function send(bytes calldata destination, bytes calldata message) external;
    function weighMessage(bytes calldata message) external view returns (IXcmWrapper.Weight memory);
}

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
 * queueRequest relays the validated payload to the Hub XCM precompile and
 * records a durable lifecycle entry only when that dispatch path succeeds.
 */
contract XcmWrapper is IXcmWrapper, ReentrancyGuard {
    address public constant DEFAULT_XCM_PRECOMPILE = 0x00000000000000000000000000000000000a0000;
    bytes1 internal constant XCM_VERSION_V5 = 0x05;
    bytes1 internal constant XCM_INSTRUCTION_WITHDRAW_ASSET = 0x00;
    bytes1 internal constant XCM_INSTRUCTION_DEPOSIT_ASSET = 0x0d;
    bytes1 internal constant XCM_INSTRUCTION_PAY_FEES = 0x13;
    bytes1 internal constant XCM_SET_TOPIC_INSTRUCTION = 0x2c;
    uint256 internal constant XCM_MIN_VERSIONED_SET_TOPIC_LENGTH = 35;

    TreasuryPolicy public immutable policy;
    address public immutable override xcmPrecompile;

    mapping(bytes32 => RequestRecord) internal requests;
    mapping(bytes32 => bytes32) public requestDestinationHash;
    mapping(bytes32 => bytes32) public requestMessageHash;

    error Unauthorized();
    error ProtocolPaused();
    error UnknownRequest();
    error InvalidRequest();
    error InvalidStatus();
    error InvalidTransition();
    error InvalidSetTopic();
    error InvalidWeight();
    error PayloadMismatch();
    error XcmDispatchFailed(bytes reason);

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
        (bool ok, bytes memory data) = xcmPrecompile.staticcall(abi.encodeCall(IXcmPrecompile.weighMessage, (message)));
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
        _validateWeight(maxWeight);

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

        _dispatchXcm(destination, message);
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
        emit RequestDispatched(requestId, xcmPrecompile, destinationHash, messageHash);
    }

    function _dispatchXcm(bytes calldata destination, bytes calldata message) internal {
        (bool ok, bytes memory data) = xcmPrecompile.call(abi.encodeCall(IXcmPrecompile.send, (destination, message)));
        if (!ok) revert XcmDispatchFailed(data);
    }

    function _validateRequestContext(RequestContext calldata context) internal pure {
        if (
            context.strategyId == bytes32(0) || context.account == address(0) || context.asset == address(0)
                || context.recipient == address(0)
        ) revert InvalidRequest();
        if (context.assets == 0 && context.shares == 0) revert InvalidRequest();
    }

    function _validateWeight(Weight calldata maxWeight) internal pure {
        if (maxWeight.refTime == 0) revert InvalidWeight();
    }

    function _validateSetTopic(bytes calldata message, bytes32 requestId) internal pure {
        if (message.length < XCM_MIN_VERSIONED_SET_TOPIC_LENGTH) revert InvalidSetTopic();
        if (message[0] != XCM_VERSION_V5) revert InvalidSetTopic();

        (uint256 instructionCount, uint256 cursor) = _decodeCompactU32(message, 1);
        if (instructionCount == 0) revert InvalidSetTopic();

        bool foundTopic = false;
        for (uint256 i = 0; i < instructionCount; i++) {
            if (cursor >= message.length) revert InvalidSetTopic();

            bytes1 instruction = message[cursor];
            cursor += 1;
            bool finalInstruction = i == instructionCount - 1;

            if (instruction == XCM_SET_TOPIC_INSTRUCTION) {
                if (!finalInstruction) revert InvalidSetTopic();
                _requireAvailable(message, cursor, 32);
                bytes32 topic;
                assembly {
                    topic := calldataload(add(message.offset, cursor))
                }
                if (topic != requestId) revert InvalidSetTopic();
                cursor += 32;
                foundTopic = true;
                continue;
            }

            if (finalInstruction) revert InvalidSetTopic();
            cursor = _skipSupportedInstruction(message, instruction, cursor);
        }

        if (!foundTopic || cursor != message.length) revert InvalidSetTopic();
    }

    function _decodeCompactU32(bytes calldata data, uint256 offset)
        internal
        pure
        returns (uint256 value, uint256 nextOffset)
    {
        if (offset >= data.length) revert InvalidSetTopic();

        uint8 b0 = uint8(data[offset]);
        uint8 mode = b0 & 0x03;

        if (mode == 0) {
            return (uint256(b0 >> 2), offset + 1);
        }

        if (mode == 1) {
            if (offset + 2 > data.length) revert InvalidSetTopic();
            uint16 raw = uint16(uint8(data[offset])) | (uint16(uint8(data[offset + 1])) << 8);
            return (uint256(raw >> 2), offset + 2);
        }

        if (mode == 2) {
            if (offset + 4 > data.length) revert InvalidSetTopic();
            uint32 raw = uint32(uint8(data[offset])) | (uint32(uint8(data[offset + 1])) << 8)
                | (uint32(uint8(data[offset + 2])) << 16) | (uint32(uint8(data[offset + 3])) << 24);
            return (uint256(raw >> 2), offset + 4);
        }

        revert InvalidSetTopic();
    }

    function _skipSupportedInstruction(bytes calldata data, bytes1 instruction, uint256 offset)
        internal
        pure
        returns (uint256 nextOffset)
    {
        if (instruction == XCM_INSTRUCTION_WITHDRAW_ASSET) {
            return _skipAssetVector(data, offset);
        }
        if (instruction == XCM_INSTRUCTION_PAY_FEES) {
            return _skipAsset(data, offset);
        }
        if (instruction == XCM_INSTRUCTION_DEPOSIT_ASSET) {
            return _skipLocation(data, _skipAssetFilter(data, offset));
        }
        revert InvalidSetTopic();
    }

    function _skipAssetVector(bytes calldata data, uint256 offset) internal pure returns (uint256 nextOffset) {
        (uint256 assetCount, uint256 cursor) = _decodeCompactU32(data, offset);
        if (assetCount == 0) revert InvalidSetTopic();
        for (uint256 i = 0; i < assetCount; i++) {
            cursor = _skipAsset(data, cursor);
        }
        return cursor;
    }

    function _skipAsset(bytes calldata data, uint256 offset) internal pure returns (uint256 nextOffset) {
        uint256 cursor = _skipLocation(data, offset);
        _requireAvailable(data, cursor, 1);
        bytes1 fun = data[cursor];
        cursor += 1;
        if (fun != 0x00) revert InvalidSetTopic();
        return _skipCompact(data, cursor);
    }

    function _skipAssetFilter(bytes calldata data, uint256 offset) internal pure returns (uint256 nextOffset) {
        _requireAvailable(data, offset, 6);
        if (data[offset] != 0x01 || data[offset + 1] != 0x01) revert InvalidSetTopic();
        return offset + 6;
    }

    function _skipLocation(bytes calldata data, uint256 offset) internal pure returns (uint256 nextOffset) {
        _requireAvailable(data, offset, 2);
        uint256 cursor = offset + 1;
        bytes1 interior = data[cursor];
        cursor += 1;
        if (interior == 0x00) {
            return cursor;
        }
        if (interior == 0x01) {
            return _skipJunction(data, cursor);
        }
        revert InvalidSetTopic();
    }

    function _skipJunction(bytes calldata data, uint256 offset) internal pure returns (uint256 nextOffset) {
        _requireAvailable(data, offset, 1);
        bytes1 junction = data[offset];
        if (junction == 0x00) {
            _requireAvailable(data, offset, 5);
            return offset + 5;
        }
        if (junction == 0x01) {
            _requireAvailable(data, offset, 34);
            return offset + 34;
        }
        if (junction == 0x03) {
            _requireAvailable(data, offset, 22);
            return offset + 22;
        }
        revert InvalidSetTopic();
    }

    function _skipCompact(bytes calldata data, uint256 offset) internal pure returns (uint256 nextOffset) {
        _requireAvailable(data, offset, 1);
        uint8 b0 = uint8(data[offset]);
        uint8 mode = b0 & 0x03;

        if (mode == 0) {
            return offset + 1;
        }
        if (mode == 1) {
            _requireAvailable(data, offset, 2);
            return offset + 2;
        }
        if (mode == 2) {
            _requireAvailable(data, offset, 4);
            return offset + 4;
        }

        uint256 byteLength = uint256(b0 >> 2) + 4;
        _requireAvailable(data, offset + 1, byteLength);
        return offset + 1 + byteLength;
    }

    function _requireAvailable(bytes calldata data, uint256 offset, uint256 length) internal pure {
        if (offset > data.length || length > data.length - offset) revert InvalidSetTopic();
    }
}
