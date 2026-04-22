// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {IXcmStrategyAdapter} from "../contracts/interfaces/IXcmStrategyAdapter.sol";
import {XcmWrapper} from "../contracts/XcmWrapper.sol";
import {XcmVdotAdapter} from "../contracts/strategies/XcmVdotAdapter.sol";

contract XcmVdotAdapterTest is Test {
    TreasuryPolicy internal policy;
    MockERC20 internal asset;
    XcmWrapper internal wrapper;
    XcmVdotAdapter internal adapter;

    address internal operator = address(0xB0B);
    address internal worker = address(0xCAFE);
    address internal recipient = address(0xD00D);

    bytes32 internal constant STRATEGY_ID = bytes32("VDOT_XCM_V2");

    function setUp() public {
        policy = new TreasuryPolicy();
        asset = new MockERC20("DOT", "DOT");
        wrapper = new XcmWrapper(policy, address(0));
        adapter = new XcmVdotAdapter(policy, address(asset), STRATEGY_ID, IXcmWrapper(address(wrapper)));

        policy.setServiceOperator(operator, true);
        policy.setServiceOperator(address(adapter), true);

        asset.mint(operator, 100 ether);
        vm.prank(operator);
        asset.approve(address(adapter), type(uint256).max);
    }

    function testRequestDepositQueuesWrapperAndEscrowsAssets() public {
        vm.prank(operator);
        bytes32 requestId = adapter.requestDeposit(
            worker,
            25 ether,
            hex"0102",
            hex"aabbccdd",
            IXcmWrapper.Weight({refTime: 11, proofSize: 22}),
            1
        );

        IXcmStrategyAdapter.AdapterRequest memory request = adapter.getAdapterRequest(requestId);
        IXcmWrapper.RequestRecord memory wrapperRequest = wrapper.getRequest(requestId);

        assertEq(asset.balanceOf(address(adapter)), 25 ether);
        assertEq(adapter.pendingDepositAssets(), 25 ether);
        assertEq(uint256(request.kind), uint256(IXcmWrapper.RequestKind.Deposit));
        assertEq(uint256(request.status), uint256(IXcmWrapper.RequestStatus.Pending));
        assertEq(request.account, worker);
        assertEq(request.requester, operator);
        assertEq(request.requestedAssets, 25 ether);
        assertEq(uint256(wrapperRequest.status), uint256(IXcmWrapper.RequestStatus.Pending));
        assertEq(wrapperRequest.context.account, worker);
        assertEq(wrapperRequest.context.assets, 25 ether);
    }

    function testRequestDepositIsIdempotentForSamePayload() public {
        vm.startPrank(operator);
        bytes32 first = adapter.requestDeposit(
            worker,
            25 ether,
            hex"0102",
            hex"aabbccdd",
            IXcmWrapper.Weight({refTime: 11, proofSize: 22}),
            1
        );
        bytes32 second = adapter.requestDeposit(
            worker,
            25 ether,
            hex"0102",
            hex"aabbccdd",
            IXcmWrapper.Weight({refTime: 11, proofSize: 22}),
            1
        );
        vm.stopPrank();

        require(first == second, "request id mismatch");
        assertEq(asset.balanceOf(address(adapter)), 25 ether);
        assertEq(adapter.pendingDepositAssets(), 25 ether);
    }

    function testSettleDepositBooksSharesAndAssets() public {
        vm.prank(operator);
        bytes32 requestId = adapter.requestDeposit(
            worker,
            25 ether,
            hex"0102",
            hex"aabbccdd",
            IXcmWrapper.Weight({refTime: 11, proofSize: 22}),
            1
        );

        vm.prank(operator);
        adapter.settleRequest(
            requestId,
            IXcmWrapper.RequestStatus.Succeeded,
            25 ether,
            23 ether,
            keccak256("remote-deposit"),
            bytes32(0)
        );

        IXcmStrategyAdapter.AdapterRequest memory request = adapter.getAdapterRequest(requestId);
        IXcmWrapper.RequestRecord memory wrapperRequest = wrapper.getRequest(requestId);

        assertEq(adapter.pendingDepositAssets(), 0);
        assertEq(adapter.totalAssets(), 25 ether);
        assertEq(adapter.totalShares(), 23 ether);
        assertEq(uint256(request.status), uint256(IXcmWrapper.RequestStatus.Succeeded));
        assertEq(request.settledAssets, 25 ether);
        assertEq(request.settledShares, 23 ether);
        assertEq(uint256(wrapperRequest.status), uint256(IXcmWrapper.RequestStatus.Succeeded));
        assertEq(wrapperRequest.settledAssets, 25 ether);
        assertEq(wrapperRequest.settledShares, 23 ether);
    }

    function testRequestWithdrawQueuesAndReservesShares() public {
        bytes32 depositRequestId = _seedSettledDeposit();

        vm.prank(operator);
        bytes32 withdrawRequestId = adapter.requestWithdraw(
            worker,
            10 ether,
            recipient,
            hex"0304",
            hex"deadbeef",
            IXcmWrapper.Weight({refTime: 5, proofSize: 6}),
            2
        );

        IXcmStrategyAdapter.AdapterRequest memory request = adapter.getAdapterRequest(withdrawRequestId);
        IXcmWrapper.RequestRecord memory wrapperRequest = wrapper.getRequest(withdrawRequestId);

        require(withdrawRequestId != depositRequestId, "request id should differ");
        assertEq(adapter.pendingWithdrawalShares(), 10 ether);
        assertEq(uint256(request.kind), uint256(IXcmWrapper.RequestKind.Withdraw));
        assertEq(request.recipient, recipient);
        assertEq(request.requestedShares, 10 ether);
        assertEq(uint256(wrapperRequest.context.kind), uint256(IXcmWrapper.RequestKind.Withdraw));
        assertEq(wrapperRequest.context.shares, 10 ether);
    }

    function testSettleWithdrawBurnsSharesAndPaysRecipient() public {
        _seedSettledDeposit();

        vm.prank(operator);
        bytes32 withdrawRequestId = adapter.requestWithdraw(
            worker,
            10 ether,
            recipient,
            hex"0304",
            hex"deadbeef",
            IXcmWrapper.Weight({refTime: 5, proofSize: 6}),
            2
        );

        vm.prank(operator);
        adapter.settleRequest(
            withdrawRequestId,
            IXcmWrapper.RequestStatus.Succeeded,
            11 ether,
            0,
            keccak256("remote-withdraw"),
            bytes32(0)
        );

        IXcmStrategyAdapter.AdapterRequest memory request = adapter.getAdapterRequest(withdrawRequestId);

        assertEq(adapter.pendingWithdrawalShares(), 0);
        assertEq(adapter.totalShares(), 13 ether);
        assertEq(adapter.totalAssets(), 14 ether);
        assertEq(asset.balanceOf(recipient), 11 ether);
        assertEq(uint256(request.status), uint256(IXcmWrapper.RequestStatus.Succeeded));
        assertEq(request.settledAssets, 11 ether);
    }

    function _seedSettledDeposit() internal returns (bytes32 requestId) {
        vm.prank(operator);
        requestId = adapter.requestDeposit(
            worker,
            25 ether,
            hex"0102",
            hex"aabbccdd",
            IXcmWrapper.Weight({refTime: 11, proofSize: 22}),
            1
        );

        vm.prank(operator);
        adapter.settleRequest(
            requestId,
            IXcmWrapper.RequestStatus.Succeeded,
            25 ether,
            23 ether,
            keccak256("remote-deposit"),
            bytes32(0)
        );
    }
}
