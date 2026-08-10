// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {IDepositPoolVenueAdapter} from "../interfaces/IDepositPoolVenueAdapter.sol";
import {IHydrationDepositPoolLane} from "../interfaces/IHydrationDepositPoolLane.sol";
import {IXcmWrapper} from "../interfaces/IXcmWrapper.sol";
import {IXcmV22CustodyAdapter} from "../interfaces/IXcmV22CustodyAdapter.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

interface IERC20PoolLaneAsset {
    function balanceOf(address account) external view returns (uint256);
}

/// @title Hydration adapter for one DepositPool
/// @notice Converts the pool's asset requests into the existing asynchronous
///         Hydration v2.2 request lifecycle. The underlying lane must be a
///         dedicated deployment whose immutable agentAccountCore is this adapter.
contract HydrationDepositPoolAdapter is IDepositPoolVenueAdapter, ReentrancyGuard {
    struct LaneParameters {
        uint256 sellAmount;
        uint256 minimumOutput;
        uint256 maxFeePerLeg;
        uint64 dispatchDeadline;
        uint64 nonce;
    }

    struct StoredRequest {
        RequestKind kind;
        RequestStatus status;
        uint256 requestedAssets;
        uint256 settledAssets;
        uint64 returnBy;
        bool claimed;
        bytes32 laneRequestId;
    }

    address public immutable override asset;
    address public immutable pool;
    TreasuryPolicy public immutable policy;
    IHydrationDepositPoolLane public immutable lane;

    uint256 public nextRequestNonce = 1;
    uint256 public reservedDeployAssets;
    bytes32 public activeDeployRequestId;
    bytes32 public activeRecallRequestId;
    mapping(bytes32 => StoredRequest) internal requests;
    mapping(bytes32 => bytes32) public poolRequestForLaneRequest;

    event PoolRequestCreated(
        bytes32 indexed requestId, RequestKind indexed kind, uint256 requestedAssets, uint64 returnBy
    );
    event UnstagedRequestCancelled(bytes32 indexed requestId, RequestKind indexed kind);
    event LaneRequestStaged(bytes32 indexed requestId, bytes32 indexed laneRequestId, uint256 laneShares);
    event PoolRequestClaimed(bytes32 indexed requestId, RequestStatus status, uint256 settledAssets);
    event RecoveryReturned(bytes32 indexed requestId, uint256 assets, uint256 remainingRecoverableAssets);

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidRequest();
    error RequestPending();
    error AlreadyClaimed();
    error DeadlineExpired();
    error ApprovalFailed();
    error InsufficientVenueAssets();

    modifier onlyPool() {
        if (msg.sender != pool) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (!policy.strategySettler(msg.sender)) revert Unauthorized();
        _;
    }

    constructor(address pool_, IHydrationDepositPoolLane lane_) {
        if (pool_ == address(0) || address(lane_) == address(0)) revert InvalidConfiguration();
        address asset_ = lane_.asset();
        TreasuryPolicy policy_ = lane_.policy();
        if (asset_ == address(0) || address(policy_) == address(0) || lane_.agentAccountCore() != address(this)) {
            revert InvalidConfiguration();
        }
        pool = pool_;
        lane = lane_;
        asset = asset_;
        policy = policy_;
    }

    function managedAssets(address account) public view override returns (uint256) {
        if (account != pool) return 0;
        uint256 managed =
            IERC20PoolLaneAsset(asset).balanceOf(address(this)) + lane.totalAssets() + lane.pendingDepositAssets();
        // A terminal failed deposit leaves the observer-capped recovery outside
        // the lane's normal totals. Keep it in NAV until it is returned or
        // explicitly written off; otherwise the failure/claim transaction gap
        // would briefly understate the pool's share price.
        StoredRequest storage activeDeploy = requests[activeDeployRequestId];
        if (activeDeploy.laneRequestId != bytes32(0) && lane.requiresRemoteRecovery(activeDeploy.laneRequestId)) {
            managed += lane.recoveryAssetsOutstanding(activeDeploy.laneRequestId);
        }
        return managed;
    }

    function requestDeploy(uint256 assets, uint64 returnBy) external override onlyPool returns (bytes32 requestId) {
        if (assets == 0 || returnBy <= block.timestamp || activeDeployRequestId != bytes32(0)) {
            revert InvalidRequest();
        }
        uint256 nextReserved = reservedDeployAssets + assets;
        if (IERC20PoolLaneAsset(asset).balanceOf(address(this)) < nextReserved) revert InvalidRequest();
        reservedDeployAssets = nextReserved;
        requestId = _createRequest(RequestKind.Deploy, assets, returnBy);
        activeDeployRequestId = requestId;
    }

    function requestRecall(uint256 assets, uint64 returnBy) external override onlyPool returns (bytes32 requestId) {
        if (assets == 0 || assets > managedAssets(pool) || activeRecallRequestId != bytes32(0)) {
            revert InvalidRequest();
        }
        requestId = _createRequest(RequestKind.Recall, assets, returnBy);
        activeRecallRequestId = requestId;
    }

    function stageDeploy(bytes32 requestId, LaneParameters calldata parameters)
        external
        onlyOperator
        nonReentrant
        returns (bytes32 laneRequestId)
    {
        StoredRequest storage request = _unstagedRequest(requestId, RequestKind.Deploy);
        _requireDispatchDeadline(parameters.dispatchDeadline, request.returnBy);
        reservedDeployAssets -= request.requestedAssets;
        _approveLane(request.requestedAssets);
        laneRequestId = lane.requestDeposit(
            address(this),
            request.requestedAssets,
            parameters.sellAmount,
            parameters.minimumOutput,
            parameters.maxFeePerLeg,
            parameters.dispatchDeadline,
            parameters.nonce
        );
        _approveLane(0);
        _recordLaneRequest(requestId, request, laneRequestId, 0);
    }

    function stageRecall(bytes32 requestId, LaneParameters calldata parameters)
        external
        onlyOperator
        nonReentrant
        returns (bytes32 laneRequestId, uint256 shares)
    {
        StoredRequest storage request = _unstagedRequest(requestId, RequestKind.Recall);
        _requireDispatchDeadline(parameters.dispatchDeadline, request.returnBy);
        uint256 venueAssets = lane.totalAssets();
        uint256 venueShares = lane.totalShares();
        if (venueAssets == 0 || venueShares == 0 || parameters.minimumOutput != request.requestedAssets) {
            revert InsufficientVenueAssets();
        }
        shares = _ceilDiv(request.requestedAssets * venueShares, venueAssets);
        if (shares == 0 || shares > venueShares) revert InsufficientVenueAssets();
        laneRequestId = lane.requestWithdraw(
            address(this),
            shares,
            address(this),
            parameters.minimumOutput,
            parameters.maxFeePerLeg,
            parameters.dispatchDeadline,
            parameters.nonce
        );
        _recordLaneRequest(requestId, request, laneRequestId, shares);
    }

    /// @notice Mark a request that never entered the XCM lane as failed so the
    ///         pool can claim any locally staged deployment assets back.
    function cancelUnstaged(bytes32 requestId) external onlyOperator {
        StoredRequest storage request = requests[requestId];
        if (
            request.requestedAssets == 0 || request.status != RequestStatus.Pending || request.claimed
                || request.laneRequestId != bytes32(0)
        ) revert InvalidRequest();
        request.status = RequestStatus.Failed;
        if (request.kind == RequestKind.Deploy) reservedDeployAssets -= request.requestedAssets;
        emit UnstagedRequestCancelled(requestId, request.kind);
    }

    function getRequest(bytes32 requestId) public view override returns (Request memory request) {
        StoredRequest storage stored = requests[requestId];
        request = Request({
            kind: stored.kind,
            status: stored.status,
            requestedAssets: stored.requestedAssets,
            settledAssets: stored.settledAssets,
            returnBy: stored.returnBy,
            claimed: stored.claimed
        });
        if (stored.laneRequestId == bytes32(0) || stored.claimed) return request;
        IXcmV22CustodyAdapter.AdapterRequest memory laneRequest = lane.getAdapterRequest(stored.laneRequestId);
        request.status = _poolStatus(laneRequest.status);
        request.settledAssets = laneRequest.settledAssets;
        if (request.status == RequestStatus.Failed) {
            // A remote recovery is still an unresolved movement, not a completed
            // failure. The pool must not close the epoch while those assets are
            // neither back in its buffer nor written off through the lane.
            if (lane.requiresRemoteRecovery(stored.laneRequestId)) {
                request.status = RequestStatus.Pending;
            }
            request.settledAssets = stored.settledAssets;
        }
    }

    function claimSettled(bytes32 requestId) external override onlyPool nonReentrant returns (uint256 settledAssets) {
        StoredRequest storage stored = requests[requestId];
        if (stored.claimed) revert AlreadyClaimed();
        Request memory request = getRequest(requestId);
        if (request.requestedAssets == 0) revert InvalidRequest();
        if (request.status == RequestStatus.Pending || request.status == RequestStatus.None) revert RequestPending();

        stored.status = request.status;
        stored.settledAssets = request.settledAssets;
        stored.claimed = true;
        settledAssets = request.settledAssets;
        if (request.kind == RequestKind.Recall && request.status == RequestStatus.Succeeded) {
            SafeTransfer.safeTransfer(asset, pool, settledAssets);
        } else if (request.kind == RequestKind.Deploy && request.status == RequestStatus.Failed) {
            uint256 stillOwed = request.requestedAssets - settledAssets;
            uint256 localBalance = IERC20PoolLaneAsset(asset).balanceOf(address(this));
            uint256 localRefund = localBalance < stillOwed ? localBalance : stillOwed;
            settledAssets += localRefund;
            stored.settledAssets = settledAssets;
            if (localRefund != 0) SafeTransfer.safeTransfer(asset, pool, localRefund);
        }
        if (request.kind == RequestKind.Deploy) activeDeployRequestId = bytes32(0);
        else activeRecallRequestId = bytes32(0);
        emit PoolRequestClaimed(requestId, request.status, settledAssets);
    }

    /// @notice Complete the existing lane's request-scoped recovery path and
    ///         return recovered pool assets only to the immutable pool.
    function releaseRecoveredToPool(bytes32 requestId, uint256 assets) external onlyOperator nonReentrant {
        StoredRequest storage request = requests[requestId];
        uint256 outstanding = lane.recoveryAssetsOutstanding(request.laneRequestId);
        IXcmV22CustodyAdapter.AdapterRequest memory laneRequest = lane.getAdapterRequest(request.laneRequestId);
        if (
            request.claimed || request.requestedAssets == 0 || request.laneRequestId == bytes32(0)
                || _poolStatus(laneRequest.status) != RequestStatus.Failed || assets == 0 || assets > outstanding
        ) {
            revert InvalidRequest();
        }
        lane.releaseRecoveredAssets(request.laneRequestId, address(this), assets);
        request.settledAssets += assets;
        SafeTransfer.safeTransfer(asset, pool, assets);
        emit RecoveryReturned(requestId, assets, outstanding - assets);
    }

    function _createRequest(RequestKind kind, uint256 assets, uint64 returnBy) private returns (bytes32 requestId) {
        uint256 nonce = nextRequestNonce++;
        requestId = keccak256(abi.encode(address(this), pool, kind, nonce, assets, returnBy));
        requests[requestId] = StoredRequest({
            kind: kind,
            status: RequestStatus.Pending,
            requestedAssets: assets,
            settledAssets: 0,
            returnBy: returnBy,
            claimed: false,
            laneRequestId: bytes32(0)
        });
        emit PoolRequestCreated(requestId, kind, assets, returnBy);
    }

    function _unstagedRequest(bytes32 requestId, RequestKind expectedKind)
        private
        view
        returns (StoredRequest storage request)
    {
        request = requests[requestId];
        if (request.requestedAssets == 0 || request.kind != expectedKind || request.laneRequestId != bytes32(0)) {
            revert InvalidRequest();
        }
    }

    function _recordLaneRequest(bytes32 requestId, StoredRequest storage request, bytes32 laneRequestId, uint256 shares)
        private
    {
        if (laneRequestId == bytes32(0) || poolRequestForLaneRequest[laneRequestId] != bytes32(0)) {
            revert InvalidRequest();
        }
        request.laneRequestId = laneRequestId;
        poolRequestForLaneRequest[laneRequestId] = requestId;
        emit LaneRequestStaged(requestId, laneRequestId, shares);
    }

    function _requireDispatchDeadline(uint64 dispatchDeadline, uint64 returnBy) private view {
        if (block.timestamp > returnBy) revert DeadlineExpired();
        if (dispatchDeadline == 0 || dispatchDeadline > returnBy || dispatchDeadline < block.timestamp) {
            revert InvalidRequest();
        }
    }

    function _poolStatus(IXcmWrapper.RequestStatus status) private pure returns (RequestStatus) {
        if (status == IXcmWrapper.RequestStatus.Pending) return RequestStatus.Pending;
        if (status == IXcmWrapper.RequestStatus.Succeeded) return RequestStatus.Succeeded;
        if (status == IXcmWrapper.RequestStatus.Failed || status == IXcmWrapper.RequestStatus.Cancelled) {
            return RequestStatus.Failed;
        }
        return RequestStatus.None;
    }

    function _approveLane(uint256 assets) private {
        (bool ok, bytes memory data) =
            asset.call(abi.encodeWithSignature("approve(address,uint256)", address(lane), assets));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApprovalFailed();
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        if (numerator == 0) return 0;
        return ((numerator - 1) / denominator) + 1;
    }
}
