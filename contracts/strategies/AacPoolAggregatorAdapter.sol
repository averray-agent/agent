// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DepositPoolV2} from "../DepositPoolV2.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

interface IERC20AggregatorAsset {
    function balanceOf(address account) external view returns (uint256);
}

/// @title AAC idle-balance DepositPool v2.1 aggregator
/// @notice Synchronous AAC strategy adapter that nets opted-in idle balances in
///         float and lets the operator sweep aggregate liquidity into the pool.
/// @dev Operational precondition: AgentAccountCore must hold DOT postage for the
///      non-zero USDC approval performed by allocateIdleFunds.
/// @dev Operational precondition: This adapter must hold DOT postage for the
///      non-zero USDC approval performed by sweepToPool.
/// @dev Notice exits are deliberately asynchronous only at the adapter-to-pool
///      boundary. AAC withdrawals remain synchronous while float covers them.
contract AacPoolAggregatorAdapter is IStrategyAdapter, ReentrancyGuard {
    bytes32 public constant override strategyId = 0x4141435f49444c455f4445504f5349545f504f4f4c5f56323100000000000000; // "AAC_IDLE_DEPOSIT_POOL_V21"

    address public immutable agentAccountCore;
    DepositPoolV2 public immutable pool;
    address public immutable override asset;
    address public immutable operator;

    uint256 public override totalShares;

    event Deposited(uint256 assets, uint256 shares);
    event Withdrawn(uint256 shares, uint256 assets);
    event SweptToPool(uint256 assets, uint256 poolShares);
    event FloatExitRequested(uint256 indexed requestId, uint256 poolShares, DepositPoolV2.NoticeTier tier);
    event FloatExitFulfilled(uint256 indexed requestId, uint256 assets);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    error InvalidPool();
    error InvalidRecipient(address recipient);
    error InvalidRedeemRequest(uint256 requestId);
    error InsufficientShares(uint256 available, uint256 required);
    error FloatExhausted(uint256 available, uint256 required);
    error InsolventSharePrice();
    error AssetTransferAmountMismatch();

    modifier onlyAgentAccountCore() {
        if (msg.sender != agentAccountCore) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address agentAccountCore_, DepositPoolV2 pool_) {
        if (agentAccountCore_ == address(0) || address(pool_) == address(0)) revert ZeroAddress();
        if (address(pool_).code.length == 0) revert InvalidPool();

        address asset_ = pool_.asset();
        address operator_ = pool_.operator();
        if (asset_ == address(0) || operator_ == address(0)) revert InvalidPool();

        agentAccountCore = agentAccountCore_;
        pool = pool_;
        asset = asset_;
        operator = operator_;
    }

    /// @inheritdoc IStrategyAdapter
    function deposit(uint256 amount)
        external
        override
        onlyAgentAccountCore
        nonReentrant
        returns (uint256 sharesMinted)
    {
        if (amount == 0) revert ZeroAmount();

        uint256 sharesBefore = totalShares;
        uint256 assetsBefore = totalAssets();
        if (sharesBefore == 0) {
            sharesMinted = amount;
        } else {
            if (assetsBefore == 0) revert InsolventSharePrice();
            sharesMinted = (amount * sharesBefore) / assetsBefore;
            if (sharesMinted == 0) revert ZeroShares();
        }

        totalShares = sharesBefore + sharesMinted;
        uint256 floatBefore = floatAssets();
        SafeTransfer.safeTransferFrom(asset, msg.sender, address(this), amount);
        if (floatAssets() - floatBefore != amount) revert AssetTransferAmountMismatch();
        emit Deposited(amount, sharesMinted);
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 shares, address recipient)
        external
        override
        onlyAgentAccountCore
        nonReentrant
        returns (uint256 assetsReturned)
    {
        if (shares == 0) revert ZeroAmount();
        if (recipient != agentAccountCore) revert InvalidRecipient(recipient);

        uint256 sharesBefore = totalShares;
        if (shares > sharesBefore) revert InsufficientShares(sharesBefore, shares);
        assetsReturned = (shares * totalAssets()) / sharesBefore;
        if (assetsReturned == 0) revert ZeroAmount();

        uint256 available = floatAssets();
        if (assetsReturned > available) revert FloatExhausted(available, assetsReturned);

        totalShares = sharesBefore - shares;
        SafeTransfer.safeTransfer(asset, agentAccountCore, assetsReturned);
        emit Withdrawn(shares, assetsReturned);
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() public view override returns (uint256) {
        return floatAssets() + pool.convertToAssets(pool.balanceOf(address(this)));
    }

    /// @inheritdoc IStrategyAdapter
    function maxWithdraw(address account) external view override returns (uint256) {
        if (account != agentAccountCore || totalShares == 0) return 0;
        return floatAssets();
    }

    /// @inheritdoc IStrategyAdapter
    function riskLabel() external pure override returns (string memory) {
        return "Aggregated opt-in AAC idle USDC routed through DepositPool v2.1; pool capital may be deployed to an external venue, principal is at risk, and synchronous exit is limited to uncommitted adapter float.";
    }

    function floatAssets() public view returns (uint256) {
        return IERC20AggregatorAsset(asset).balanceOf(address(this));
    }

    /// @notice Move uncommitted float into the adapter's own pool position.
    function sweepToPool(uint256 assets) external onlyOperator nonReentrant returns (uint256 poolShares) {
        if (assets == 0) revert ZeroAmount();
        uint256 available = floatAssets();
        if (assets > available) revert FloatExhausted(available, assets);

        SafeTransfer.safeApprove(asset, address(pool), 0);
        SafeTransfer.safeApprove(asset, address(pool), assets);
        poolShares = pool.deposit(assets, address(this));
        emit SweptToPool(assets, poolShares);
    }

    /// @notice Lock pool shares for a notice exit whose proceeds can only land in adapter float.
    function requestFloatExit(uint256 poolShares, DepositPoolV2.NoticeTier tier)
        external
        onlyOperator
        nonReentrant
        returns (uint256 requestId)
    {
        requestId = pool.requestRedeem(poolShares, address(this), tier);
        emit FloatExitRequested(requestId, poolShares, tier);
    }

    /// @notice Fulfil this adapter's matured pool exit into its own float.
    function fulfilFloatExit(uint256 requestId) external onlyOperator nonReentrant returns (uint256 assetsReturned) {
        (address owner, address receiver,,,, bool fulfilled) = pool.redeemRequests(requestId);
        if (owner != address(this) || receiver != address(this) || fulfilled) {
            revert InvalidRedeemRequest(requestId);
        }

        uint256 floatBefore = floatAssets();
        assetsReturned = pool.fulfilRedeem(requestId);
        if (floatAssets() - floatBefore != assetsReturned) revert AssetTransferAmountMismatch();
        emit FloatExitFulfilled(requestId, assetsReturned);
    }
}
