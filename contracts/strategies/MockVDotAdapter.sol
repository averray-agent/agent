// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {TreasuryPolicy} from "../TreasuryPolicy.sol";
import {ReentrancyGuard} from "../lib/ReentrancyGuard.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

/**
 * @title MockVDotAdapter
 * @notice Self-contained liquid-staking adapter for testnet + local dev.
 *
 * Real Bifrost vDOT on Polkadot Hub is reached via XCM and the asset-hub
 * runtime, not a plain ERC20 deposit. Rather than ship half a cross-chain
 * integration that won't work on mainnet without more plumbing, this v1
 * adapter models the EXACT accounting we need (share-based deposit,
 * appreciating exchange rate, withdraw-at-current-rate) in a standalone
 * contract.
 *
 * Guarantees for the platform:
 *   - IStrategyAdapter surface is identical to a hypothetical future
 *     Bifrost-wired adapter, so AgentAccountCore + the registry don't
 *     change when the real integration arrives.
 *   - Share accounting uses a running "totalAssets / totalShares"
 *     exchange rate. Yield accrues when the policy owner calls
 *     `simulateYieldBps` — in production that call would be replaced by
 *     on-chain reads of vDOT's accrued rewards.
 *   - Principal custody is non-discretionary: every withdraw must satisfy
 *     the caller's share balance; there is no admin path to drain funds
 *     beyond the pause + queue knobs the policy already provides.
 *
 * This is NOT a yield source to point real mainnet deposits at. See
 * docs/strategies/vdot.md for the mainnet migration plan and the audit
 * items that must close before this contract shape is trusted with
 * user funds on live networks.
 */
contract MockVDotAdapter is IStrategyAdapter, ReentrancyGuard {
    TreasuryPolicy public immutable policy;
    address public immutable override asset;
    bytes32 public immutable override strategyId;
    /// @dev Upper bound on simulated yield per call so a misconfigured
    ///      owner can't mint arbitrary "profit" in one tx. 500 bps = 5%.
    uint256 public constant MAX_YIELD_BPS_PER_CALL = 500;
    /// @dev Operator-only caller for deposit/withdraw — any address the
    ///      TreasuryPolicy marks as a service operator (for v1 that's the
    ///      AgentAccountCore + EscrowCore contracts).
    uint256 public totalShares;
    /// @dev Live principal+accrued-yield balance expressed in the asset's
    ///      smallest unit. `shares * totalAssets / totalShares` gives the
    ///      user's withdrawable balance.
    uint256 public override totalAssets;

    mapping(address => uint256) public shares;

    event Deposited(address indexed account, uint256 assets, uint256 shares);
    event Withdrawn(address indexed account, address indexed recipient, uint256 shares, uint256 assets);
    event YieldSimulated(uint256 bps, uint256 oldTotalAssets, uint256 newTotalAssets);

    error Unauthorized();
    error InsufficientShares();
    error ZeroAmount();
    error YieldCapExceeded();
    error NothingToAccrueOn();

    constructor(TreasuryPolicy policy_, address asset_, bytes32 strategyId_) {
        policy = policy_;
        asset = asset_;
        strategyId = strategyId_;
    }

    modifier onlyOperator() {
        if (!policy.serviceOperators(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != policy.owner()) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (policy.paused()) revert Unauthorized();
        _;
    }

    /// @inheritdoc IStrategyAdapter
    function deposit(uint256 amount) external override nonReentrant whenNotPaused onlyOperator returns (uint256 sharesMinted) {
        if (amount == 0) revert ZeroAmount();
        // Classic share-math: share_price = totalAssets / totalShares.
        // First depositor gets 1:1, subsequent depositors mint at the
        // current rate so prior yield accrual isn't diluted.
        if (totalShares == 0 || totalAssets == 0) {
            sharesMinted = amount;
        } else {
            sharesMinted = (amount * totalShares) / totalAssets;
        }
        shares[msg.sender] += sharesMinted;
        totalShares += sharesMinted;
        totalAssets += amount;
        SafeTransfer.safeTransferFrom(asset, msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, sharesMinted);
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 sharesToBurn, address recipient) external override nonReentrant whenNotPaused onlyOperator returns (uint256 assetsReturned) {
        if (sharesToBurn == 0) revert ZeroAmount();
        if (shares[msg.sender] < sharesToBurn) revert InsufficientShares();
        // Redeem at the current exchange rate: share_price = totalAssets / totalShares.
        assetsReturned = (sharesToBurn * totalAssets) / totalShares;
        shares[msg.sender] -= sharesToBurn;
        totalShares -= sharesToBurn;
        totalAssets -= assetsReturned;
        SafeTransfer.safeTransfer(asset, recipient, assetsReturned);
        emit Withdrawn(msg.sender, recipient, sharesToBurn, assetsReturned);
    }

    /// @inheritdoc IStrategyAdapter
    function maxWithdraw(address account) external view override returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares[account] * totalAssets) / totalShares;
    }

    /// @inheritdoc IStrategyAdapter
    function riskLabel() external pure override returns (string memory) {
        return "Mock vDOT liquid staking (testnet). Not a real yield source.";
    }

    /**
     * Simulate yield accrual by the specified basis points of current
     * principal. Owner-only; capped to `MAX_YIELD_BPS_PER_CALL` per call
     * so a typo can't mint a million-fold return.
     *
     * On mainnet this function would be removed — yield would read from
     * Bifrost's accrued-rewards view instead of being a governance knob.
     */
    function simulateYieldBps(uint256 bps) external onlyOwner {
        if (bps == 0) revert ZeroAmount();
        if (bps > MAX_YIELD_BPS_PER_CALL) revert YieldCapExceeded();
        if (totalAssets == 0) revert NothingToAccrueOn();
        uint256 accrued = (totalAssets * bps) / 10_000;
        uint256 previous = totalAssets;
        totalAssets += accrued;
        emit YieldSimulated(bps, previous, totalAssets);
    }
}
