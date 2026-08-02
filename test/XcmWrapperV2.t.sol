// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {IXcmStrategyAdapter} from "../contracts/interfaces/IXcmStrategyAdapter.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {HydrationUsdcAdapter} from "../contracts/strategies/HydrationUsdcAdapter.sol";
import {XcmWrapperV2} from "../contracts/XcmWrapperV2.sol";

contract MockXcmPrecompileV2 {
    uint256 public executeCount;
    uint256 public sendCount;
    bytes32 public lastDestinationHash;
    bytes32 public lastMessageHash;
    uint256 public callerAssetBalanceDuringExecute;
    address public asset;
    bool public failExecute;
    bool public failSend;

    error MockDispatchFailed();

    function setAsset(address asset_) external {
        asset = asset_;
    }

    function setFailExecute(bool fail) external {
        failExecute = fail;
    }

    function setFailSend(bool fail) external {
        failSend = fail;
    }

    function execute(bytes calldata message, IXcmWrapper.Weight calldata) external {
        if (failExecute) revert MockDispatchFailed();
        executeCount++;
        lastMessageHash = keccak256(message);
        callerAssetBalanceDuringExecute = MockERC20(asset).balanceOf(msg.sender);
    }

    function send(bytes calldata destination, bytes calldata message) external {
        if (failSend) revert MockDispatchFailed();
        sendCount++;
        lastDestinationHash = keccak256(destination);
        lastMessageHash = keccak256(message);
    }

    function weighMessage(bytes calldata message) external pure returns (IXcmWrapper.Weight memory) {
        return IXcmWrapper.Weight({refTime: uint64(message.length * 10), proofSize: uint64(message.length)});
    }
}

