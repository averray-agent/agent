// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../../contracts/TreasuryPolicy.sol";
import {MockVDotAdapter} from "../../contracts/strategies/MockVDotAdapter.sol";

/// @notice Pins the accounting invariants of the v1 MockVDotAdapter:
///         share-based deposit, proportional withdrawal at the current
///         exchange rate, bounded yield simulation, operator gating, and
///         non-operator rejection.
contract MockVDotAdapterTest is Test {
    TreasuryPolicy internal policy;
    MockERC20 internal dot;
    MockVDotAdapter internal adapter;

    address internal operator = address(0xB0B);
    address internal otherOperator = address(0xBEEF);
    address internal stranger = address(0xDEAD);

    bytes32 internal constant STRATEGY_ID = bytes32("VDOT_V1_MOCK");

    function setUp() public {
        policy = new TreasuryPolicy();
        dot = new MockERC20("Mock DOT", "mDOT");
        adapter = new MockVDotAdapter(policy, address(dot), STRATEGY_ID);

        policy.setApprovedAsset(address(dot), true);
        policy.setServiceOperator(operator, true);
        policy.setServiceOperator(otherOperator, true);

        // Mint DOT into each operator wallet and pre-approve the adapter
        // so tests can call deposit() from the operator context without
        // re-approving every single call.
        dot.mint(operator, 1_000 ether);
        dot.mint(otherOperator, 1_000 ether);
        vm.prank(operator);
        dot.approve(address(adapter), type(uint256).max);
        vm.prank(otherOperator);
        dot.approve(address(adapter), type(uint256).max);
    }

    function testFirstDepositMintsSharesOneForOne() public {
        vm.prank(operator);
        uint256 sharesMinted = adapter.deposit(100 ether);
        assertEq(sharesMinted, 100 ether);
        assertEq(adapter.totalShares(), 100 ether);
        assertEq(adapter.totalAssets(), 100 ether);
        assertEq(adapter.shares(operator), 100 ether);
    }

    function testSecondDepositorGetsSharesAtCurrentRateAfterYieldAccrual() public {
        vm.prank(operator);
        adapter.deposit(100 ether);
        // Accrue 5% so totalAssets = 105 ether but totalShares still 100.
        policy.setServiceOperator(address(this), true);
        adapter.simulateYieldBps(500);
        assertEq(adapter.totalAssets(), 105 ether);

        // A second depositor putting in 105 DOT should get 100 shares back
        // because each share is now worth 1.05 DOT.
        vm.prank(otherOperator);
        uint256 sharesMinted = adapter.deposit(105 ether);
        assertEq(sharesMinted, 100 ether);
        // After both deposits: 200 shares, 210 DOT backing them.
        assertEq(adapter.totalShares(), 200 ether);
        assertEq(adapter.totalAssets(), 210 ether);
    }

    function testWithdrawSingleHopAfter500BpsYield() public {
        vm.prank(operator);
        adapter.deposit(200 ether);
        policy.setServiceOperator(address(this), true);
        adapter.simulateYieldBps(500); // totalAssets 210, shares 200

        uint256 balanceBefore = dot.balanceOf(stranger);
        vm.prank(operator);
        uint256 assetsOut = adapter.withdraw(100 ether, stranger);
        assertEq(assetsOut, 105 ether); // 100 shares * 210 / 200
        assertEq(adapter.totalShares(), 100 ether);
        assertEq(adapter.totalAssets(), 105 ether);
        assertEq(adapter.shares(operator), 100 ether);
        assertEq(dot.balanceOf(stranger), balanceBefore + 105 ether);
    }

    function testMaxWithdrawTracksCurrentBalance() public {
        vm.prank(operator);
        adapter.deposit(50 ether);
        policy.setServiceOperator(address(this), true);
        adapter.simulateYieldBps(200); // totalAssets 51, shares 50

        uint256 max = adapter.maxWithdraw(operator);
        assertEq(max, 51 ether);

        uint256 forStranger = adapter.maxWithdraw(stranger);
        assertEq(forStranger, 0);
    }

    function testNonOperatorCannotDeposit() public {
        dot.mint(stranger, 100 ether);
        vm.startPrank(stranger);
        dot.approve(address(adapter), type(uint256).max);
        (bool ok,) = address(adapter).call(abi.encodeCall(adapter.deposit, (50 ether)));
        vm.stopPrank();
        require(!ok, "EXPECTED_UNAUTHORIZED_DEPOSIT");
    }

    function testNonOperatorCannotWithdraw() public {
        vm.prank(operator);
        adapter.deposit(50 ether);
        vm.prank(stranger);
        (bool ok,) = address(adapter).call(abi.encodeCall(adapter.withdraw, (1 ether, stranger)));
        require(!ok, "EXPECTED_UNAUTHORIZED_WITHDRAW");
    }

    function testCannotWithdrawMoreSharesThanOwned() public {
        vm.prank(operator);
        adapter.deposit(10 ether);
        vm.prank(operator);
        (bool ok,) = address(adapter).call(abi.encodeCall(adapter.withdraw, (20 ether, stranger)));
        require(!ok, "EXPECTED_INSUFFICIENT_SHARES");
    }

    function testSimulateYieldOwnerOnly() public {
        vm.prank(operator);
        adapter.deposit(10 ether);
        // Operator is not the policy owner — only the deployer (this test)
        // is. Attempting to simulate yield from `operator` should revert.
        vm.prank(operator);
        (bool ok,) = address(adapter).call(abi.encodeCall(adapter.simulateYieldBps, (100)));
        require(!ok, "EXPECTED_OWNER_ONLY");
    }

    function testSimulateYieldCapEnforced() public {
        vm.prank(operator);
        adapter.deposit(10 ether);
        (bool ok,) = address(adapter).call(abi.encodeCall(adapter.simulateYieldBps, (501)));
        require(!ok, "EXPECTED_CAP_REVERT");
    }

    function testPauseBlocksDeposit() public {
        policy.setPaused(true);
        vm.prank(operator);
        (bool ok,) = address(adapter).call(abi.encodeCall(adapter.deposit, (1 ether)));
        require(!ok, "EXPECTED_PAUSED_REVERT");
    }

    function testFirstDepositAfterFullWithdrawalStartsOneForOneAgain() public {
        vm.prank(operator);
        adapter.deposit(10 ether);
        vm.prank(operator);
        adapter.withdraw(10 ether, stranger);
        // Shares and assets both back to zero.
        assertEq(adapter.totalShares(), 0);
        assertEq(adapter.totalAssets(), 0);
        // A new depositor should then mint at the 1:1 reset price.
        vm.prank(otherOperator);
        uint256 sharesMinted = adapter.deposit(5 ether);
        assertEq(sharesMinted, 5 ether);
    }
}
