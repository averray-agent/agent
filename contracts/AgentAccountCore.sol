// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "./StrategyAdapterRegistry.sol";
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

    mapping(address => mapping(address => AssetPosition)) public positions;
    mapping(address => mapping(bytes32 => uint256)) public strategyShares;

    event Deposited(address indexed account, address indexed asset, uint256 amount);
    event Withdrawn(address indexed account, address indexed asset, uint256 amount);
    event Reserved(address indexed account, address indexed asset, uint256 amount);
    event ReservationReleased(address indexed account, address indexed asset, uint256 amount);
    event ReservationSettled(address indexed account, address indexed recipient, address indexed asset, uint256 amount);
    event StrategyAllocated(address indexed account, bytes32 indexed strategyId, address indexed asset, uint256 amount);
    event StrategyDeallocated(address indexed account, bytes32 indexed strategyId, address indexed asset, uint256 amount);
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
    event Borrowed(address indexed account, address indexed asset, uint256 amount);
    event Repaid(address indexed account, address indexed asset, uint256 amount);

    error Unauthorized();
    error UnsupportedAsset();
    error InsufficientLiquidity();
    error InsufficientReserved();
    error BorrowLimitExceeded();
    error InsolventAccount();
    error ProtocolPaused();

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
        StrategyAdapterRegistry.StrategyMetadata memory strategy = registry.getStrategy(strategyId);
        require(strategy.active, "INACTIVE_STRATEGY");
        AssetPosition storage position = positions[account][strategy.asset];
        if (position.liquid < amount) revert InsufficientLiquidity();
        position.liquid -= amount;
        position.strategyAllocated += amount;
        strategyShares[account][strategyId] += amount;
        emit StrategyAllocated(account, strategyId, strategy.asset, amount);
    }

    function deallocateIdleFunds(address account, bytes32 strategyId, uint256 amount) external whenNotPaused onlyOwnerOrOperator(account) {
        StrategyAdapterRegistry.StrategyMetadata memory strategy = registry.getStrategy(strategyId);
        AssetPosition storage position = positions[account][strategy.asset];
        require(strategyShares[account][strategyId] >= amount, "INSUFFICIENT_SHARES");
        strategyShares[account][strategyId] -= amount;
        position.strategyAllocated -= amount;
        position.liquid += amount;
        emit StrategyDeallocated(account, strategyId, strategy.asset, amount);
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
}
