// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XcmWrapperV22Fixture} from "./XcmWrapperV22.t.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {IXcmWrapperV22} from "../contracts/interfaces/IXcmWrapperV22.sol";

interface VmRecallUnwind {
    function expectCall(address callee, bytes calldata data) external;
}

/// No production contract changes: pin the deployed lane's terminal accounting.
contract RecallSellUnwindTest is XcmWrapperV22Fixture {
    bytes32 internal constant OBSERVATION =
        0x91d5129009b239390e529e4c678731ba4a19a0394684333600e73bfcad95b405;

    function testUnexecutedSellFailsWithZeroRecoveryAndKeepsLivePosition() public {
        _seedShares(1);
        bytes32 requestId = _stageWithdraw(2, 100_000, 100_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 30_000);
        uint256 sends = precompile.sendCount();
        uint256 assetsBefore = adapter.totalAssets();
        uint256 sharesBefore = adapter.totalShares();
        assertEq(wrapper.requestDispatchBitmap(requestId), 4);
        assertEq(adapter.pendingWithdrawalShares(), 100_000);

        VmRecallUnwind(address(vm)).expectCall(address(wrapper), abi.encodeCall(
            IXcmWrapper.finalizeRequest,
            (requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, OBSERVATION, bytes32("SELL_NOT_EXECUTED"))
        ));
        vm.prank(OPERATOR);
        adapter.settleRequest(requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, 0, OBSERVATION, bytes32("SELL_NOT_EXECUTED"));

        assertEq(uint256(wrapper.getRequest(requestId).status), uint256(IXcmWrapper.RequestStatus.Failed));
        assertEq(uint256(adapter.getAdapterRequest(requestId).status), uint256(IXcmWrapper.RequestStatus.Failed));
        assertEq(adapter.pendingWithdrawalShares(), 0);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 0);
        assertFalse(adapter.requiresRemoteRecovery(requestId));
        assertEq(adapter.totalAssets(), assetsBefore);
        assertEq(adapter.totalShares(), sharesBefore);
        assertEq(wrapper.requestDispatchBitmap(requestId), 4);
        assertEq(precompile.sendCount(), sends); // no withdraw_home or repeated sell
    }

    function testIntactBalanceInRecoverySlotWouldDoubleCountThePosition() public {
        _seedShares(1);
        bytes32 requestId = _stageWithdraw(2, 100_000, 100_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 30_000);
        vm.prank(OPERATOR);
        adapter.settleRequest(requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, 100_000, OBSERVATION, bytes32("SELL_NOT_EXECUTED"));
        assertEq(adapter.totalAssets(), 100_000);
        assertEq(adapter.totalShares(), 100_000);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 100_000);
        assertTrue(adapter.requiresRemoteRecovery(requestId));
    }
}
