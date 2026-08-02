// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {IXcmWrapper} from "../interfaces/IXcmWrapper.sol";
import {IXcmV2CustodyAdapter} from "../interfaces/IXcmV2CustodyAdapter.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

/**
 * @notice Async USDC/aUSDC accounting adapter for XcmWrapperV2.
 */
contract HydrationUsdcAdapter is IXcmV2CustodyAdapter, ReentrancyGuard {
    TreasuryPolicy public immutable policy;
    address public immutable override asset;
    bytes32 public immutable override strategyId;
    IXcmWrapper public immutable xcmWrapper;

    uint256 public override totalShares;
    uint256 public override totalAssets;
    uint256 public override pendingDepositAssets;
    uint256 public override pendingWithdrawalShares;
    uint256 public remoteOperatingFloat;
    uint64 public remoteOperatingFloatAsOf;
    bytes32 public remoteOperatingFloatRef;

    mapping(bytes32 => AdapterRequest) internal requests;
    mapping(bytes32 => bool) public fundingReleased;
    mapping(bytes32 => bool) public override requiresRemoteRecovery;
    mapping(bytes32 => uint256) public recoveryAssetsOutstanding;

    event DepositRequested(bytes32 indexed requestId, address indexed account, uint256 assets, uint64 nonce);
    event WithdrawRequested(
        bytes32 indexed requestId, address indexed account, address indexed recipient, uint256 shares, uint64 nonce
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
    event RemoteRecoveryRequired(bytes32 indexed requestId, uint256 assets);
    event RecoveredAssetsReleased(
        bytes32 indexed requestId, address indexed recipient, uint256 assets, uint256 remaining
    );
    event RemoteOperatingFloatObserved(uint256 assets, uint64 asOf, bytes32 indexed remoteRef);

    error Unauthorized();
    error ProtocolPaused();
    error ZeroAmount();
    error InvalidRequest();
    error InvalidStatus();
    error InvalidSettlementRatio();
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
        if (!policy.strategySettler(msg.sender)) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (policy.paused()) revert ProtocolPaused();
        _;
    }

    function requestDeposit(
        address account,
        uint256 assets,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external override nonReentrant whenNotPaused onlyOperator returns (bytes32 requestId) {
        if (assets == 0 || account == address(0)) revert InvalidRequest();
        IXcmWrapper.RequestContext memory context = IXcmWrapper.RequestContext({
            strategyId: strategyId,
            kind: IXcmWrapper.RequestKind.Deposit,
            account: account,
            asset: asset,
            recipient: account,
            assets: assets,
            shares: 0,
            nonce: nonce
        });
        requestId = xcmWrapper.previewRequestId(context);
        AdapterRequest storage request = requests[requestId];
        if (request.requester == address(0)) {
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

    function requestWithdraw(
        address account,
        uint256 shares,
        address recipient,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external override nonReentrant whenNotPaused onlyOperator returns (bytes32 requestId) {
        if (shares == 0 || account == address(0) || recipient == address(0)) revert InvalidRequest();
        if (totalShares < pendingWithdrawalShares + shares) revert InsufficientLiquidity();
        IXcmWrapper.RequestContext memory context = IXcmWrapper.RequestContext({
            strategyId: strategyId,
            kind: IXcmWrapper.RequestKind.Withdraw,
            account: account,
            asset: asset,
            recipient: recipient,
            assets: 0,
            shares: shares,
            nonce: nonce
        });
        requestId = xcmWrapper.previewRequestId(context);
        AdapterRequest storage request = requests[requestId];
        if (request.requester == address(0)) {
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

    function releaseAssetsToWrapper(bytes32 requestId, uint256 assets) external override {
        if (msg.sender != address(xcmWrapper)) revert Unauthorized();
        AdapterRequest storage request = requests[requestId];
        if (
            request.requester == address(0) || request.kind != IXcmWrapper.RequestKind.Deposit
                || request.status != IXcmWrapper.RequestStatus.Pending || request.settled || fundingReleased[requestId]
                || assets != request.requestedAssets
        ) revert InvalidRequest();
        fundingReleased[requestId] = true;
        SafeTransfer.safeTransfer(asset, msg.sender, assets);
    }

    function settleRequest(
        bytes32 requestId,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external override nonReentrant onlyOperator {
        if (status == IXcmWrapper.RequestStatus.Unknown || status == IXcmWrapper.RequestStatus.Pending) {
            revert InvalidStatus();
        }
        AdapterRequest storage request = requests[requestId];
        if (request.requester == address(0)) revert InvalidRequest();
        if (request.settled) revert AlreadySettled();
        if (policy.paused() && status == IXcmWrapper.RequestStatus.Succeeded) revert ProtocolPaused();

        if (status == IXcmWrapper.RequestStatus.Succeeded) {
            if (request.kind == IXcmWrapper.RequestKind.Deposit) {
                if (settledAssets == 0 || settledShares == 0) revert InvalidStatus();
                if (settledShares != _sharesForAssets(settledAssets)) revert InvalidSettlementRatio();
            } else if (request.kind == IXcmWrapper.RequestKind.Withdraw) {
                if (settledAssets == 0) revert InvalidStatus();
                if (settledAssets > _assetsForShares(request.requestedShares)) revert InvalidSettlementRatio();
            } else {
                revert InvalidRequest();
            }
        }

        xcmWrapper.finalizeRequest(requestId, status, settledAssets, settledShares, remoteRef, failureCode);

        if (request.kind == IXcmWrapper.RequestKind.Deposit) {
            pendingDepositAssets -= request.requestedAssets;
            if (status == IXcmWrapper.RequestStatus.Succeeded) {
                totalAssets += settledAssets;
                totalShares += settledShares;
            } else if (fundingReleased[requestId]) {
                requiresRemoteRecovery[requestId] = true;
                recoveryAssetsOutstanding[requestId] = request.requestedAssets;
                emit RemoteRecoveryRequired(requestId, request.requestedAssets);
            } else {
                SafeTransfer.safeTransfer(asset, request.requester, request.requestedAssets);
            }
        } else if (request.kind == IXcmWrapper.RequestKind.Withdraw) {
            pendingWithdrawalShares -= request.requestedShares;
            if (status == IXcmWrapper.RequestStatus.Succeeded) {
                uint256 redeemedAssets = _assetsForShares(request.requestedShares);
                if (request.requestedShares > totalShares || settledAssets > redeemedAssets) {
                    revert InsufficientLiquidity();
                }
                totalShares -= request.requestedShares;
                totalAssets -= redeemedAssets;
                SafeTransfer.safeTransfer(asset, request.recipient, settledAssets);
            }
        }

        request.status = status;
        request.settledAssets = settledAssets;
        request.settledShares = settledShares;
        request.remoteRef = remoteRef;
        request.failureCode = failureCode;
        request.settled = true;
        emit RequestSettled(requestId, request.kind, status, settledAssets, settledShares, remoteRef, failureCode);
    }

    function releaseRecoveredAssets(bytes32 requestId, address recipient, uint256 assets) external override {
        AdapterRequest storage request = requests[requestId];
        if (msg.sender != request.requester || recipient != request.requester) revert Unauthorized();
        if (!requiresRemoteRecovery[requestId] || assets == 0 || assets > recoveryAssetsOutstanding[requestId]) {
            revert InvalidRequest();
        }
        recoveryAssetsOutstanding[requestId] -= assets;
        if (recoveryAssetsOutstanding[requestId] == 0) requiresRemoteRecovery[requestId] = false;
        SafeTransfer.safeTransfer(asset, recipient, assets);
        emit RecoveredAssetsReleased(requestId, recipient, assets, recoveryAssetsOutstanding[requestId]);
    }

    function recordRemoteOperatingFloat(uint256 assets, uint64 asOf, bytes32 remoteRef) external onlyOperator {
        if (asOf == 0) revert InvalidRequest();
        remoteOperatingFloat = assets;
        remoteOperatingFloatAsOf = asOf;
        remoteOperatingFloatRef = remoteRef;
        emit RemoteOperatingFloatObserved(assets, asOf, remoteRef);
    }

    function getAdapterRequest(bytes32 requestId) external view override returns (AdapterRequest memory) {
        return requests[requestId];
    }

    function deposit(uint256) external pure override returns (uint256) {
        revert AsyncOnly();
    }

    function withdraw(uint256, address) external pure override returns (uint256) {
        revert AsyncOnly();
    }

    function maxWithdraw(address) external pure override returns (uint256) {
        return 0;
    }

    function riskLabel() external pure override returns (string memory) {
        return "Async Hydration USDC supply; balance-observed, recovery-required on remote timeout.";
    }

    function _sharesForAssets(uint256 assets) internal view returns (uint256) {
        if (totalShares == 0 || totalAssets == 0) return assets;
        return (assets * totalShares) / totalAssets;
    }

    function _assetsForShares(uint256 shares) internal view returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares * totalAssets) / totalShares;
    }
}