contract MockAgentAccountCoreV2 {
    function approveAdapter(MockERC20 asset, HydrationUsdcAdapter adapter) external {
        asset.approve(address(adapter), type(uint256).max);
    }

    function requestDeposit(
        HydrationUsdcAdapter adapter,
        address account,
        uint256 assets,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external returns (bytes32 requestId) {
        return adapter.requestDeposit(account, assets, destination, message, maxWeight, nonce);
    }

    function requestWithdraw(
        HydrationUsdcAdapter adapter,
        address account,
        uint256 shares,
        address recipient,
        bytes calldata destination,
        bytes calldata message,
        IXcmWrapper.Weight calldata maxWeight,
        uint64 nonce
    ) external returns (bytes32 requestId) {
        return adapter.requestWithdraw(account, shares, recipient, destination, message, maxWeight, nonce);
    }

    function releaseRecoveredAssets(HydrationUsdcAdapter adapter, bytes32 requestId, uint256 assets) external {
        adapter.releaseRecoveredAssets(requestId, address(this), assets);
    }
}

abstract contract XcmWrapperV2Fixture is Test {
    TreasuryPolicy internal policy;
    MockXcmPrecompileV2 internal precompile;
    XcmWrapperV2 internal wrapper;
    HydrationUsdcAdapter internal adapter;
    MockERC20 internal asset;
    MockAgentAccountCoreV2 internal mockAccounts;

    address internal constant ACCOUNT = 0x089a0A57D001bACb8473161e007F0bAbC1768CeE;
    address internal constant RECIPIENT = 0x7E071d5E9Fbe0c528EAcDe83B4662b77A041EFb9;
    address internal constant OPERATOR = address(0xB0B);
    address internal constant OPERATOR_TWO = address(0xB0C);
    address internal constant PAUSER = address(0xFA05E);
    address internal constant SINK = address(0xDEAD);
    bytes32 internal constant STRATEGY_ID = bytes32("HYDRATION_USDC_V1");
    bytes32 internal constant HYDRATION_ACCOUNT = 0x51845ee08e8949d64f0016be27942ce7b6d21df02c3b00104a290ca4e749fc55;
    bytes internal constant LOCAL_DESTINATION = hex"050000";
    bytes internal constant HYDRATION_DESTINATION = hex"05010100c91f";
    IXcmWrapper.Weight internal WEIGHT = IXcmWrapper.Weight({refTime: 4_000_000_000, proofSize: 100_000});

    function setUp() public virtual {
        policy = new TreasuryPolicy();
        precompile = new MockXcmPrecompileV2();

        asset = new MockERC20("USDC", "USDC");
        wrapper = new XcmWrapperV2(policy, address(precompile));
        mockAccounts = new MockAgentAccountCoreV2();
        adapter = new HydrationUsdcAdapter(policy, address(asset), STRATEGY_ID, wrapper, address(mockAccounts));

        precompile.setAsset(address(asset));
        policy.setPauser(PAUSER);
        policy.setStrategySettler(OPERATOR, true);
        policy.setStrategySettler(OPERATOR_TWO, true);
        policy.setStrategySettler(address(mockAccounts), true);
        wrapper.setOperator(OPERATOR);
        wrapper.setStrategyAdapter(STRATEGY_ID, address(adapter));
        wrapper.setHydrationAccountId32(HYDRATION_ACCOUNT);
        wrapper.setDispatchPaused(false);

        asset.mint(address(mockAccounts), 1_000_000);
        mockAccounts.approveAdapter(asset, adapter);
    }

    function _depositContext(uint256 amount, uint64 nonce) internal view returns (IXcmWrapper.RequestContext memory) {
        return IXcmWrapper.RequestContext({
            strategyId: STRATEGY_ID,
            kind: IXcmWrapper.RequestKind.Deposit,
            account: ACCOUNT,
            asset: address(asset),
            recipient: ACCOUNT,
            assets: amount,
            shares: 0,
            nonce: nonce
        });
    }

    function _withdrawContext(uint256 shares, uint64 nonce) internal view returns (IXcmWrapper.RequestContext memory) {
        return IXcmWrapper.RequestContext({
            strategyId: STRATEGY_ID,
            kind: IXcmWrapper.RequestKind.Withdraw,
            account: ACCOUNT,
            asset: address(asset),
            recipient: RECIPIENT,
            assets: 0,
            shares: shares,
            nonce: nonce
        });
    }

    function _fundMessage(uint256 amount, bytes32 requestId) internal pure returns (bytes memory) {
        bytes memory encoded = _compact(amount);
        return abi.encodePacked(
            hex"051000040002043205e51400",
            encoded,
            hex"2b010e00040002043205e51400",
            encoded,
            hex"010100c91f0813010300a10f043205e51400",
            encoded,
            hex"000d01020400010100",
            HYDRATION_ACCOUNT,
            hex"2c",
            requestId
        );
    }

    function _sellMessage(bool withdraw, uint256 fee, uint256 amount, bytes32 requestId)
        internal
        pure
        returns (bytes memory)
    {
        return _sellMessageWithCompacts(withdraw, _compact(fee), _compact(fee), amount, requestId);
    }

    function _sellMessageWithCompacts(
        bool withdraw,
        bytes memory firstFee,
        bytes memory repeatedFee,
        uint256 amount,
        bytes32 requestId
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"05180004010300a10f043205e51400",
            firstFee,
            hex"13010300a10f043205e51400",
            repeatedFee,
            hex"000601010700c817a80482841e00d04300",
            withdraw ? hex"eb03000016000000" : hex"16000000eb030000",
            _leU128(amount),
            new bytes(16),
            withdraw ? hex"0404eb03000016000000140d01020400010100" : hex"040416000000eb030000140d01020400010100",
            HYDRATION_ACCOUNT,
            hex"2c",
            requestId
        );
    }

    function _homeMessage(uint256 amount, uint256 fee, bytes32 requestId) internal view returns (bytes memory) {
        return _homeMessageWithCompacts(_compact(amount), _compact(amount), _compact(fee), requestId);
    }

    function _homeMessageWithCompacts(
        bytes memory outerAmount,
        bytes memory repeatedAmount,
        bytes memory nestedFee,
        bytes32 requestId
    ) internal view returns (bytes memory) {
        return abi.encodePacked(
            hex"05140004010300a10f043205e51400",
            outerAmount,
            hex"13010300a10f043205e51400",
            repeatedAmount,
            hex"001410010204010100a10f08130002043205e51400",
            nestedFee,
            hex"000d01020400010100",
            _wrapperAccountId32(),
            hex"2c",
            requestId
        );
    }

    function _wrapperAccountId32() internal view returns (bytes32) {
        return bytes32(bytes20(address(wrapper))) | bytes32(uint256(0xeeeeeeeeeeeeeeeeeeeeeeee));
    }

    function _compact(uint256 value) internal pure returns (bytes memory encoded) {
        if (value < 64) return abi.encodePacked(bytes1(uint8(value << 2)));
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
        revert("FIXTURE_AMOUNT_TOO_LARGE");
    }

    function _nonCanonicalMode3Compact(uint256 value) internal pure returns (bytes memory) {
        require(value < 1 << 32, "FIXTURE_AMOUNT_TOO_LARGE");
        return abi.encodePacked(
            hex"03",
            bytes1(uint8(value)),
            bytes1(uint8(value >> 8)),
            bytes1(uint8(value >> 16)),
            bytes1(uint8(value >> 24))
        );
    }

    function _leU128(uint256 value) internal pure returns (bytes memory encoded) {
        encoded = new bytes(16);
        for (uint256 i = 0; i < 16; i++) {
            encoded[i] = bytes1(uint8(value >> (i * 8)));
        }
    }

    function _discardWrapperBalance(uint256 amount) internal {
        vm.prank(address(wrapper));
        asset.transfer(SINK, amount);
    }

    function _requestDeposit(uint256 assets, bytes memory message, uint64 nonce) internal returns (bytes32) {
        vm.prank(OPERATOR);
        return mockAccounts.requestDeposit(adapter, ACCOUNT, assets, LOCAL_DESTINATION, message, WEIGHT, nonce);
    }

    function _requestWithdraw(uint256 shares, bytes memory message, uint64 nonce) internal returns (bytes32) {
        vm.prank(OPERATOR);
        return mockAccounts.requestWithdraw(
            adapter, ACCOUNT, shares, RECIPIENT, HYDRATION_DESTINATION, message, WEIGHT, nonce
        );
    }

    function _assertWithdrawRequestReverts(bytes memory message, uint64 nonce, bytes4 selector) internal {
        vm.prank(OPERATOR);
        (bool ok, bytes memory data) = address(mockAccounts)
            .call(
                abi.encodeCall(
                    mockAccounts.requestWithdraw,
                    (adapter, ACCOUNT, 100_000, RECIPIENT, HYDRATION_DESTINATION, message, WEIGHT, nonce)
                )
            );
        _assertCustomError(ok, data, selector);
    }

    function _assertQueueReverts(
        IXcmWrapper.RequestContext memory context,
        bytes memory destination,
        bytes memory message,
        bytes4 selector,
        address caller
    ) internal {
        vm.prank(caller);
        (bool ok, bytes memory data) =
            address(wrapper).call(abi.encodeCall(wrapper.queueRequest, (context, destination, message, WEIGHT)));
        _assertCustomError(ok, data, selector);
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

contract XcmWrapperV2Test is XcmWrapperV2Fixture {
    function _seedStrategyShares(uint64 nonce) internal {
        IXcmWrapper.RequestContext memory deposit = _depositContext(150_000, nonce);
        bytes32 requestId = wrapper.previewRequestId(deposit);
        _requestDeposit(150_000, _fundMessage(150_000, requestId), nonce);
        _discardWrapperBalance(150_000);
        vm.prank(OPERATOR);
        wrapper.queueRequest(deposit, HYDRATION_DESTINATION, _sellMessage(false, 30_000, 100_000, requestId), WEIGHT);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, bytes32("REMOTE"), bytes32(0)
        );
    }

    function testPinnedV2FourLegFixtureAndAccountingReplay() public {
        IXcmWrapper.RequestContext memory deposit = _depositContext(150_000, 1);
        bytes32 depositId = wrapper.previewRequestId(deposit);
        bytes memory funding = _fundMessage(150_000, depositId);
        bytes memory supply = _sellMessage(false, 30_000, 100_000, depositId);

        bytes32 queued = _requestDeposit(150_000, funding, 1);
        require(queued == depositId, "DEPOSIT_REQUEST_ID");
        assertEq(precompile.executeCount(), 1);
        assertEq(precompile.callerAssetBalanceDuringExecute(), 150_000);
        assertEq(asset.balanceOf(address(adapter)), 0);
        assertEq(wrapper.requestDispatchBitmap(depositId), 1);

        _discardWrapperBalance(150_000);
        vm.prank(OPERATOR);
        wrapper.queueRequest(deposit, HYDRATION_DESTINATION, supply, WEIGHT);
        assertEq(precompile.sendCount(), 1);
        assertEq(wrapper.requestDispatchBitmap(depositId), 3);

        vm.prank(OPERATOR);
        adapter.settleRequest(
            depositId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, bytes32("AUSDC_MINT"), bytes32(0)
        );
        assertEq(adapter.totalAssets(), 100_000);
        assertEq(adapter.totalShares(), 100_000);

        IXcmWrapper.RequestContext memory withdraw = _withdrawContext(100_000, 2);
        bytes32 withdrawId = wrapper.previewRequestId(withdraw);
        bytes memory redeem = _sellMessage(true, 28_000, 100_000, withdrawId);
        bytes memory home = _homeMessage(100_000, 100_000, withdrawId);

        _requestWithdraw(100_000, redeem, 2);
        vm.prank(OPERATOR);
        wrapper.queueRequest(withdraw, HYDRATION_DESTINATION, home, WEIGHT);
        assertEq(precompile.sendCount(), 3);
        assertEq(wrapper.requestDispatchBitmap(withdrawId), 12);

        asset.mint(address(wrapper), 75_000);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            withdrawId, IXcmWrapper.RequestStatus.Succeeded, 75_000, 100_000, bytes32("USDC_RETURN"), bytes32(0)
        );
        assertEq(asset.balanceOf(RECIPIENT), 75_000);
        assertEq(asset.balanceOf(address(adapter)), 0);
        assertEq(adapter.totalAssets(), 0);
        assertEq(adapter.totalShares(), 0);

        // Pin the complete v2 bytes, including SetTopic and wrapper beneficiaries.
        require(
            keccak256(funding) == 0x9f7c895014becd681553d16c3e19d787ded8e0126cf2ba2d60a4731b16cae04f,
            "FUNDING_FIXTURE_DRIFT"
        );
        require(
            keccak256(supply) == 0x962ae238a7f5f69958fd3c9e7124628c122c26860acb09cd8ab3d08f293d25df,
            "SUPPLY_FIXTURE_DRIFT"
        );
        require(
            keccak256(redeem) == 0xb4b7b21d1eb2d3d66875a7cc3a8f06c5651599e347e397bd3d8aaeff1f32f683,
            "REDEEM_FIXTURE_DRIFT"
        );
        require(
            keccak256(home) == 0x992ab51d651bf3ac3cf31202ceb489da6b0bb6dadd0c1be2e1180b4d7c8fcf9d, "HOME_FIXTURE_DRIFT"
        );
    }

    function testExactLegReplayIsIdempotentAndConflictingReplayReverts() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 10);
        bytes32 requestId = wrapper.previewRequestId(context);
        bytes memory funding = _fundMessage(150_000, requestId);
        bytes memory supply = _sellMessage(false, 30_000, 100_000, requestId);

        _requestDeposit(150_000, funding, 10);
        _requestDeposit(150_000, funding, 10);
        assertEq(precompile.executeCount(), 1);

        _discardWrapperBalance(150_000);
        vm.prank(OPERATOR);
        wrapper.queueRequest(context, HYDRATION_DESTINATION, supply, WEIGHT);
        vm.prank(OPERATOR);
        wrapper.queueRequest(context, HYDRATION_DESTINATION, supply, WEIGHT);
        assertEq(precompile.sendCount(), 1);

        vm.prank(OPERATOR);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (context, HYDRATION_DESTINATION, _sellMessage(false, 29_000, 100_000, requestId), WEIGHT)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.PayloadMismatch.selector);
    }

    function testPayloadMutationsWrongAccountTopicTrailingAndFifthShapeRevert() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 11);
        bytes32 requestId = wrapper.previewRequestId(context);
        bytes memory wrongAccount = _fundMessage(150_000, requestId);
        wrongAccount[wrongAccount.length - 65] ^= bytes1(uint8(1));

        vm.prank(OPERATOR);
        (bool ok, bytes memory data) = address(mockAccounts)
            .call(
                abi.encodeCall(
                    mockAccounts.requestDeposit,
                    (adapter, ACCOUNT, 150_000, LOCAL_DESTINATION, wrongAccount, WEIGHT, 11)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.XcmContextMismatch.selector);

        bytes memory wrongTopic = _fundMessage(150_000, requestId);
        wrongTopic[wrongTopic.length - 1] ^= bytes1(uint8(1));
        vm.prank(OPERATOR);
        (ok, data) = address(mockAccounts)
            .call(
                abi.encodeCall(
                    mockAccounts.requestDeposit, (adapter, ACCOUNT, 150_000, LOCAL_DESTINATION, wrongTopic, WEIGHT, 11)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.XcmContextMismatch.selector);

        bytes memory trailing = abi.encodePacked(_fundMessage(150_000, requestId), hex"00");
        vm.prank(OPERATOR);
        (ok, data) = address(mockAccounts)
            .call(
                abi.encodeCall(
                    mockAccounts.requestDeposit, (adapter, ACCOUNT, 150_000, LOCAL_DESTINATION, trailing, WEIGHT, 11)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.XcmContextMismatch.selector);

        vm.prank(OPERATOR);
        (ok, data) = address(mockAccounts)
            .call(
                abi.encodeCall(
                    mockAccounts.requestDeposit,
                    (adapter, ACCOUNT, 150_000, LOCAL_DESTINATION, hex"0504002c", WEIGHT, 11)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.XcmContextMismatch.selector);
    }

    function testDepositSellRejectsRouterDirectionBudgetDestinationAndInstructionMutations() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 16);
        bytes32 requestId = wrapper.previewRequestId(context);
        _requestDeposit(150_000, _fundMessage(150_000, requestId), 16);
        _discardWrapperBalance(150_000);

        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _sellMessage(true, 30_000, 100_000, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );
        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _sellMessage(false, 60_000, 100_000, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );
        _assertQueueReverts(
            context,
            hex"05010100b91f",
            _sellMessage(false, 30_000, 100_000, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );

        bytes memory wrongCount = _sellMessage(false, 30_000, 100_000, requestId);
        wrongCount[1] = 0x14;
        _assertQueueReverts(
            context, HYDRATION_DESTINATION, wrongCount, XcmWrapperV2.XcmContextMismatch.selector, OPERATOR
        );

        bytes memory wrongRouter = _sellMessage(false, 30_000, 100_000, requestId);
        wrongRouter[54] ^= bytes1(uint8(1));
        _assertQueueReverts(
            context, HYDRATION_DESTINATION, wrongRouter, XcmWrapperV2.XcmContextMismatch.selector, OPERATOR
        );
    }

    function testDepositSellRejectsNonCanonicalCompactFeeFields() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 19);
        bytes32 requestId = wrapper.previewRequestId(context);
        _requestDeposit(150_000, _fundMessage(150_000, requestId), 19);
        _discardWrapperBalance(150_000);

        bytes memory canonicalFee = _compact(30_000);
        bytes memory nonCanonicalFee = _nonCanonicalMode3Compact(30_000);
        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _sellMessageWithCompacts(false, nonCanonicalFee, canonicalFee, 100_000, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );
        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _sellMessageWithCompacts(false, canonicalFee, nonCanonicalFee, 100_000, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );
    }

    function testWithdrawSellRejectsNonCanonicalCompactFeeFields() public {
        _seedStrategyShares(20);
        IXcmWrapper.RequestContext memory context = _withdrawContext(100_000, 21);
        bytes32 requestId = wrapper.previewRequestId(context);
        bytes memory canonicalFee = _compact(28_000);
        bytes memory nonCanonicalFee = _nonCanonicalMode3Compact(28_000);

        _assertWithdrawRequestReverts(
            _sellMessageWithCompacts(true, nonCanonicalFee, canonicalFee, 100_000, requestId),
            21,
            XcmWrapperV2.XcmContextMismatch.selector
        );
        _assertWithdrawRequestReverts(
            _sellMessageWithCompacts(true, canonicalFee, nonCanonicalFee, 100_000, requestId),
            21,
            XcmWrapperV2.XcmContextMismatch.selector
        );
    }

    function testWithdrawHomeRejectsNonCanonicalCompactAmountAndFeeFields() public {
        _seedStrategyShares(22);
        IXcmWrapper.RequestContext memory context = _withdrawContext(100_000, 23);
        bytes32 requestId = wrapper.previewRequestId(context);
        _requestWithdraw(100_000, _sellMessage(true, 28_000, 100_000, requestId), 23);

        bytes memory canonical = _compact(100_000);
        bytes memory nonCanonical = _nonCanonicalMode3Compact(100_000);
        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _homeMessageWithCompacts(nonCanonical, canonical, canonical, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );
        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _homeMessageWithCompacts(canonical, nonCanonical, canonical, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );
        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _homeMessageWithCompacts(canonical, canonical, nonCanonical, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );
    }

    function testWithdrawHomeRejectsBeneficiaryAmountParaAndNestedInstructionMutations() public {
        IXcmWrapper.RequestContext memory deposit = _depositContext(150_000, 17);
        bytes32 depositId = wrapper.previewRequestId(deposit);
        _requestDeposit(150_000, _fundMessage(150_000, depositId), 17);
        _discardWrapperBalance(150_000);
        vm.prank(OPERATOR);
        wrapper.queueRequest(deposit, HYDRATION_DESTINATION, _sellMessage(false, 30_000, 100_000, depositId), WEIGHT);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            depositId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, bytes32("REMOTE"), bytes32(0)
        );

        IXcmWrapper.RequestContext memory context = _withdrawContext(100_000, 18);
        bytes32 requestId = wrapper.previewRequestId(context);
        _requestWithdraw(100_000, _sellMessage(true, 28_000, 100_000, requestId), 18);

        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _homeMessage(100_001, 100_000, requestId),
            XcmWrapperV2.XcmContextMismatch.selector,
            OPERATOR
        );

        bytes memory wrongBeneficiary = _homeMessage(100_000, 100_000, requestId);
        wrongBeneficiary[wrongBeneficiary.length - 65] ^= bytes1(uint8(1));
        _assertQueueReverts(
            context, HYDRATION_DESTINATION, wrongBeneficiary, XcmWrapperV2.XcmContextMismatch.selector, OPERATOR
        );

        bytes memory wrongNested = _homeMessage(100_000, 100_000, requestId);
        wrongNested[50] ^= bytes1(uint8(1));
        _assertQueueReverts(
            context, HYDRATION_DESTINATION, wrongNested, XcmWrapperV2.XcmContextMismatch.selector, OPERATOR
        );
    }

    function testWrongPhaseAndArbitraryCallerCannotDispatch() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 12);
        bytes32 requestId = wrapper.previewRequestId(context);

        vm.prank(OPERATOR);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (context, HYDRATION_DESTINATION, _sellMessage(false, 30_000, 100_000, requestId), WEIGHT)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.Unauthorized.selector);

        vm.prank(address(0xBAD));
        (ok, data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, LOCAL_DESTINATION, _fundMessage(150_000, requestId), WEIGHT)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.Unauthorized.selector);
    }

    function testExecuteFailureRollsBackCustodyPullAndRequest() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 13);
        bytes32 requestId = wrapper.previewRequestId(context);
        precompile.setFailExecute(true);

        vm.prank(OPERATOR);
        (bool ok, bytes memory data) = address(mockAccounts)
            .call(
                abi.encodeCall(
                    mockAccounts.requestDeposit,
                    (adapter, ACCOUNT, 150_000, LOCAL_DESTINATION, _fundMessage(150_000, requestId), WEIGHT, 13)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.XcmDispatchFailed.selector);

        assertEq(asset.balanceOf(address(mockAccounts)), 1_000_000);
        assertEq(asset.balanceOf(address(adapter)), 0);
        assertEq(asset.balanceOf(address(wrapper)), 0);
        assertEq(uint256(wrapper.getRequest(requestId).status), uint256(IXcmWrapper.RequestStatus.Unknown));
    }

    function testBareEoaStrategySettlerCannotStageOwnWalletCapital() public {
        uint256 amount = 150_000;
        IXcmWrapper.RequestContext memory context = _depositContext(amount, 24);
        bytes32 requestId = wrapper.previewRequestId(context);
        asset.mint(OPERATOR, amount);
        vm.startPrank(OPERATOR);
        asset.approve(address(adapter), amount);
        (bool ok, bytes memory data) = address(adapter)
            .call(
                abi.encodeCall(
                    adapter.requestDeposit,
                    (ACCOUNT, amount, LOCAL_DESTINATION, _fundMessage(amount, requestId), WEIGHT, 24)
                )
            );
        vm.stopPrank();

        _assertCustomError(ok, data, HydrationUsdcAdapter.Unauthorized.selector);
        require(policy.strategySettler(OPERATOR), "EOA_NOT_STRATEGY_SETTLER");
        assertEq(asset.balanceOf(OPERATOR), amount);
        assertEq(asset.balanceOf(address(adapter)), 0);
        assertEq(precompile.executeCount(), 0);
    }

    function testOwnerPauserOperatorRotationAndGlobalPauseBoundaries() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 14);
        bytes32 requestId = wrapper.previewRequestId(context);

        vm.prank(PAUSER);
        wrapper.setDispatchPaused(true);
        _assertQueueReverts(
            context,
            LOCAL_DESTINATION,
            _fundMessage(150_000, requestId),
            XcmWrapperV2.ProtocolPaused.selector,
            address(adapter)
        );
        vm.prank(PAUSER);
        (bool ok, bytes memory data) = address(wrapper).call(abi.encodeCall(wrapper.setDispatchPaused, (false)));
        _assertCustomError(ok, data, XcmWrapperV2.Unauthorized.selector);
        wrapper.setDispatchPaused(false);

        _requestDeposit(150_000, _fundMessage(150_000, requestId), 14);
        _discardWrapperBalance(150_000);

        wrapper.setDispatchPaused(true);
        wrapper.setOperator(OPERATOR_TWO);
        wrapper.setDispatchPaused(false);

        vm.prank(OPERATOR_TWO);
        (ok, data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (context, HYDRATION_DESTINATION, _sellMessage(false, 30_000, 100_000, requestId), WEIGHT)
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.Unauthorized.selector);
        vm.prank(OPERATOR);
        wrapper.queueRequest(context, HYDRATION_DESTINATION, _sellMessage(false, 30_000, 100_000, requestId), WEIGHT);

        policy.setPaused(true);
        vm.prank(OPERATOR);
        (ok, data) = address(adapter)
            .call(
                abi.encodeCall(
                    adapter.settleRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, bytes32("REMOTE"), bytes32(0))
                )
            );
        _assertCustomError(ok, data, HydrationUsdcAdapter.ProtocolPaused.selector);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32("REMOTE"), bytes32("PAUSED_FAIL")
        );
    }

    function testRemoteOperatingFloatIsVisibleButCannotMintStrategyAssets() public {
        vm.prank(OPERATOR);
        adapter.recordRemoteOperatingFloat(7_113, 1_722_600_000, bytes32("HYDRATION_READ"));
        assertEq(adapter.remoteOperatingFloat(), 7_113);
        assertEq(adapter.remoteOperatingFloatAsOf(), 1_722_600_000);
        assertEq(adapter.totalAssets(), 0);
        assertEq(adapter.totalShares(), 0);

        vm.prank(address(0xBAD));
        (bool ok, bytes memory data) = address(adapter)
            .call(abi.encodeCall(adapter.recordRemoteOperatingFloat, (9_999, 1_722_600_001, bytes32("FAKE"))));
        _assertCustomError(ok, data, HydrationUsdcAdapter.Unauthorized.selector);
    }

    function testSettlementBoundsAndTerminalReplayRemainIdempotent() public {
        IXcmWrapper.RequestContext memory context = _depositContext(150_000, 15);
        bytes32 requestId = wrapper.previewRequestId(context);
        _requestDeposit(150_000, _fundMessage(150_000, requestId), 15);
        _discardWrapperBalance(150_000);
        vm.prank(OPERATOR);
        wrapper.queueRequest(context, HYDRATION_DESTINATION, _sellMessage(false, 30_000, 100_000, requestId), WEIGHT);

        vm.prank(address(adapter));
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.finalizeRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 150_001, 100_000, bytes32("REMOTE"), bytes32(0))
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.InvalidSettlement.selector);

        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, bytes32("REMOTE"), bytes32(0)
        );
        vm.prank(address(adapter));
        wrapper.finalizeRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, bytes32("REMOTE"), bytes32(0)
        );
    }

    function testWithdrawSettlementAssetsCannotExceedRequestedShares() public {
        _seedStrategyShares(25);
        IXcmWrapper.RequestContext memory context = _withdrawContext(100_000, 26);
        bytes32 requestId = wrapper.previewRequestId(context);
        _requestWithdraw(100_000, _sellMessage(true, 28_000, 100_000, requestId), 26);
        vm.prank(OPERATOR);
        wrapper.queueRequest(context, HYDRATION_DESTINATION, _homeMessage(100_000, 100_000, requestId), WEIGHT);

        vm.prank(address(adapter));
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.finalizeRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 100_001, 100_000, bytes32("REMOTE"), bytes32(0))
                )
            );
        _assertCustomError(ok, data, XcmWrapperV2.InvalidSettlement.selector);
    }

    function testWithdrawHomeFailureRecoveryReturnsFullAmountAndClearsOutstanding() public {
        _seedStrategyShares(27);
        IXcmWrapper.RequestContext memory context = _withdrawContext(100_000, 28);
        bytes32 requestId = wrapper.previewRequestId(context);
        _requestWithdraw(100_000, _sellMessage(true, 28_000, 100_000, requestId), 28);
        assertEq(wrapper.requestDispatchBitmap(requestId), 4);

        precompile.setFailSend(true);
        _assertQueueReverts(
            context,
            HYDRATION_DESTINATION,
            _homeMessage(100_000, 100_000, requestId),
            XcmWrapperV2.XcmDispatchFailed.selector,
            OPERATOR
        );
        precompile.setFailSend(false);

        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32("HOME_FAILED"), bytes32("NO_RETURN")
        );
        assertEq(uint256(wrapper.getRequest(requestId).status), uint256(IXcmWrapper.RequestStatus.Failed));
        require(adapter.requiresRemoteRecovery(requestId), "WITHDRAW_RECOVERY_NOT_REQUIRED");
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 100_000);

        uint256 requesterBefore = asset.balanceOf(address(mockAccounts));
        asset.mint(address(wrapper), 100_000); // owner recovery XCM arrival
        wrapper.setDispatchPaused(true);
        wrapper.releaseRecoveredAssetsToAdapter(requestId, 100_000);
        assertEq(wrapper.requestRecoveryReleased(requestId), 100_000);
        assertEq(asset.balanceOf(address(adapter)), 100_000);

        mockAccounts.releaseRecoveredAssets(adapter, requestId, 100_000);
        assertEq(asset.balanceOf(address(mockAccounts)) - requesterBefore, 100_000);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 0);
        require(!adapter.requiresRemoteRecovery(requestId), "WITHDRAW_RECOVERY_NOT_CLEARED");
        assertEq(adapter.totalAssets(), 0);
        assertEq(adapter.totalShares(), 0);
    }
}

