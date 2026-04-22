// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {XcmWrapper} from "../contracts/XcmWrapper.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {XcmVdotAdapter} from "../contracts/strategies/XcmVdotAdapter.sol";

contract AgentAccountAsyncStrategyTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    MockERC20 internal dot;
    XcmWrapper internal wrapper;
    XcmVdotAdapter internal adapter;

    address internal worker = address(0xB0B);

    bytes32 internal constant STRATEGY_ID = bytes32("VDOT_V1_XCM");
    uint256 internal constant WORKER_DEPOSIT = 200 ether;

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        dot = new MockERC20("Mock DOT", "mDOT");
        wrapper = new XcmWrapper(policy, address(0));
        adapter = new XcmVdotAdapter(policy, address(dot), STRATEGY_ID, wrapper);

        policy.setApprovedAsset(address(dot), true);
        policy.setApprovedStrategy(address(adapter), true);
        policy.setServiceOperator(address(this), true);
        policy.setServiceOperator(address(accounts), true);
        policy.setServiceOperator(address(adapter), true);
        registry.registerStrategy(address(adapter));

        dot.mint(worker, WORKER_DEPOSIT);
        vm.startPrank(worker);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), WORKER_DEPOSIT);
        vm.stopPrank();
    }

    function testRequestStrategyDepositMovesFundsIntoPendingAsyncLane() public {
        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});

        vm.prank(worker);
        accounts.requestStrategyDeposit(
            worker,
            AgentAccountCore.StrategyDepositRequestParams({
                strategyId: STRATEGY_ID,
                amount: 20 ether,
                destination: hex"0102",
                message: hex"0304",
                maxWeight: maxWeight,
                nonce: 1
            })
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 20 ether);
        assertEq(strategyAllocated, 0);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 20 ether);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 0);
        assertEq(adapter.pendingDepositAssets(), 20 ether);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT - 20 ether);
        assertEq(dot.balanceOf(address(adapter)), 20 ether);
    }

    function testSettleStrategyDepositBooksSharesAfterSuccess() public {
        bytes32 requestId = _requestDeposit(20 ether, 1);

        accounts.settleStrategyRequest(
            requestId,
            IXcmWrapper.RequestStatus.Succeeded,
            20 ether,
            20 ether,
            bytes32("REMOTE"),
            bytes32(0)
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 20 ether);
        assertEq(strategyAllocated, 20 ether);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 20 ether);
        assertEq(adapter.totalAssets(), 20 ether);
        assertEq(adapter.totalShares(), 20 ether);
    }

    function testStrategyDepositFailureRefundsLiquidBalance() public {
        bytes32 requestId = _requestDeposit(20 ether, 2);

        accounts.settleStrategyRequest(
            requestId,
            IXcmWrapper.RequestStatus.Failed,
            0,
            0,
            bytes32(0),
            bytes32("FAILED")
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT);
        assertEq(strategyAllocated, 0);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 0);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT);
        assertEq(dot.balanceOf(address(adapter)), 0);
    }

    function testSettleStrategyWithdrawReturnsLiquidityToAccountCore() public {
        _seedSettledDeposit(40 ether, 3);

        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        vm.prank(worker);
        bytes32 requestId = accounts.requestStrategyWithdraw(
            worker,
            AgentAccountCore.StrategyWithdrawRequestParams({
                strategyId: STRATEGY_ID,
                shares: 15 ether,
                recipient: address(accounts),
                destination: hex"0a",
                message: hex"0b",
                maxWeight: maxWeight,
                nonce: 4
            })
        );

        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 15 ether);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 40 ether);

        accounts.settleStrategyRequest(
            requestId,
            IXcmWrapper.RequestStatus.Succeeded,
            15 ether,
            0,
            bytes32("WITHDRAW"),
            bytes32(0)
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 40 ether + 15 ether);
        assertEq(strategyAllocated, 25 ether);
        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 25 ether);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT - 25 ether);
        assertEq(dot.balanceOf(address(adapter)), 25 ether);
    }

    function testStrategyWithdrawFailureKeepsSharesAndLeavesLiquidityUntouched() public {
        _seedSettledDeposit(40 ether, 5);

        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        vm.prank(worker);
        bytes32 requestId = accounts.requestStrategyWithdraw(
            worker,
            AgentAccountCore.StrategyWithdrawRequestParams({
                strategyId: STRATEGY_ID,
                shares: 10 ether,
                recipient: address(accounts),
                destination: hex"0c",
                message: hex"0d",
                maxWeight: maxWeight,
                nonce: 6
            })
        );

        accounts.settleStrategyRequest(
            requestId,
            IXcmWrapper.RequestStatus.Failed,
            0,
            0,
            bytes32(0),
            bytes32("WITHDRAW_FAILED")
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 40 ether);
        assertEq(strategyAllocated, 40 ether);
        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 40 ether);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT - 40 ether);
        assertEq(dot.balanceOf(address(adapter)), 40 ether);
    }

    function _seedSettledDeposit(uint256 amount, uint64 nonce) internal returns (bytes32 requestId) {
        requestId = _requestDeposit(amount, nonce);
        accounts.settleStrategyRequest(
            requestId,
            IXcmWrapper.RequestStatus.Succeeded,
            amount,
            amount,
            bytes32("REMOTE"),
            bytes32(0)
        );
    }

    function _requestDeposit(uint256 amount, uint64 nonce) internal returns (bytes32 requestId) {
        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        vm.prank(worker);
        requestId = accounts.requestStrategyDeposit(
            worker,
            AgentAccountCore.StrategyDepositRequestParams({
                strategyId: STRATEGY_ID,
                amount: amount,
                destination: hex"0102",
                message: hex"0304",
                maxWeight: maxWeight,
                nonce: nonce
            })
        );
    }
}
