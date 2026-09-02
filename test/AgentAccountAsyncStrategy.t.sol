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

contract AsyncStrategyMockXcmPrecompile {
    function send(bytes calldata, bytes calldata) external {}

    function weighMessage(bytes calldata message) external pure returns (IXcmWrapper.Weight memory) {
        return IXcmWrapper.Weight({refTime: uint64(message.length * 10), proofSize: uint64(message.length)});
    }
}

contract AgentAccountAsyncStrategyTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    MockERC20 internal dot;
    AsyncStrategyMockXcmPrecompile internal precompile;
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
        precompile = new AsyncStrategyMockXcmPrecompile();
        wrapper = new XcmWrapper(policy, address(precompile));
        adapter = new XcmVdotAdapter(policy, address(dot), STRATEGY_ID, wrapper);

        policy.setApprovedAsset(address(dot), true);
        policy.setApprovedStrategy(address(adapter), true);
        policy.setStrategySettler(address(this), true);
        policy.setStrategySettler(address(accounts), true);
        policy.setStrategySettler(address(adapter), true);
        policy.setOutflowRecorder(address(accounts), true);
        registry.registerStrategy(address(adapter));

        dot.mint(worker, WORKER_DEPOSIT);
        vm.startPrank(worker);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), WORKER_DEPOSIT);
        vm.stopPrank();
    }

    function testRequestStrategyDepositMovesFundsIntoPendingAsyncLane() public {
        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 requestId = _previewDepositRequestId(worker, 20 ether, 1);

        vm.prank(worker);
        accounts.requestStrategyDeposit(
            worker,
            AgentAccountCore.StrategyDepositRequestParams({
                strategyId: STRATEGY_ID,
                amount: 20 ether,
                destination: hex"0102",
                message: _depositMessage(requestId, worker, 20 ether),
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

    function testRequestStrategyDepositRespectsDebtOutstanding() public {
        vm.startPrank(worker);
        accounts.lockCollateral(address(dot), 150 ether);
        accounts.borrow(address(dot), 100 ether);

        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 requestId = _previewDepositRequestId(worker, 51 ether, 11);
        (bool ok, bytes memory data) = address(accounts)
            .call(
                abi.encodeCall(
                    accounts.requestStrategyDeposit,
                    (
                        worker,
                        AgentAccountCore.StrategyDepositRequestParams({
                            strategyId: STRATEGY_ID,
                            amount: 51 ether,
                            destination: hex"0102",
                            message: _depositMessage(requestId, worker, 51 ether),
                            maxWeight: maxWeight,
                            nonce: 11
                        })
                    )
                )
            );
        vm.stopPrank();

        _assertCustomError(ok, data, AgentAccountCore.InsufficientLiquidity.selector);
    }

    function testSettleStrategyDepositBooksSharesAfterSuccess() public {
        bytes32 requestId = _requestDeposit(20 ether, 1);

        accounts.settleStrategyRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 20 ether, 20 ether, bytes32("REMOTE"), bytes32(0)
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 20 ether);
        assertEq(strategyAllocated, 20 ether);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 20 ether);
        assertEq(adapter.totalAssets(), 20 ether);
        assertEq(adapter.totalShares(), 20 ether);
    }

    function testPausedProtocolBlocksSuccessfulStrategyDepositSettlement() public {
        bytes32 requestId = _requestDeposit(20 ether, 12);

        policy.setPaused(true);

        (bool ok, bytes memory data) = address(accounts)
            .call(
                abi.encodeCall(
                    accounts.settleStrategyRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 20 ether, 20 ether, bytes32("REMOTE"), bytes32(0))
                )
            );
        _assertCustomError(ok, data, AgentAccountCore.ProtocolPaused.selector);

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 20 ether);
        assertEq(strategyAllocated, 0);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 20 ether);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 0);
        assertEq(adapter.pendingDepositAssets(), 20 ether);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT - 20 ether);
        assertEq(dot.balanceOf(address(adapter)), 20 ether);
    }

    function testSettleStrategyDepositRejectsZeroShareSuccessAndKeepsPending() public {
        bytes32 requestId = _requestDeposit(20 ether, 1);

        (bool ok, bytes memory data) = address(accounts)
            .call(
                abi.encodeCall(
                    accounts.settleStrategyRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 20 ether, 0, bytes32("REMOTE"), bytes32(0))
                )
            );
        _assertCustomError(ok, data, XcmVdotAdapter.InvalidStatus.selector);

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 20 ether);
        assertEq(strategyAllocated, 0);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 20 ether);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 0);
        assertEq(adapter.pendingDepositAssets(), 20 ether);
        assertEq(adapter.totalAssets(), 0);
        assertEq(adapter.totalShares(), 0);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT - 20 ether);
        assertEq(dot.balanceOf(address(adapter)), 20 ether);
    }

    function testStrategyDepositFailureRefundsLiquidBalance() public {
        bytes32 requestId = _requestDeposit(20 ether, 2);

        accounts.settleStrategyRequest(requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32(0), bytes32("FAILED"));

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT);
        assertEq(strategyAllocated, 0);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 0);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT);
        assertEq(dot.balanceOf(address(adapter)), 0);
    }

    function testPausedProtocolAllowsStrategyDepositFailureRefundThroughAccountCore() public {
        bytes32 requestId = _requestDeposit(20 ether, 13);

        policy.setPaused(true);

        accounts.settleStrategyRequest(requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32(0), bytes32("FAILED"));

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT);
        assertEq(strategyAllocated, 0);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 0);
        assertEq(adapter.pendingDepositAssets(), 0);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT);
        assertEq(dot.balanceOf(address(adapter)), 0);
    }

    function testPausedProtocolAllowsStrategyDepositCancellationRefundThroughAccountCore() public {
        bytes32 requestId = _requestDeposit(20 ether, 14);

        policy.setPaused(true);

        accounts.settleStrategyRequest(
            requestId, IXcmWrapper.RequestStatus.Cancelled, 0, 0, bytes32(0), bytes32("CANCELLED")
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT);
        assertEq(strategyAllocated, 0);
        assertEq(accounts.pendingStrategyAssets(worker, address(dot)), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 0);
        assertEq(adapter.pendingDepositAssets(), 0);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT);
        assertEq(dot.balanceOf(address(adapter)), 0);
    }

    function testSettleStrategyWithdrawReturnsLiquidityToAccountCore() public {
        _seedSettledDeposit(40 ether, 3);
        policy.setDailyOutflowCap(1 ether);

        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 previewId = _previewWithdrawRequestId(worker, 15 ether, address(accounts), 4);
        vm.prank(worker);
        bytes32 requestId = accounts.requestStrategyWithdraw(
            worker,
            AgentAccountCore.StrategyWithdrawRequestParams({
                strategyId: STRATEGY_ID,
                shares: 15 ether,
                recipient: address(accounts),
                destination: hex"0a",
                message: _withdrawMessage(previewId, address(accounts), 15 ether),
                maxWeight: maxWeight,
                nonce: 4
            })
        );

        require(requestId == previewId, "WRONG_REQUEST_ID");
        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 15 ether);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 40 ether);

        accounts.settleStrategyRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 15 ether, 0, bytes32("WITHDRAW"), bytes32(0)
        );

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 40 ether + 15 ether);
        assertEq(strategyAllocated, 25 ether);
        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 25 ether);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT - 25 ether);
        assertEq(dot.balanceOf(address(adapter)), 25 ether);
        assertEq(policy.accountOutflowToday(worker), 0);
    }

    function testOperatorCannotRedirectStrategyWithdrawToArbitraryRecipient() public {
        _seedSettledDeposit(40 ether, 43);

        address recipient = address(0xCAFE);
        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 previewId = _previewWithdrawRequestId(worker, 15 ether, recipient, 44);

        (bool ok, bytes memory data) = address(accounts)
            .call(
                abi.encodeCall(
                    accounts.requestStrategyWithdraw,
                    (
                        worker,
                        AgentAccountCore.StrategyWithdrawRequestParams({
                            strategyId: STRATEGY_ID,
                            shares: 15 ether,
                            recipient: recipient,
                            destination: hex"0b",
                            message: _withdrawMessage(previewId, recipient, 15 ether),
                            maxWeight: maxWeight,
                            nonce: 44
                        })
                    )
                )
            );
        _assertCustomError(ok, data, AgentAccountCore.InvalidRecipient.selector);

        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 0);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 40 ether);
    }

    function testExternalStrategyWithdrawEgressTripsFiniteOutflowCap() public {
        _seedSettledDeposit(40 ether, 33);
        policy.setDailyOutflowCap(10 ether);

        address recipient = address(0xCAFE);
        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 previewId = _previewWithdrawRequestId(worker, 15 ether, recipient, 34);
        vm.prank(worker);
        bytes32 requestId = accounts.requestStrategyWithdraw(
            worker,
            AgentAccountCore.StrategyWithdrawRequestParams({
                strategyId: STRATEGY_ID,
                shares: 15 ether,
                recipient: recipient,
                destination: hex"0b",
                message: _withdrawMessage(previewId, recipient, 15 ether),
                maxWeight: maxWeight,
                nonce: 34
            })
        );
        require(requestId == previewId, "WRONG_REQUEST_ID");

        (bool ok, bytes memory data) = address(accounts)
            .call(
                abi.encodeCall(
                    accounts.settleStrategyRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 15 ether, 0, bytes32("WITHDRAW"), bytes32(0))
                )
            );

        _assertCustomError(ok, data, TreasuryPolicy.OutflowCapExceeded.selector);
        assertEq(dot.balanceOf(recipient), 0);
        assertEq(policy.accountOutflowToday(worker), 0);
        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 15 ether);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 40 ether);
        assertEq(adapter.totalAssets(), 40 ether);
        assertEq(adapter.totalShares(), 40 ether);
    }

    function testSettleStrategyWithdrawRejectsZeroAssetSuccessAndKeepsPending() public {
        _seedSettledDeposit(40 ether, 3);

        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 previewId = _previewWithdrawRequestId(worker, 15 ether, address(accounts), 4);
        vm.prank(worker);
        bytes32 requestId = accounts.requestStrategyWithdraw(
            worker,
            AgentAccountCore.StrategyWithdrawRequestParams({
                strategyId: STRATEGY_ID,
                shares: 15 ether,
                recipient: address(accounts),
                destination: hex"0a",
                message: _withdrawMessage(previewId, address(accounts), 15 ether),
                maxWeight: maxWeight,
                nonce: 4
            })
        );

        (bool ok, bytes memory data) = address(accounts)
            .call(
                abi.encodeCall(
                    accounts.settleStrategyRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 0, 0, bytes32("WITHDRAW"), bytes32(0))
                )
            );
        _assertCustomError(ok, data, XcmVdotAdapter.InvalidStatus.selector);

        (uint256 liquid,, uint256 strategyAllocated,,,) = accounts.positions(worker, address(dot));
        assertEq(liquid, WORKER_DEPOSIT - 40 ether);
        assertEq(strategyAllocated, 40 ether);
        assertEq(accounts.pendingStrategyWithdrawalShares(worker, STRATEGY_ID), 15 ether);
        assertEq(accounts.strategyShares(worker, STRATEGY_ID), 40 ether);
        assertEq(adapter.pendingWithdrawalShares(), 15 ether);
        assertEq(adapter.totalAssets(), 40 ether);
        assertEq(adapter.totalShares(), 40 ether);
        assertEq(dot.balanceOf(address(accounts)), WORKER_DEPOSIT - 40 ether);
        assertEq(dot.balanceOf(address(adapter)), 40 ether);
    }

    function testStrategyWithdrawFailureKeepsSharesAndLeavesLiquidityUntouched() public {
        _seedSettledDeposit(40 ether, 5);

        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 previewId = _previewWithdrawRequestId(worker, 10 ether, address(accounts), 6);
        vm.prank(worker);
        bytes32 requestId = accounts.requestStrategyWithdraw(
            worker,
            AgentAccountCore.StrategyWithdrawRequestParams({
                strategyId: STRATEGY_ID,
                shares: 10 ether,
                recipient: address(accounts),
                destination: hex"0c",
                message: _withdrawMessage(previewId, address(accounts), 10 ether),
                maxWeight: maxWeight,
                nonce: 6
            })
        );

        accounts.settleStrategyRequest(
            requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32(0), bytes32("WITHDRAW_FAILED")
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
            requestId, IXcmWrapper.RequestStatus.Succeeded, amount, amount, bytes32("REMOTE"), bytes32(0)
        );
    }

    function _requestDeposit(uint256 amount, uint64 nonce) internal returns (bytes32 requestId) {
        IXcmWrapper.Weight memory maxWeight = IXcmWrapper.Weight({refTime: 10, proofSize: 5});
        bytes32 previewId = _previewDepositRequestId(worker, amount, nonce);
        vm.prank(worker);
        requestId = accounts.requestStrategyDeposit(
            worker,
            AgentAccountCore.StrategyDepositRequestParams({
                strategyId: STRATEGY_ID,
                amount: amount,
                destination: hex"0102",
                message: _depositMessage(previewId, worker, amount),
                maxWeight: maxWeight,
                nonce: nonce
            })
        );
        require(requestId == previewId, "WRONG_REQUEST_ID");
    }

    function _previewDepositRequestId(address account, uint256 amount, uint64 nonce) internal view returns (bytes32) {
        return wrapper.previewRequestId(
            IXcmWrapper.RequestContext({
                strategyId: STRATEGY_ID,
                kind: IXcmWrapper.RequestKind.Deposit,
                account: account,
                asset: address(dot),
                recipient: account,
                assets: amount,
                shares: 0,
                nonce: nonce
            })
        );
    }

    function _previewWithdrawRequestId(address account, uint256 shares, address recipient, uint64 nonce)
        internal
        view
        returns (bytes32)
    {
        return wrapper.previewRequestId(
            IXcmWrapper.RequestContext({
                strategyId: STRATEGY_ID,
                kind: IXcmWrapper.RequestKind.Withdraw,
                account: account,
                asset: address(dot),
                recipient: recipient,
                assets: 0,
                shares: shares,
                nonce: nonce
            })
        );
    }

    function _depositMessage(bytes32 requestId, address account, uint256 amount) internal view returns (bytes memory) {
        return _message(requestId, account, amount);
    }

    function _withdrawMessage(bytes32 requestId, address recipient, uint256 shares)
        internal
        view
        returns (bytes memory)
    {
        return _message(requestId, recipient, shares);
    }

    function _message(bytes32 requestId, address beneficiary, uint256 amount) internal view returns (bytes memory) {
        return abi.encodePacked(
            hex"05",
            _compact(4),
            bytes1(0x00),
            _compact(1),
            _xcmAsset(amount),
            bytes1(0x13),
            _xcmAsset(1),
            bytes1(0x0d),
            hex"010101000000",
            _accountKey20Location(beneficiary),
            bytes1(0x2c),
            requestId
        );
    }

    function _xcmAsset(uint256 amount) internal view returns (bytes memory) {
        return abi.encodePacked(_accountKey20Location(address(dot)), bytes1(0x00), _compact(amount));
    }

    function _accountKey20Location(address key) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes1(0x00), bytes1(0x01), bytes1(0x03), bytes1(0x00), key);
    }

    function _compact(uint256 value) internal pure returns (bytes memory) {
        if (value < 64) {
            return abi.encodePacked(bytes1(uint8(value << 2)));
        }
        if (value < 16_384) {
            uint16 raw16 = uint16((value << 2) | 1);
            return abi.encodePacked(bytes1(uint8(raw16)), bytes1(uint8(raw16 >> 8)));
        }
        if (value < 1_073_741_824) {
            uint32 raw32 = uint32((value << 2) | 2);
            return abi.encodePacked(
                bytes1(uint8(raw32)), bytes1(uint8(raw32 >> 8)), bytes1(uint8(raw32 >> 16)), bytes1(uint8(raw32 >> 24))
            );
        }

        uint256 byteLength;
        uint256 remaining = value;
        while (remaining > 0) {
            byteLength += 1;
            remaining >>= 8;
        }
        if (byteLength < 4) byteLength = 4;
        require(byteLength <= 67, "compact too large");

        bytes memory encoded = new bytes(1 + byteLength);
        encoded[0] = bytes1(uint8(((byteLength - 4) << 2) | 3));
        for (uint256 i = 0; i < byteLength; i++) {
            encoded[1 + i] = bytes1(uint8(value >> (8 * i)));
        }
        return encoded;
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