contract XcmWrapperV2RecoveryAccountingTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    MockXcmPrecompileV2 internal precompile;
    XcmWrapperV2 internal wrapper;
    HydrationUsdcAdapter internal adapter;
    MockERC20 internal asset;

    address internal constant WORKER = address(0xA11CE);
    address internal constant SINK = address(0xDEAD);
    bytes32 internal constant STRATEGY_ID = bytes32("HYDRATION_USDC_V1");
    bytes32 internal constant REMOTE = 0x51845ee08e8949d64f0016be27942ce7b6d21df02c3b00104a290ca4e749fc55;
    IXcmWrapper.Weight internal WEIGHT = IXcmWrapper.Weight({refTime: 4_000_000_000, proofSize: 100_000});

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        asset = new MockERC20("USDC", "USDC");
        precompile = new MockXcmPrecompileV2();
        wrapper = new XcmWrapperV2(policy, address(precompile));
        adapter = new HydrationUsdcAdapter(policy, address(asset), STRATEGY_ID, wrapper, address(accounts));

        precompile.setAsset(address(asset));
        policy.setApprovedAsset(address(asset), true);
        policy.setApprovedStrategy(address(adapter), true);
        policy.setStrategySettler(address(this), true);
        policy.setStrategySettler(address(accounts), true);
        registry.registerStrategy(address(adapter));
        wrapper.setOperator(address(this));
        wrapper.setStrategyAdapter(STRATEGY_ID, address(adapter));
        wrapper.setHydrationAccountId32(REMOTE);
        wrapper.setDispatchPaused(false);

        asset.mint(WORKER, 1_000_000);
        vm.startPrank(WORKER);
        asset.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(asset), 1_000_000);
        vm.stopPrank();
    }

    function testAgentAccountCoreStagesCustodyAndRemoteTimeoutOnlyRestoresReturnedAssets() public {
        uint256 amount = 150_000;
        uint64 nonce = 1;
        bytes32 requestId = keccak256(
            abi.encode(STRATEGY_ID, IXcmWrapper.RequestKind.Deposit, WORKER, address(asset), WORKER, amount, 0, nonce)
        );
        bytes memory funding = _fundMessage(amount, requestId);

        vm.prank(WORKER);
        accounts.requestStrategyDeposit(
            WORKER,
            AgentAccountCore.StrategyDepositRequestParams({
                strategyId: STRATEGY_ID,
                amount: amount,
                destination: hex"050000",
                message: funding,
                maxWeight: WEIGHT,
                nonce: nonce
            })
        );

        IXcmStrategyAdapter.AdapterRequest memory staged = adapter.getAdapterRequest(requestId);
        assertEq(staged.requester, address(accounts));
        assertEq(asset.balanceOf(address(accounts)), 850_000);
        assertEq(asset.balanceOf(address(adapter)), 0);
        assertEq(asset.balanceOf(address(wrapper)), amount);

        vm.prank(address(wrapper));
        asset.transfer(SINK, amount);
        accounts.settleStrategyRequest(
            requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32("TIMEOUT"), bytes32("NO_DELTA")
        );

        (uint256 liquid,,,,,) = accounts.positions(WORKER, address(asset));
        assertEq(liquid, 850_000);
        assertEq(accounts.pendingStrategyAssets(WORKER, address(asset)), 0);
        assertEq(accounts.strategyRecoveryAssets(WORKER, address(asset)), amount);
        assertEq(accounts.strategyRequestRecoveryOutstanding(requestId), amount);

        asset.mint(address(wrapper), 50_000);
        wrapper.setDispatchPaused(true);
        wrapper.releaseRecoveredAssetsToAdapter(requestId, 50_000);
        accounts.completeStrategyRecovery(requestId, 50_000);

        (liquid,,,,,) = accounts.positions(WORKER, address(asset));
        assertEq(liquid, 900_000);
        assertEq(accounts.strategyRecoveryAssets(WORKER, address(asset)), 100_000);
        assertEq(accounts.strategyRequestRecoveryOutstanding(requestId), 100_000);
    }

    function _fundMessage(uint256 amount, bytes32 requestId) internal pure returns (bytes memory) {
        bytes memory encoded = _compact(amount);
        return abi.encodePacked(
            hex"051000040002043205e51400",
            encoded,
            hex"2b010e00040002043205e51400",
            encoded,
            hex"010100c91f0813010300a10f043205e51400",
            encoded,
            hex"000d01020400010100",
            REMOTE,
            hex"2c",
            requestId
        );
    }

    function _compact(uint256 value) internal pure returns (bytes memory) {
        if (value < 64) return abi.encodePacked(bytes1(uint8(value << 2)));
        if (value < 16_384) {
            uint16 raw16 = uint16((value << 2) | 1);
            return abi.encodePacked(bytes1(uint8(raw16)), bytes1(uint8(raw16 >> 8)));
        }
        uint32 raw32 = uint32((value << 2) | 2);
        return abi.encodePacked(
            bytes1(uint8(raw32)), bytes1(uint8(raw32 >> 8)), bytes1(uint8(raw32 >> 16)), bytes1(uint8(raw32 >> 24))
        );
    }
}
