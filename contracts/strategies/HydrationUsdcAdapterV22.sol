// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {IXcmWrapper} from "../interfaces/IXcmWrapper.sol";
import {IXcmWrapperV22} from "../interfaces/IXcmWrapperV22.sol";
import {IXcmV22CustodyAdapter} from "../interfaces/IXcmV22CustodyAdapter.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

/**
 * @notice Bank v2.2 USDC/aUSDC accounting adapter. Failed requests record
 *         only observer-proven recoverable principal, never the gross request.
 */
contract HydrationUsdcAdapterV22 is IXcmV22CustodyAdapter, ReentrancyGuard {
    TreasuryPolicy public immutable policy;
    address public immutable override asset;
    bytes32 public immutable override strategyId;
    IXcmWrapperV22 public immutable override xcmWrapper;
    address public immutable agentAccountCore;

    uint256 public override totalShares;
    uint256 public override totalAssets;
    uint256 public override pendingDepositAssets;
    uint256 public override pendingWithdrawalShares;
    uint256 public remoteOperatingFloat;
    uint64 public remoteOperatingFloatAsOf;
    bytes32 public remoteOperatingFloatRef;
    uint64 public remotePositionAsOf;
    bytes32 public remotePositionRef;

    mapping(bytes32 => AdapterRequest) internal requests;
    mapping(bytes32 => bool) public fundingReleased;
    mapping(bytes32 => bool) public override requiresRemoteRecovery;
    mapping(bytes32 => uint256) public override recoveryAssetsOutstanding;

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
    event TerminalAccounting(
        bytes32 indexed requestId,
        uint256 requestedAssets,
        uint256 observedRemoteBalanceRaw,
        uint256 recoveryAssetsOutstanding
    );
    event ResidueWrittenOff(
        bytes32 indexed requestId, uint256 amountRaw, bytes32 indexed reasonCode, uint256 remaining
    );
    event RemoteRecoveryRequired(bytes32 indexed requestId, uint256 assets);
    event RecoveredAssetsReleased(
        bytes32 indexed requestId, address indexed recipient, uint256 assets, uint256 remaining
    );
    event TreasuryRequestStaged(
        bytes32 indexed requestId,
        IXcmWrapper.RequestKind indexed kind,
        address indexed stagingAuthority,
        address treasuryContext,
        uint256 amount
    );
    event RemoteOperatingFloatObserved(uint256 assets, uint64 asOf, bytes32 indexed remoteRef);
    event RemotePositionObserved(uint256 assets, uint256 shares, uint64 asOf, bytes32 indexed remoteRef);

    error Unauthorized();
    error ProtocolPaused();
    error InvalidRequest();
    error InvalidStatus();
    error InvalidSettlementRatio();
    error AsyncOnly();
    error InsufficientLiquidity();
    error AlreadySettled();

    constructor(
        TreasuryPolicy policy_,
        address asset_,
        bytes32 strategyId_,
        IXcmWrapperV22 wrapper_,
        address agentAccountCore_
    ) {
        if (
            address(policy_) == address(0) || asset_ == address(0) || strategyId_ == bytes32(0)
                || address(wrapper_) == address(0) || agentAccountCore_ == address(0)
        ) revert InvalidRequest();
        policy = policy_;
        asset = asset_;
        strategyId = strategyId_;
        xcmWrapper = wrapper_;
        agentAccountCore = agentAccountCore_;
    }

    modifier onlyOperator() {
        if (!policy.strategySettler(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyAgentAccountCore() {
        if (msg.sender != agentAccountCore) revert Unauthorized();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != policy.owner()) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (policy.paused()) revert ProtocolPaused();
        _;
    }

    function requestDeposit(
        address account,
        uint256 assets,
        uint256 sellAmount,
        uint256 minimumShares,
        uint256 maxFeePerLeg,
        uint64 dispatchDeadline,
        uint64 nonce
    ) external nonReentrant whenNotPaused onlyAgentAccountCore returns (bytes32 requestId) {
        return _stageDeposit(
            msg.sender, account, assets, sellAmount, minimumShares, maxFeePerLeg, dispatchDeadline, nonce
        );
    }

    function stageTreasuryDeposit(
        address treasuryContext,
        uint256 assets,
        uint256 sellAmount,
        uint256 minimumShares,
        uint256 maxFeePerLeg,
        uint64 dispatchDeadline,
        uint64 nonce
    ) external nonReentrant whenNotPaused onlyOwner returns (bytes32 requestId) {
        return _stageDeposit(
            msg.sender, treasuryContext, assets, sellAmount, minimumShares, maxFeePerLeg, dispatchDeadline, nonce
        );
    }

    function _stageDeposit(
        address requester,
        address account,
        uint256 assets,
        uint256 sellAmount,
        uint256 minimumShares,
        uint256 maxFeePerLeg,
        uint64 dispatchDeadline,
        uint64 nonce
    ) internal returns (bytes32 requestId) {
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
        IXcmWrapperV22.RequestParameters memory parameters = IXcmWrapperV22.RequestParameters({
            sellAmount: sellAmount,
            minimumOutput: minimumShares,
            maxFeePerLeg: maxFeePerLeg,
            dispatchDeadline: dispatchDeadline
        });
        requestId = xcmWrapper.previewRequestId(context);
        AdapterRequest storage request = requests[requestId];
        if (request.requester == address(0)) {
            SafeTransfer.safeTransferFrom(asset, requester, address(this), assets);
            pendingDepositAssets += assets;
            requests[requestId] = AdapterRequest({
                kind: IXcmWrapper.RequestKind.Deposit,
                status: IXcmWrapper.RequestStatus.Pending,
                account: account,
                requester: requester,
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
            if (requester != agentAccountCore) {
                emit TreasuryRequestStaged(requestId, IXcmWrapper.RequestKind.Deposit, requester, account, assets);
            }
        } else if (request.requester != requester) {
            revert Unauthorized();
        }
        xcmWrapper.queueRequest(context, parameters);
    }

    function requestWithdraw(
        address account,
        uint256 shares,
        address recipient,
        uint256 minimumAssets,
        uint256 remoteFeeBudget,
        uint64 dispatchDeadline,
        uint64 nonce
    ) external nonReentrant whenNotPaused onlyAgentAccountCore returns (bytes32 requestId) {
        return _stageWithdraw(
            msg.sender, account, shares, recipient, minimumAssets, remoteFeeBudget, dispatchDeadline, nonce
        );
    }

    function stageTreasuryWithdraw(
        address treasuryContext,
        uint256 shares,
        uint256 minimumAssets,
        uint256 remoteFeeBudget,
        uint64 dispatchDeadline,
        uint64 nonce
    ) external nonReentrant whenNotPaused onlyOwner returns (bytes32 requestId) {
        return _stageWithdraw(
            msg.sender, treasuryContext, shares, msg.sender, minimumAssets, remoteFeeBudget, dispatchDeadline, nonce
        );
    }

    function _stageWithdraw(
        address requester,
        address account,
        uint256 shares,
        address recipient,
        uint256 minimumAssets,
        uint256 remoteFeeBudget,
        uint64 dispatchDeadline,
        uint64 nonce
    ) internal returns (bytes32 requestId) {
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
        IXcmWrapperV22.RequestParameters memory parameters = IXcmWrapperV22.RequestParameters({
            sellAmount: shares,
            minimumOutput: minimumAssets,
            maxFeePerLeg: remoteFeeBudget,
            dispatchDeadline: dispatchDeadline
        });
        requestId = xcmWrapper.previewRequestId(context);
        AdapterRequest storage request = requests[requestId];
        if (request.requester == address(0)) {
            pendingWithdrawalShares += shares;
            requests[requestId] = AdapterRequest({
                kind: IXcmWrapper.RequestKind.Withdraw,
                status: IXcmWrapper.RequestStatus.Pending,
                account: account,
                requester: requester,
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
            if (requester != agentAccountCore) {
                emit TreasuryRequestStaged(requestId, IXcmWrapper.RequestKind.Withdraw, requester, account, shares);
            }
        } else if (request.requester != requester) {
            revert Unauthorized();
        }
        xcmWrapper.queueRequest(context, parameters);
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
        uint256 observedRemoteBalanceRaw,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external nonReentrant onlyOperator {
        if (status == IXcmWrapper.RequestStatus.Unknown || status == IXcmWrapper.RequestStatus.Pending) {
            revert InvalidStatus();
        }
        AdapterRequest storage request = requests[requestId];
        if (request.requester == address(0)) revert InvalidRequest();
        if (request.settled) revert AlreadySettled();
        if (policy.paused() && status == IXcmWrapper.RequestStatus.Succeeded) revert ProtocolPaused();
        if (status == IXcmWrapper.RequestStatus.Succeeded) {
            if (observedRemoteBalanceRaw != 0) revert InvalidRequest();
            _validateSuccessfulSettlement(request, settledAssets, settledShares);
        } else if (settledAssets != 0 || settledShares != 0) {
            revert InvalidStatus();
        }

        xcmWrapper.finalizeRequest(requestId, status, settledAssets, settledShares, remoteRef, failureCode);

        if (request.kind == IXcmWrapper.RequestKind.Deposit) {
            pendingDepositAssets -= request.requestedAssets;
            if (status == IXcmWrapper.RequestStatus.Succeeded) {
                totalAssets += settledAssets;
                totalShares += settledShares;
            } else if (fundingReleased[requestId]) {
                _recordTerminalAccounting(requestId, request.requestedAssets, observedRemoteBalanceRaw);
            } else {
                if (observedRemoteBalanceRaw != 0) revert InvalidRequest();
                SafeTransfer.safeTransfer(asset, request.requester, request.requestedAssets);
                emit TerminalAccounting(requestId, request.requestedAssets, 0, 0);
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
            } else {
                _recordTerminalAccounting(requestId, request.requestedShares, observedRemoteBalanceRaw);
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

    function writeOffResidue(bytes32 requestId, uint256 amountRaw, bytes32 reasonCode) external onlyOwner {
        AdapterRequest storage request = requests[requestId];
        uint256 outstanding = recoveryAssetsOutstanding[requestId];
        if (
            request.requester == address(0) || !request.settled
                || (request.status != IXcmWrapper.RequestStatus.Failed
                    && request.status != IXcmWrapper.RequestStatus.Cancelled) || amountRaw == 0
                || amountRaw > outstanding || reasonCode == bytes32(0)
        ) revert InvalidRequest();
        uint256 remaining = outstanding - amountRaw;
        recoveryAssetsOutstanding[requestId] = remaining;
        if (remaining == 0) requiresRemoteRecovery[requestId] = false;
        emit ResidueWrittenOff(requestId, amountRaw, reasonCode, remaining);
    }

    function releaseRecoveredAssets(bytes32 requestId, address recipient, uint256 assets) external override {
        AdapterRequest storage request = requests[requestId];
        if (msg.sender != request.requester || recipient != request.requester) revert Unauthorized();
        if (!requiresRemoteRecovery[requestId] || assets == 0 || assets > recoveryAssetsOutstanding[requestId]) {
            revert InvalidRequest();
        }
        if (request.kind == IXcmWrapper.RequestKind.Withdraw) {
            if (assets > totalShares || assets > totalAssets) revert InsufficientLiquidity();
            totalShares -= assets;
            totalAssets -= assets;
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

    /// @notice Reconcile a settled, exclusive adapter deployment to the observed
    ///         rebasing aUSDC position. Packet-2 pool adapters use a dedicated
    ///         HydrationUsdcAdapterV22 instance, so the observation is the full book.
    function recordRemotePosition(uint256 assets, uint64 asOf, bytes32 remoteRef) external onlyOperator {
        if (
            asOf == 0 || asOf <= remotePositionAsOf || remoteRef == bytes32(0) || pendingDepositAssets != 0
                || pendingWithdrawalShares != 0
        ) revert InvalidRequest();
        totalAssets = assets;
        // aUSDC is rebasing and remains 1:1 with USDC-denominated assets.
        totalShares = assets;
        remotePositionAsOf = asOf;
        remotePositionRef = remoteRef;
        emit RemotePositionObserved(assets, assets, asOf, remoteRef);
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
        return "Async Hydration USDC supply; observer-capped terminal recovery accounting.";
    }

    function _recordTerminalAccounting(bytes32 requestId, uint256 requested, uint256 observed) internal {
        uint256 outstanding = observed < requested ? observed : requested;
        recoveryAssetsOutstanding[requestId] = outstanding;
        requiresRemoteRecovery[requestId] = outstanding != 0;
        emit TerminalAccounting(requestId, requested, observed, outstanding);
        if (outstanding != 0) emit RemoteRecoveryRequired(requestId, outstanding);
    }

    function _validateSuccessfulSettlement(AdapterRequest storage request, uint256 settledAssets, uint256 settledShares)
        internal
        view
    {
        if (request.kind == IXcmWrapper.RequestKind.Deposit) {
            if (settledAssets == 0 || settledShares == 0) revert InvalidStatus();
            if (settledShares != _sharesForAssets(settledAssets)) revert InvalidSettlementRatio();
            return;
        }
        if (request.kind == IXcmWrapper.RequestKind.Withdraw) {
            if (settledAssets == 0) revert InvalidStatus();
            if (settledAssets > _assetsForShares(request.requestedShares)) revert InvalidSettlementRatio();
            return;
        }
        revert InvalidRequest();
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
