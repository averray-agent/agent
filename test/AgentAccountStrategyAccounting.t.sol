// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {IStrategyAdapter} from "../contracts/interfaces/IStrategyAdapter.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";

contract RevertingValuationStrategyAdapter is IStrategyAdapter {
    MockERC20 internal immutable token;
    bytes32 public immutable override strategyId;
    address public immutable override asset;
    uint256 internal totalShares_;
    uint256 internal totalAssets_;
    bool public valuationReverts;

    error ValuationUnavailable();

    constructor(MockERC20 token_, bytes32 strategyId_) {
        token = token_;
        asset = address(token_);
        strategyId = strategyId_;
    }

    function setValuationReverts(bool enabled) external {
        valuationReverts = enabled;
    }

    function deposit(uint256 amount) external override returns (uint256 sharesMinted) {
        sharesMinted = amount;
        totalShares_ += sharesMinted;
        totalAssets_ += amount;
        require(token.transferFrom(msg.sender, address(this), amount), "TRANSFER_FROM_FAILED");
    }

    function withdraw(uint256 shares, address recipient) external override returns (uint256 assetsReturned) {
        require(totalShares_ >= shares, "INSUFFICIENT_SHARES");
        assetsReturned = shares;
        totalShares_ -= shares;
        totalAssets_ -= assetsReturned;
        require(token.transfer(recipient, assetsReturned), "TRANSFER_FAILED");
    }

    function totalShares() external view override returns (uint256) {
        return totalShares_;
    }

    function totalAssets() external view override returns (uint256) {
        if (valuationReverts) revert ValuationUnavailable();
        return totalAssets_;
    }

    function maxWithdraw(address) external view override returns (uint256) {
        return totalAssets_;
    }

    function riskLabel() external pure override returns (string memory) {
        return "test strategy";
    }
}

    contract AgentAccountStrategyAccountingTest is Test {
        TreasuryPolicy internal policy;
        StrategyAdapterRegistry internal registry;
        AgentAccountCore internal accounts;
        MockERC20 internal token;

        address internal worker = address(0xB0B);

        uint256 internal constant WORKER_DEPOSIT = 200 ether;

        function setUp() public {
            policy = new TreasuryPolicy();
            registry = new StrategyAdapterRegistry(policy);
            accounts = new AgentAccountCore(policy, registry);
            token = new MockERC20("Mock DOT", "mDOT");

            policy.setApprovedAsset(address(token), true);
            policy.setServiceOperator(address(accounts), true);

            token.mint(worker, WORKER_DEPOSIT);
            vm.startPrank(worker);
            token.approve(address(accounts), type(uint256).max);
            accounts.deposit(address(token), WORKER_DEPOSIT);
            vm.stopPrank();
        }

        function testRegisterStrategyRejectsUnapprovedAsset() public {
            MockERC20 unapprovedToken = new MockERC20("Unapproved", "NOPE");
            RevertingValuationStrategyAdapter adapter =
                new RevertingValuationStrategyAdapter(unapprovedToken, bytes32("UNAPPROVED_ASSET"));
            policy.setApprovedStrategy(address(adapter), true);

            (bool ok, bytes memory data) =
                address(registry).call(abi.encodeCall(registry.registerStrategy, (address(adapter))));
            _assertCustomError(ok, data, StrategyAdapterRegistry.StrategyNotApproved.selector);
        }

        function testRegisterStrategyRejectsAdapterRepointForKnownId() public {
            bytes32 strategyId = bytes32("NO_SILENT_REPOINT");
            _registerStrategy(strategyId);

            RevertingValuationStrategyAdapter replacement = new RevertingValuationStrategyAdapter(token, strategyId);
            policy.setApprovedStrategy(address(replacement), true);

            (bool ok, bytes memory data) =
                address(registry).call(abi.encodeCall(registry.registerStrategy, (address(replacement))));
            _assertCustomError(ok, data, StrategyAdapterRegistry.StrategyNotApproved.selector);
        }

        function testRevokedPolicyApprovalMakesStrategyInactiveAtReadTime() public {
            bytes32 strategyId = bytes32("REVOCABLE_STRATEGY");
            RevertingValuationStrategyAdapter adapter = _registerStrategy(strategyId);

            StrategyAdapterRegistry.StrategyMetadata memory beforeRevoke = registry.getStrategy(strategyId);
            require(beforeRevoke.active, "STRATEGY_SHOULD_START_ACTIVE");

            policy.setApprovedStrategy(address(adapter), false);

            StrategyAdapterRegistry.StrategyMetadata memory afterRevoke = registry.getStrategy(strategyId);
            require(!afterRevoke.active, "STRATEGY_SHOULD_READ_INACTIVE");

            vm.prank(worker);
            (bool ok, bytes memory data) =
                address(accounts).call(abi.encodeCall(accounts.allocateIdleFunds, (worker, strategyId, 5 ether)));
            _assertCustomError(ok, data, AgentAccountCore.InvalidStrategy.selector);
        }

        function testStrategyAccountingOnlySyncsTouchedStrategy() public {
            bytes32 primaryStrategyId = bytes32("PRIMARY_STRATEGY");
            bytes32 unrelatedStrategyId = bytes32("UNRELATED_STRATEGY");
            _registerStrategy(primaryStrategyId);
            RevertingValuationStrategyAdapter unrelated = _registerStrategy(unrelatedStrategyId);

            vm.prank(worker);
            accounts.allocateIdleFunds(worker, unrelatedStrategyId, 10 ether);

            unrelated.setValuationReverts(true);

            vm.prank(worker);
            accounts.allocateIdleFunds(worker, primaryStrategyId, 5 ether);

            (uint256 liquidAfterAllocate,, uint256 allocatedAfterAllocate,,,) =
                accounts.positions(worker, address(token));
            assertEq(liquidAfterAllocate, WORKER_DEPOSIT - 15 ether);
            assertEq(allocatedAfterAllocate, 15 ether);
            assertEq(accounts.strategyAllocationValues(worker, unrelatedStrategyId), 10 ether);
            assertEq(accounts.strategyAllocationValues(worker, primaryStrategyId), 5 ether);

            vm.prank(worker);
            accounts.deallocateIdleFunds(worker, primaryStrategyId, 5 ether);

            (uint256 liquidAfterDeallocate,, uint256 allocatedAfterDeallocate,,,) =
                accounts.positions(worker, address(token));
            assertEq(liquidAfterDeallocate, WORKER_DEPOSIT - 10 ether);
            assertEq(allocatedAfterDeallocate, 10 ether);
            assertEq(accounts.strategyAllocationValues(worker, unrelatedStrategyId), 10 ether);
            assertEq(accounts.strategyAllocationValues(worker, primaryStrategyId), 0);
        }

        function _registerStrategy(bytes32 strategyId) internal returns (RevertingValuationStrategyAdapter adapter) {
            adapter = new RevertingValuationStrategyAdapter(token, strategyId);
            policy.setApprovedStrategy(address(adapter), true);
            registry.registerStrategy(address(adapter));
        }

        function _assertCustomError(bool ok, bytes memory data, bytes4 selector) internal pure {
            require(!ok, "expected revert");
            require(data.length >= 4, "missing selector");

            bytes4 actual;
            assembly {
                actual := mload(add(data, 32))
            }

            require(actual == selector, "unexpected selector");
        }
    }
