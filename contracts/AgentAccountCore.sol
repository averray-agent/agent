// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "./StrategyAdapterRegistry.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";
import {IXcmStrategyAdapter} from "./interfaces/IXcmStrategyAdapter.sol";
import {IXcmWrapper} from "./interfaces/IXcmWrapper.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";

contract AgentAccountCore is ReentrancyGuard {
    TreasuryPolicy public immutable policy;
    StrategyAdapterRegistry public immutable registry;

    struct AssetPosition {
        uint256 liquid;
        uint256 reserved;
        uint256 strategyAllocated;
        uint256 collateralLocked;
        uint256 jobStakeLocked;
        uint256 debtOutstanding;
    }

    struct StrategyRequest {
        bytes32 strategyId;
        address adapter;
        address account;
        address asset;
        address recipient;
        IXcmWrapper.RequestKind kind;
        IXcmWrapper.RequestStatus status;
        uint256 requestedAssets;
        uint256 requestedShares;
        uint256 settledAssets;
        uint256 settledShares;
        bytes32 remoteRef;
        bytes32 failureCode;
        bool settled;
    }

    struct StrategyDepositRequestParams {
        bytes32 strategyId;
        uint256 amount;
        bytes destination;
        bytes message;
        IXcmWrapper.Weight maxWeight;
        uint64 nonce;
    }

    struct StrategyWithdrawRequestParams {
        bytes32 strategyId;
        uint256 shares;
        address recipient;
        bytes destination;
        bytes message;
        IXcmWrapper.Weight maxWeight;
        uint64 nonce;
    }

    mapping(address => mapping(address => AssetPosition)) public positions;
    mapping(address => mapping(bytes32 => uint256)) public strategyShares;
    mapping(bytes32 => StrategyRequest) public strategyRequests;
    mapping(address => mapping(address => uint256)) public pendingStrategyAssets;
    mapping(address => mapping(bytes32 => uint256)) public pendingStrategyWithdrawalShares;

    event Deposited(address indexed account, address indexed asset, uint256 amount);
    event Withdrawn(address indexed account, address indexed asset, uint256 amount);
    event Reserved(address indexed account, address indexed asset, uint256 amount);
    event ReservationReleased(address indexed account, address indexed asset, uint256 amount);
    event ReservationSettled(address indexed account, address indexed recipient, address indexed asset, uint256 amount);
    event StrategyAllocated(address indexed account, bytes32 indexed strategyId, address indexed asset, uint256 amount);
    event StrategyDeallocated(address indexed account, bytes32 indexed strategyId, address indexed asset, uint256 amount);
    event StrategyRequestQueued(
        address indexed account,
        bytes32 indexed strategyId,
        bytes32 indexed requestId,
        IXcmWrapper.RequestKind kind,
        uint256 requestedAssets,
        uint256 requestedShares,
        address recipient
    );
    event StrategyRequestSettled(
        address indexed account,
        bytes32 indexed strategyId,
        bytes32 indexed requestId,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        address recipient
    );
    event CollateralLocked(address indexed account, address indexed asset, uint256 amount);
    event CollateralUnlocked(address indexed account, address indexed asset, uint256 amount);
    event JobStakeLocked(address indexed account, address indexed asset, uint256 amount);
    event JobStakeReleased(address indexed account, address indexed asset, uint256 amount);
    event JobStakeSlashed(
        address indexed account,
        address indexed asset,
        uint256 amount,
        uint256 posterAmount,
        uint256 treasuryAmount
    );
    event ClaimFeeSlashed(
        address indexed account,
        address indexed asset,
        uint256 amount,
        address indexed verifierRecipient,
        uint256 verifierAmount,
        uint256 treasuryAmount
    );
    event Borrowed(address indexed account, address indexed asset, uint256 amount);
    event Repaid(address indexed account, address indexed asset, uint256 amount);
    event AgentTransfer(address indexed from, address indexed to, address indexed asset, uint256 amount);

    error Unauthorized();
    error UnsupportedAsset();
    error InsufficientLiquidity();
    error InsufficientReserved();
    error BorrowLimitExceeded();
    error InsolventAccount();
    error ProtocolPaused();
    error InvalidRecipient();
    error ZeroAmount();
    error InvalidStrategy();
    error InvalidStrategyRequest();

    constructor(TreasuryPolicy policy_, StrategyAdapterRegistry registry_) {
        policy = policy_;
        registry = registry_;
    }

    modifier onlyOwnerOrOperator(address account) {
        if (msg.sender != account && !policy.serviceOperators(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (!policy.serviceOperators(msg.sender)) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (policy.paused()) revert ProtocolPaused();
        _;
    }

    modifier onlySupportedAsset(address asset) {
        if (!policy.approvedAssets(asset)) revert UnsupportedAsset();
        _;
    }

    function deposit(address asset, uint256 amount) external nonReentrant whenNotPaused onlySupportedAsset(asset) {
        require(amount > 0, "ZERO_AMOUNT");
        positions[msg.sender][asset].liquid += amount;
        SafeTransfer.safeTransferFrom(asset, msg.sender, address(this), amount);
        emit Deposited(msg.sender, asset, amount);
    }

    function withdraw(address asset, uint256 amount) external nonReentrant whenNotPaused onlySupportedAsset(asset) {
        AssetPosition storage position = positions[msg.sender][asset];
        if (position.liquid < amount) revert InsufficientLiquidity();
        position.liquid -= amount;
        SafeTransfer.safeTransfer(asset, msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount);
    }

    function reserveForJob(address account, address asset, uint256 amount) external whenNotPaused onlyOwnerOrOperator(account) onlySupportedAsset(asset) {
        AssetPosition storage position = positions[account][asset];
        if (position.liquid < amount) revert InsufficientLiquidity();
        position.liquid -= amount;
        position.reserved += amount;
        emit Reserved(account, asset, amount);
    }

    function refundReserved(address account, address asset, uint256 amount) external onlyOperator {
        AssetPosition storage position = positions[account][asset];
        if (position.reserved < amount) revert InsufficientReserved();
        position.reserved -= amount;
        position.liquid += amount;
        emit ReservationReleased(account, asset, amount);
    }

    function settleReservedTo(address account, address asset, address recipient, uint256 amount)
        external
        nonReentrant
        onlyOperator
    {
        AssetPosition storage position = positions[account][asset];
        if (position.reserved < amount) revert InsufficientReserved();
        position.reserved -= amount;
        policy.recordOutflow(amount);
        SafeTransfer.safeTransfer(asset, recipient, amount);
        emit ReservationSettled(account, recipient, asset, amount);
    }

    function allocateIdleFunds(address account, bytes32 strategyId, uint256 amount) external whenNotPaused onlyOwnerOrOperator(account) {
        if (amount == 0) revert ZeroAmount();
        StrategyAdapterRegistry.StrategyMetadata memory strategy = registry.getStrategy(strategyId);
        if (strategy.adapter == address(0) || !strategy.active) revert InvalidStrategy();
        if (_supportsAsyncStrategyAdapter(strategy.adapter)) revert InvalidStrategy();
        AssetPosition storage position = positions[account][strategy.asset];
        if (position.liquid < amount) revert InsufficientLiquidity();

        IStrategyAdapter adapter = IStrategyAdapter(strategy.adapter);
        position.liquid -= amount;
        SafeTransfer.safeApprove(strategy.asset, strategy.adapter, 0);
        SafeTransfer.safeApprove(strategy.asset, strategy.adapter, amount);
        uint256 sharesMinted = adapter.deposit(amount);
        strategyShares[account][strategyId] += sharesMinted;
        _refreshStrategyAllocated(account, strategy.asset);
        emit StrategyAllocated(account, strategyId, strategy.asset, amount);
    }

    function deallocateIdleFunds(address account, bytes32 strategyId, uint256 amount) external whenNotPaused onlyOwnerOrOperator(account) {
        if (amount == 0) revert ZeroAmount();
        StrategyAdapterRegistry.StrategyMetadata memory strategy = registry.getStrategy(strategyId);
        if (strategy.adapter == address(0) || !strategy.active) revert InvalidStrategy();
        if (_supportsAsyncStrategyAdapter(strategy.adapter)) revert InvalidStrategy();
        AssetPosition storage position = positions[account][strategy.asset];
        IStrategyAdapter adapter = IStrategyAdapter(strategy.adapter);
        uint256 accountShares = strategyShares[account][strategyId];
        uint256 maxAssets = _assetValueForShares(accountShares, adapter.totalAssets(), adapter.totalShares());
        if (maxAssets < amount) revert InsufficientLiquidity();

        uint256 sharesToBurn = _sharesForAssetsRoundedUp(amount, adapter.totalAssets(), adapter.totalShares());
        if (sharesToBurn > accountShares) {
            sharesToBurn = accountShares;
        }

        uint256 assetsReturned = adapter.withdraw(sharesToBurn, address(this));
        strategyShares[account][strategyId] = accountShares - sharesToBurn;
        position.liquid += assetsReturned;
        _refreshStrategyAllocated(account, strategy.asset);
        emit StrategyDeallocated(account, strategyId, strategy.asset, assetsReturned);
    }

    function requestStrategyDeposit(address account, StrategyDepositRequestParams calldata params)
        external
        whenNotPaused
        onlyOwnerOrOperator(account)
        returns (bytes32 requestId)
    {
        if (params.amount == 0) revert ZeroAmount();

        (address adapterAddress, address asset) = _requireActiveStrategy(params.strategyId);

        requestId = _previewDepositRequestId(params.strategyId, account, asset, params.amount, params.nonce);

        if (strategyRequests[requestId].account == address(0)) {
            _createPendingDepositRequest(params.strategyId, adapterAddress, asset, account, requestId, params.amount);
        }

        require(
            _requireAsyncStrategyAdapter(adapterAddress).requestDeposit(
                account,
                params.amount,
                params.destination,
                params.message,
                params.maxWeight,
                params.nonce
            ) == requestId,
            "REQUEST_ID_MISMATCH"
        );
    }

    function requestStrategyWithdraw(address account, StrategyWithdrawRequestParams calldata params)
        external
        whenNotPaused
        onlyOwnerOrOperator(account)
        returns (bytes32 requestId)
    {
        if (params.shares == 0) revert ZeroAmount();
        if (params.recipient == address(0)) revert InvalidRecipient();

        if (strategyShares[account][params.strategyId] < pendingStrategyWithdrawalShares[account][params.strategyId] + params.shares) {
            revert InsufficientLiquidity();
        }

        (address adapterAddress, address asset) = _requireActiveStrategy(params.strategyId);

        requestId = _previewWithdrawRequestId(params.strategyId, account, asset, params.recipient, params.shares, params.nonce);

        if (strategyRequests[requestId].account == address(0)) {
            _createPendingWithdrawRequest(
                params.strategyId,
                adapterAddress,
                asset,
                account,
                requestId,
                params.shares,
                params.recipient
            );
        }

        require(
            _requireAsyncStrategyAdapter(adapterAddress).requestWithdraw(
                account,
                params.shares,
                params.recipient,
                params.destination,
                params.message,
                params.maxWeight,
                params.nonce
            ) == requestId,
            "REQUEST_ID_MISMATCH"
        );
    }

    function settleStrategyRequest(
        bytes32 requestId,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external whenNotPaused onlyOperator {
        if (status == IXcmWrapper.RequestStatus.Unknown || status == IXcmWrapper.RequestStatus.Pending) {
            revert InvalidStrategyRequest();
        }

        StrategyRequest storage request = strategyRequests[requestId];
        if (request.account == address(0)) revert InvalidStrategyRequest();
        if (request.settled) {
            if (
                request.status == status &&
                request.settledAssets == settledAssets &&
                request.settledShares == settledShares &&
                request.remoteRef == remoteRef &&
                request.failureCode == failureCode
            ) {
                return;
            }
            revert InvalidStrategyRequest();
        }

        IXcmStrategyAdapter(request.adapter).settleRequest(
            requestId,
            status,
            settledAssets,
            settledShares,
            remoteRef,
            failureCode
        );

        if (request.kind == IXcmWrapper.RequestKind.Deposit) {
            pendingStrategyAssets[request.account][request.asset] -= request.requestedAssets;
            if (status == IXcmWrapper.RequestStatus.Succeeded) {
                strategyShares[request.account][request.strategyId] += settledShares;
            } else {
                positions[request.account][request.asset].liquid += request.requestedAssets;
            }
        } else if (request.kind == IXcmWrapper.RequestKind.Withdraw) {
            pendingStrategyWithdrawalShares[request.account][request.strategyId] -= request.requestedShares;
            if (status == IXcmWrapper.RequestStatus.Succeeded) {
                uint256 accountShares = strategyShares[request.account][request.strategyId];
                if (accountShares < request.requestedShares) revert InsufficientLiquidity();
                strategyShares[request.account][request.strategyId] = accountShares - request.requestedShares;
                if (request.recipient == address(this)) {
                    positions[request.account][request.asset].liquid += settledAssets;
                }
            }
        } else {
            revert InvalidStrategyRequest();
        }

        request.status = status;
        request.settledAssets = settledAssets;
        request.settledShares = settledShares;
        request.remoteRef = remoteRef;
        request.failureCode = failureCode;
        request.settled = true;

        _refreshStrategyAllocated(request.account, request.asset);
        emit StrategyRequestSettled(
            request.account,
            request.strategyId,
            requestId,
            status,
            settledAssets,
            settledShares,
            request.recipient
        );
    }

    function lockCollateral(address asset, uint256 amount) external whenNotPaused onlySupportedAsset(asset) {
        AssetPosition storage position = positions[msg.sender][asset];
        if (position.liquid < amount) revert InsufficientLiquidity();
        position.liquid -= amount;
        position.collateralLocked += amount;
        emit CollateralLocked(msg.sender, asset, amount);
    }

    function unlockCollateral(address asset, uint256 amount) external whenNotPaused onlySupportedAsset(asset) {
        AssetPosition storage position = positions[msg.sender][asset];
        require(position.collateralLocked >= amount, "INSUFFICIENT_COLLATERAL");
        position.collateralLocked -= amount;
        position.liquid += amount;
        if (!_isHealthy(position.collateralLocked, position.debtOutstanding)) revert InsolventAccount();
        emit CollateralUnlocked(msg.sender, asset, amount);
    }

    function borrow(address asset, uint256 amount) external whenNotPaused onlySupportedAsset(asset) {
        AssetPosition storage position = positions[msg.sender][asset];
        if (position.debtOutstanding + amount > policy.perAccountBorrowCap()) revert BorrowLimitExceeded();
        if (!_isHealthy(position.collateralLocked, position.debtOutstanding + amount)) revert InsolventAccount();
        position.debtOutstanding += amount;
        position.liquid += amount;
        emit Borrowed(msg.sender, asset, amount);
    }

    function repay(address asset, uint256 amount) external nonReentrant whenNotPaused onlySupportedAsset(asset) {
        AssetPosition storage position = positions[msg.sender][asset];
        require(position.debtOutstanding >= amount, "OVERPAY");
        position.debtOutstanding -= amount;
        SafeTransfer.safeTransferFrom(asset, msg.sender, address(this), amount);
        emit Repaid(msg.sender, asset, amount);
    }

    function lockJobStake(address account, address asset, uint256 amount)
        external
        onlyOperator
        whenNotPaused
        onlySupportedAsset(asset)
    {
        if (amount == 0) {
            return;
        }

        AssetPosition storage position = positions[account][asset];
        if (position.liquid < amount) revert InsufficientLiquidity();
        position.liquid -= amount;
        position.jobStakeLocked += amount;
        emit JobStakeLocked(account, asset, amount);
    }

    function releaseJobStake(address account, address asset, uint256 amount)
        external
        onlyOperator
        whenNotPaused
        onlySupportedAsset(asset)
    {
        if (amount == 0) {
            return;
        }

        AssetPosition storage position = positions[account][asset];
        require(position.jobStakeLocked >= amount, "INSUFFICIENT_STAKE");
        position.jobStakeLocked -= amount;
        position.liquid += amount;
        emit JobStakeReleased(account, asset, amount);
    }

    function slashJobStake(address account, address asset, uint256 amount, address posterRecipient)
        external
        nonReentrant
        onlyOperator
        whenNotPaused
        onlySupportedAsset(asset)
    {
        if (amount == 0) {
            return;
        }

        AssetPosition storage position = positions[account][asset];
        require(position.jobStakeLocked >= amount, "INSUFFICIENT_STAKE");
        position.jobStakeLocked -= amount;

        uint256 posterAmount = amount / 2;
        uint256 treasuryAmount = amount - posterAmount;

        if (posterAmount > 0) {
            SafeTransfer.safeTransfer(asset, posterRecipient, posterAmount);
        }
        if (treasuryAmount > 0) {
            policy.recordOutflow(treasuryAmount);
        }

        emit JobStakeSlashed(account, asset, amount, posterAmount, treasuryAmount);
    }

    function slashClaimFee(address account, address asset, uint256 amount, address verifierRecipient)
        external
        nonReentrant
        onlyOperator
        whenNotPaused
        onlySupportedAsset(asset)
    {
        if (amount == 0) {
            return;
        }

        AssetPosition storage position = positions[account][asset];
        require(position.jobStakeLocked >= amount, "INSUFFICIENT_STAKE");
        position.jobStakeLocked -= amount;

        uint256 verifierAmount = verifierRecipient == address(0) ? 0 : (amount * policy.claimFeeVerifierBps()) / 10_000;
        uint256 treasuryAmount = amount - verifierAmount;

        if (verifierAmount > 0) {
            SafeTransfer.safeTransfer(asset, verifierRecipient, verifierAmount);
        }
        if (treasuryAmount > 0) {
            policy.recordOutflow(treasuryAmount);
        }

        emit ClaimFeeSlashed(account, asset, amount, verifierRecipient, verifierAmount, treasuryAmount);
    }

    /**
     * Move liquid balance from the caller's account to another agent's
     * account within the platform. No external ERC20 transfer happens —
     * this is a pure bookkeeping update between two `liquid` entries.
     *
     * Payers must already be funded on-platform (they've deposited the
     * asset). Recipients see the amount land in their own `liquid`
     * bucket and can `withdraw` it to their external wallet whenever
     * they want; nothing here touches external tokens or approvals.
     *
     * Because there's no external call, no ReentrancyGuard is needed —
     * every state update is bounded by a single uint256 arithmetic pair.
     */
    function sendToAgent(address recipient, address asset, uint256 amount)
        external
        whenNotPaused
        onlySupportedAsset(asset)
    {
        _sendToAgent(msg.sender, recipient, asset, amount);
    }

    /**
     * Operator-initiated variant of `sendToAgent`. Used by the HTTP
     * backend when relaying a user-authorised transfer: the backend's
     * signer (a service operator) calls this on behalf of `from`, which
     * must have authenticated via SIWE so the backend is confident it is
     * acting on the right wallet's behalf. Policy gating is strict —
     * only service operators can invoke this path.
     */
    function sendToAgentFor(address from, address recipient, address asset, uint256 amount)
        external
        whenNotPaused
        onlyOperator
        onlySupportedAsset(asset)
    {
        _sendToAgent(from, recipient, asset, amount);
    }

    function _sendToAgent(address from, address recipient, address asset, uint256 amount) internal {
        if (recipient == address(0) || recipient == from) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        AssetPosition storage fromPos = positions[from][asset];
        if (fromPos.liquid < amount) revert InsufficientLiquidity();
        fromPos.liquid -= amount;
        positions[recipient][asset].liquid += amount;
        emit AgentTransfer(from, recipient, asset, amount);
    }

    function getBorrowCapacity(address account, address asset) external view returns (uint256) {
        AssetPosition memory position = positions[account][asset];
        uint256 maxDebt = position.collateralLocked * 10_000 / policy.minimumCollateralRatioBps();
        if (maxDebt <= position.debtOutstanding) {
            return 0;
        }
        uint256 remaining = maxDebt - position.debtOutstanding;
        uint256 cap = policy.perAccountBorrowCap();
        if (position.debtOutstanding >= cap) {
            return 0;
        }
        uint256 capRemaining = cap - position.debtOutstanding;
        return remaining < capRemaining ? remaining : capRemaining;
    }

    function _isHealthy(uint256 collateralLocked, uint256 debtOutstanding) internal view returns (bool) {
        if (debtOutstanding == 0) return true;
        return collateralLocked * 10_000 >= debtOutstanding * policy.minimumCollateralRatioBps();
    }

    function _assetValueForShares(uint256 shares, uint256 totalAssets_, uint256 totalShares_) internal pure returns (uint256) {
        if (shares == 0 || totalAssets_ == 0 || totalShares_ == 0) {
            return 0;
        }
        return (shares * totalAssets_) / totalShares_;
    }

    function _sharesForAssetsRoundedUp(uint256 assets, uint256 totalAssets_, uint256 totalShares_) internal pure returns (uint256) {
        if (assets == 0 || totalAssets_ == 0 || totalShares_ == 0) {
            return 0;
        }
        return ((assets * totalShares_) + totalAssets_ - 1) / totalAssets_;
    }

    function _refreshStrategyAllocated(address account, address asset) internal {
        bytes32[] memory ids = registry.listStrategyIds();
        uint256 totalAllocated;
        for (uint256 i = 0; i < ids.length; i++) {
            StrategyAdapterRegistry.StrategyMetadata memory strategy = registry.getStrategy(ids[i]);
            if (strategy.adapter == address(0) || strategy.asset != asset) {
                continue;
            }
            uint256 shares = strategyShares[account][ids[i]];
            if (shares == 0) {
                continue;
            }
            IStrategyAdapter adapter = IStrategyAdapter(strategy.adapter);
            totalAllocated += _assetValueForShares(shares, adapter.totalAssets(), adapter.totalShares());
        }
        positions[account][asset].strategyAllocated = totalAllocated;
    }

    function _createPendingDepositRequest(
        bytes32 strategyId,
        address adapter,
        address asset,
        address account,
        bytes32 requestId,
        uint256 amount
    ) internal {
        AssetPosition storage position = positions[account][asset];
        if (position.liquid < amount) revert InsufficientLiquidity();

        position.liquid -= amount;
        pendingStrategyAssets[account][asset] += amount;
        strategyRequests[requestId] = StrategyRequest({
            strategyId: strategyId,
            adapter: adapter,
            account: account,
            asset: asset,
            recipient: account,
            kind: IXcmWrapper.RequestKind.Deposit,
            status: IXcmWrapper.RequestStatus.Pending,
            requestedAssets: amount,
            requestedShares: 0,
            settledAssets: 0,
            settledShares: 0,
            remoteRef: bytes32(0),
            failureCode: bytes32(0),
            settled: false
        });

        SafeTransfer.safeApprove(asset, adapter, 0);
        SafeTransfer.safeApprove(asset, adapter, amount);
        emit StrategyRequestQueued(
            account,
            strategyId,
            requestId,
            IXcmWrapper.RequestKind.Deposit,
            amount,
            0,
            account
        );
    }

    function _createPendingWithdrawRequest(
        bytes32 strategyId,
        address adapter,
        address asset,
        address account,
        bytes32 requestId,
        uint256 shares,
        address recipient
    ) internal {
        pendingStrategyWithdrawalShares[account][strategyId] += shares;
        strategyRequests[requestId] = StrategyRequest({
            strategyId: strategyId,
            adapter: adapter,
            account: account,
            asset: asset,
            recipient: recipient,
            kind: IXcmWrapper.RequestKind.Withdraw,
            status: IXcmWrapper.RequestStatus.Pending,
            requestedAssets: 0,
            requestedShares: shares,
            settledAssets: 0,
            settledShares: 0,
            remoteRef: bytes32(0),
            failureCode: bytes32(0),
            settled: false
        });

        emit StrategyRequestQueued(
            account,
            strategyId,
            requestId,
            IXcmWrapper.RequestKind.Withdraw,
            0,
            shares,
            recipient
        );
    }

    function _requireActiveStrategy(bytes32 strategyId) internal view returns (address adapter, address asset) {
        StrategyAdapterRegistry.StrategyMetadata memory strategy = registry.getStrategy(strategyId);
        if (strategy.adapter == address(0) || !strategy.active) revert InvalidStrategy();
        return (strategy.adapter, strategy.asset);
    }

    function _requireAsyncStrategyAdapter(address adapter) internal view returns (IXcmStrategyAdapter) {
        if (!_supportsAsyncStrategyAdapter(adapter)) revert InvalidStrategy();
        return IXcmStrategyAdapter(adapter);
    }

    function _supportsAsyncStrategyAdapter(address adapter) internal view returns (bool) {
        (bool ok,) = adapter.staticcall(abi.encodeWithSelector(IXcmStrategyAdapter.pendingDepositAssets.selector));
        return ok;
    }

    function _previewStrategyRequestId(
        bytes32 strategyId,
        IXcmWrapper.RequestKind kind,
        address account,
        address asset,
        address recipient,
        uint256 assets,
        uint256 shares,
        uint64 nonce
    ) internal pure returns (bytes32 requestId) {
        return keccak256(abi.encode(strategyId, kind, account, asset, recipient, assets, shares, nonce));
    }

    function _previewDepositRequestId(
        bytes32 strategyId,
        address account,
        address asset,
        uint256 amount,
        uint64 nonce
    ) internal pure returns (bytes32 requestId) {
        return _previewStrategyRequestId(
            strategyId,
            IXcmWrapper.RequestKind.Deposit,
            account,
            asset,
            account,
            amount,
            0,
            nonce
        );
    }

    function _previewWithdrawRequestId(
        bytes32 strategyId,
        address account,
        address asset,
        address recipient,
        uint256 shares,
        uint64 nonce
    ) internal pure returns (bytes32 requestId) {
        return _previewStrategyRequestId(
            strategyId,
            IXcmWrapper.RequestKind.Withdraw,
            account,
            asset,
            recipient,
            0,
            shares,
            nonce
        );
    }
}
