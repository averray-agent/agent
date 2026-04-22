// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IXcmWrapper
 * @notice Async transport boundary for Polkadot Hub XCM-backed strategy rails.
 *
 * The goal of this interface is to keep raw XCM concerns out of vault
 * accounting contracts such as AgentAccountCore and future production
 * strategy adapters. The wrapper owns:
 *   - weighing / dispatch to the Hub XCM precompile
 *   - idempotent request identity
 *   - async request state transitions
 *   - settlement metadata for indexers and backend recovery flows
 *
 * A production strategy adapter should use this transport boundary rather
 * than embed raw precompile calls directly into deposit / withdraw math.
 */
interface IXcmWrapper {
    enum RequestKind {
        Deposit,
        Withdraw,
        Claim
    }

    enum RequestStatus {
        Unknown,
        Pending,
        Succeeded,
        Failed,
        Cancelled
    }

    struct Weight {
        uint64 refTime;
        uint64 proofSize;
    }

    /**
     * @dev High-level business context for one XCM operation.
     * `assets` and `shares` are both included because one request may be
     * primarily asset-denominated (deposit) while another is share-based
     * (withdraw / claim). `nonce` is caller-defined idempotency input.
     */
    struct RequestContext {
        bytes32 strategyId;
        RequestKind kind;
        address account;
        address asset;
        address recipient;
        uint256 assets;
        uint256 shares;
        uint64 nonce;
    }

    /**
     * @dev Persisted lifecycle state for async XCM settlement.
     */
    struct RequestRecord {
        RequestContext context;
        RequestStatus status;
        uint256 settledAssets;
        uint256 settledShares;
        bytes32 remoteRef;
        bytes32 failureCode;
        uint64 createdAt;
        uint64 updatedAt;
    }

    event RequestQueued(
        bytes32 indexed requestId,
        bytes32 indexed strategyId,
        RequestKind indexed kind,
        address account,
        address asset,
        address recipient,
        uint256 assets,
        uint256 shares,
        uint64 nonce
    );

    event RequestStatusUpdated(
        bytes32 indexed requestId,
        RequestStatus indexed status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    );

    /**
     * @notice The canonical Polkadot Hub XCM precompile address the
     * wrapper dispatches through.
     */
    function xcmPrecompile() external view returns (address);

    /**
     * @notice Deterministically preview a request id before dispatch.
     * Callers use this for idempotent retries and off-chain correlation.
     */
    function previewRequestId(RequestContext calldata context) external view returns (bytes32 requestId);

    /**
     * @notice Ask the wrapper to weigh an already SCALE-encoded XCM
     * message before submit. The wrapper may pass this through to the
     * Hub XCM precompile or cache weight hints internally.
     */
    function weighMessage(bytes calldata message) external view returns (Weight memory);

    /**
     * @notice Queue and dispatch one XCM request.
     *
     * `destination` and `message` are kept as raw bytes because the
     * transport wrapper may evolve independently from strategy-specific
     * message builders. Strategy adapters should still construct these at
     * a higher abstraction layer than vault accounting.
     */
    function queueRequest(
        RequestContext calldata context,
        bytes calldata destination,
        bytes calldata message,
        Weight calldata maxWeight
    ) external returns (bytes32 requestId);

    /**
     * @notice Finalize a queued request once the async outcome is known.
     * Intended for callback / operator / watcher-driven settlement paths.
     */
    function finalizeRequest(
        bytes32 requestId,
        RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external;

    /**
     * @notice Read back persisted state for indexing and recovery.
     */
    function getRequest(bytes32 requestId) external view returns (RequestRecord memory);
}
