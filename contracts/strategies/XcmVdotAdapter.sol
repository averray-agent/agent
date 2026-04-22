// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {IXcmWrapper} from "../interfaces/IXcmWrapper.sol";
import {IXcmStrategyAdapter} from "../interfaces/IXcmStrategyAdapter.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

/**
 * @title XcmVdotAdapter
 * @notice Production-shaped async treasury adapter for a future Bifrost vDOT lane.
 *
 * This adapter does not try to hide async settlement behind the old sync
 * `deposit/withdraw` surface. Instead it:
 *   - queues deterministic XCM requests through `IXcmWrapper`
 *   - keeps pending deposit / withdraw state explicit
 *   - settles local accounting only when an operator finalizes the wrapper request
 *
 * The raw `destination` and `message` bytes still arrive from a higher layer
 * for now. That keeps SCALE message construction outside the vault math while
 * giving us a real adapter that can queue wrapper requests today.
 */
contract XcmVdotAdapter is IXcmStrategyAdapter, ReentrancyGuard {
    TreasuryPolicy public immutable policy;
    address public immutable override asset;
    bytes32 public immutable override strategyId;
    IXcmWrapper public immutable xcmWrapper;

    uint256 public override totalShares;
    uint256 public override totalAssets;
    uint256 public override pendingDepositAssets;
    uint256 public override pendingWithdrawalShares;

    mapping(bytes32 => AdapterRequest) internal requests;

    event DepositRequested(bytes32 indexed requestId, address indexed account, uint256 assets, uint64 nonce);
    event WithdrawRequested(
        bytes32 indexed requestId,
        address indexed account,
        address indexed recipient,
        uint256 shares,
        uint64 nonce
    );
    event RequestSettled(
        bytes32 indexed requestId,
        IXcmWrapper.RequestKind indexed kind,
        IXcmWrapper.RequestStatus indexed status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    );

    error Unauthorized();
    error ProtocolPaused();
    error ZeroAmount();
    error InvalidRequest();
    error InvalidStatus();
    error AsyncOnly();
    error InsufficientLiquidity();
    error AlreadySettled();

    constructor(TreasuryPolicy policy_, address asset_, bytes32 strategyId_, IXcmWrapper wrapper_) {
        policy = policy_;
        asset = asset_;
        strategyId = strategyId_;
        xcmWrapper = wrapper_;
    }

    modifier onlyOperator() {
        if (!policy.serviceOperators(msg.sender)) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (policy.paused()) revert ProtocolPaused();
        _;
    }

    /// @inheritdoc IXcmStrategyAdapter
    function requestDeposit(
        address account,
        uint256 assets,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external override nonReentrant whenNotPaused onlyOperator returns (bytes32 requestId) {
        if (assets == 0) revert ZeroAmount();

        IXcmWrapper.RequestContext memory context = _buildContext(
            IXcmWrapper.RequestKind.Deposit,
            account,
            account,
            assets,
            0,
            nonce
        );

        requestId = xcmWrapper.previewRequestId(context);
        AdapterRequest storage existing = requests[requestId];
        if (existing.requester == address(0)) {
            SafeTransfer.safeTransferFrom(asset, msg.sender, address(this), assets);
            pendingDepositAssets += assets;
            requests[requestId] = AdapterRequest({
                kind: IXcmWrapper.RequestKind.Deposit,
                status: IXcmWrapper.RequestStatus.Pending,
                account: account,
                requester: msg.sender,
                recipient: account,
                requestedAssets: assets,
                requestedShares: 0,
                settledAssets: 0,
                settledShares: 0,
                remoteRef: bytes32(0),
                failureCode: bytes32(0),
                settled: false
            });
            emit DepositRequested(requestId, account, assets, nonce);
        }

        xcmWrapper.queueRequest(context, destination, message, maxWeight);
    }

    /// @inheritdoc IXcmStrategyAdapter
    function requestWithdraw(
        address account,
        uint256 shares,
        address recipient,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external override nonReentrant whenNotPaused onlyOperator returns (bytes32 requestId) {
        if (shares == 0) revert ZeroAmount();
        if (recipient == address(0) || account == address(0)) revert InvalidRequest();
        if (totalShares < pendingWithdrawalShares + shares) revert InsufficientLiquidity();

        IXcmWrapper.RequestContext memory context = _buildContext(
            IXcmWrapper.RequestKind.Withdraw,
            account,
            recipient,
            0,
            shares,
            nonce
        );

        requestId = xcmWrapper.previewRequestId(context);
        AdapterRequest storage existing = requests[requestId];
        if (existing.requester == address(0)) {
            pendingWithdrawalShares += shares;
            requests[requestId] = AdapterRequest({
                kind: IXcmWrapper.RequestKind.Withdraw,
                status: IXcmWrapper.RequestStatus.Pending,
                account: account,
                requester: msg.sender,
                recipient: recipient,
                requestedAssets: 0,
                requestedShares: shares,
                settledAssets: 0,
                settledShares: 0,
                remoteRef: bytes32(0),
                failureCode: bytes32(0),
                settled: false
            });
            emit WithdrawRequested(requestId, account, recipient, shares, nonce);
        }

        xcmWrapper.queueRequest(context, destination, message, maxWeight);
    }

    /// @inheritdoc IXcmStrategyAdapter
    function settleRequest(
        bytes32 requestId,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external override nonReentrant whenNotPaused onlyOperator {
        if (status == IXcmWrapper.RequestStatus.Unknown || status == IXcmWrapper.RequestStatus.Pending) {
            revert InvalidStatus();
        }

        AdapterRequest storage request = requests[requestId];
        if (request.requester == address(0)) revert InvalidRequest();
        if (request.settled) revert AlreadySettled();

        xcmWrapper.finalizeRequest(requestId, status, settledAssets, settledShares, remoteRef, failureCode);

        if (request.kind == IXcmWrapper.RequestKind.Deposit) {
            pendingDepositAssets -= request.requestedAssets;
            if (status == IXcmWrapper.RequestStatus.Succeeded) {
                uint256 assetsToBook = settledAssets == 0 ? request.requestedAssets : settledAssets;
                totalAssets += assetsToBook;
                totalShares += settledShares;
            } else {
                SafeTransfer.safeTransfer(asset, request.requester, request.requestedAssets);
            }
        } else if (request.kind == IXcmWrapper.RequestKind.Withdraw) {
            pendingWithdrawalShares -= request.requestedShares;
            if (status == IXcmWrapper.RequestStatus.Succeeded) {
                if (request.requestedShares > totalShares || settledAssets > totalAssets) revert InsufficientLiquidity();
                totalShares -= request.requestedShares;
                totalAssets -= settledAssets;
                SafeTransfer.safeTransfer(asset, request.recipient, settledAssets);
            }
        } else {
            revert InvalidRequest();
        }

        request.status = status;
        request.settledAssets = settledAssets;
        request.settledShares = settledShares;
        request.remoteRef = remoteRef;
        request.failureCode = failureCode;
        request.settled = true;

        emit RequestSettled(requestId, request.kind, status, settledAssets, settledShares, remoteRef, failureCode);
    }

    /// @notice Synchronous deposit is intentionally unsupported on the async lane.
    function deposit(uint256) external pure override returns (uint256) {
        revert AsyncOnly();
    }

    /// @notice Synchronous withdraw is intentionally unsupported on the async lane.
    function withdraw(uint256, address) external pure override returns (uint256) {
        revert AsyncOnly();
    }

    /// @notice Instant withdraw capacity is reported as zero for the async lane.
    function maxWithdraw(address) external pure override returns (uint256) {
        return 0;
    }

    /// @notice Human-readable risk disclosure for registry and API surfaces.
    function riskLabel() external pure override returns (string memory) {
        return "Async XCM-backed vDOT lane. Requests queue through XcmWrapper and settle later; not instant liquidity.";
    }

    /// @inheritdoc IXcmStrategyAdapter
    function getAdapterRequest(bytes32 requestId) external view override returns (AdapterRequest memory) {
        return requests[requestId];
    }

    function _buildContext(
        IXcmWrapper.RequestKind kind,
        address account,
        address recipient,
        uint256 assets,
        uint256 shares,
        uint64 nonce
    ) internal view returns (IXcmWrapper.RequestContext memory) {
        if (account == address(0) || recipient == address(0)) revert InvalidRequest();
        return IXcmWrapper.RequestContext({
            strategyId: strategyId,
            kind: kind,
            account: account,
            asset: asset,
            recipient: recipient,
            assets: assets,
            shares: shares,
            nonce: nonce
        });
    }
}
