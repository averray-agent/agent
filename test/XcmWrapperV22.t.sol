// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {IXcmWrapperV22} from "../contracts/interfaces/IXcmWrapperV22.sol";
import {HydrationUsdcAdapterV22} from "../contracts/strategies/HydrationUsdcAdapterV22.sol";
import {XcmWrapperV22} from "../contracts/XcmWrapperV22.sol";

interface VmExtendedV22 {
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
}

contract MockXcmPrecompileV22 {
    uint256 public executeCount;
    uint256 public sendCount;
    bytes public lastDestination;
    bytes public lastMessage;
    IXcmWrapper.Weight public lastWeight;
    address public asset;
    uint256 public callerAssetBalanceDuringExecute;
    bool public failExecute;
    bool public failSend;
    bool public unweighable;

    error MockDispatchFailed();
    error UnknownShape();

    function setAsset(address asset_) external {
        asset = asset_;
    }

    function setFailExecute(bool fail) external {
        failExecute = fail;
    }

    function setFailSend(bool fail) external {
        failSend = fail;
    }

    function setUnweighable(bool value) external {
        unweighable = value;
    }

    function execute(bytes calldata message, IXcmWrapper.Weight calldata maxWeight) external {
        if (failExecute) revert MockDispatchFailed();
        if (message.length < 2 || message[0] != 0x05 || message[1] != 0x10) revert UnknownShape();
        executeCount++;
        lastMessage = message;
        lastWeight = maxWeight;
        callerAssetBalanceDuringExecute = MockERC20(asset).balanceOf(msg.sender);
    }

    function send(bytes calldata destination, bytes calldata message) external {
        if (failSend) revert MockDispatchFailed();
        if (message.length < 2 || message[0] != 0x05 || (message[1] != 0x18 && message[1] != 0x14)) {
            revert UnknownShape();
        }
        sendCount++;
        lastDestination = destination;
        lastMessage = message;
    }

    function weighMessage(bytes calldata message) external view returns (IXcmWrapper.Weight memory) {
        if (unweighable) return IXcmWrapper.Weight({refTime: 0, proofSize: 0});
        return IXcmWrapper.Weight({refTime: uint64(message.length * 10), proofSize: uint64(message.length)});
    }
}

abstract contract XcmWrapperV22Fixture is Test {
    VmExtendedV22 internal constant vmx = VmExtendedV22(address(uint160(uint256(keccak256("hevm cheat code")))));
    TreasuryPolicy internal policy;
    MockXcmPrecompileV22 internal precompile;
    XcmWrapperV22 internal wrapper;
    HydrationUsdcAdapterV22 internal adapter;
    MockERC20 internal asset;

    address internal constant TREASURY = 0x01E6eed856e989201F4FF6346E18EAb7e46C874C;
    address internal constant ACCOUNT = 0x089a0A57D001bACb8473161e007F0bAbC1768CeE;
    address internal constant OPERATOR = address(0xB0B);
    address internal constant OTHER = address(0xBAD);
    address internal constant PAUSER = address(0xFA05E);
    address internal constant FUTURE_AGENT_ACCOUNT_CORE = address(0xAAC);
    bytes32 internal constant STRATEGY_ID = bytes32("HYDRATION_USDC_V22");
    bytes32 internal constant HYDRATION_ACCOUNT = 0x85663dfdb243b1a11a90f0816e1f83ccdb99f8f4c4a25d432739218efd489736;
    bytes internal constant LOCAL_DESTINATION = hex"050000";
    bytes internal constant HYDRATION_DESTINATION = hex"05010100c91f";

    event TerminalAccounting(
        bytes32 indexed requestId,
        uint256 requestedAssets,
        uint256 observedRemoteBalanceRaw,
        uint256 recoveryAssetsOutstanding
    );
    event ResidueWrittenOff(
        bytes32 indexed requestId, uint256 amountRaw, bytes32 indexed reasonCode, uint256 remaining
    );

    function setUp() public virtual {
        policy = new TreasuryPolicy();
        precompile = new MockXcmPrecompileV22();
        asset = new MockERC20("USDC", "USDC");
        wrapper = new XcmWrapperV22(policy, address(precompile));
        adapter = new HydrationUsdcAdapterV22(policy, address(asset), STRATEGY_ID, wrapper, FUTURE_AGENT_ACCOUNT_CORE);

        precompile.setAsset(address(asset));
        policy.setPauser(PAUSER);
        policy.setStrategySettler(OPERATOR, true);
        wrapper.setOperator(OPERATOR);
        wrapper.setStrategyAdapter(STRATEGY_ID, address(adapter));
        wrapper.setHydrationAccountId32(HYDRATION_ACCOUNT);
        wrapper.setDispatchPaused(false);
        policy.transferOwnership(TREASURY);

        asset.mint(TREASURY, 20_000_000);
        vm.prank(TREASURY);
        asset.approve(address(adapter), type(uint256).max);
    }

    function _stageDeposit(
        uint64 nonce,
        uint256 assets,
        uint256 sellAmount,
        uint256 minimumShares,
        uint256 maxFee,
        uint64 deadline
    ) internal returns (bytes32 requestId) {
        vm.prank(TREASURY);
        requestId = adapter.stageTreasuryDeposit(TREASURY, assets, sellAmount, minimumShares, maxFee, deadline, nonce);
    }

    function _stageWithdraw(
        uint64 nonce,
        uint256 shares,
        uint256 minimumAssets,
        uint256 remoteFeeBudget,
        uint64 deadline
    ) internal returns (bytes32 requestId) {
        vm.prank(TREASURY);
        requestId = adapter.stageTreasuryWithdraw(TREASURY, shares, minimumAssets, remoteFeeBudget, deadline, nonce);
    }

    function _dispatch(bytes32 requestId, IXcmWrapperV22.DispatchLeg leg, uint256 fee) internal {
        vm.prank(OPERATOR);
        wrapper.dispatchLeg(requestId, leg, fee);
    }

    function _seedShares(uint64 nonce) internal returns (bytes32 requestId) {
        requestId = _stageDeposit(nonce, 150_000, 100_000, 100_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositSell, 30_000);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, 0, bytes32("AUSDC_MINT"), bytes32(0)
        );
    }

    function _requestContext(bool withdraw, uint64 nonce, uint256 amount)
        internal
        view
        returns (IXcmWrapper.RequestContext memory)
    {
        return IXcmWrapper.RequestContext({
            strategyId: STRATEGY_ID,
            kind: withdraw ? IXcmWrapper.RequestKind.Withdraw : IXcmWrapper.RequestKind.Deposit,
            account: TREASURY,
            asset: address(asset),
            recipient: TREASURY,
            assets: withdraw ? 0 : amount,
            shares: withdraw ? amount : 0,
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

    function _sellMessage(bool withdraw, uint256 fee, uint256 amount, uint256 minimum, bytes32 requestId)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory encodedFee = _compact(fee);
        return abi.encodePacked(
            hex"05180004010300a10f043205e51400",
            encodedFee,
            hex"13010300a10f043205e51400",
            encodedFee,
            hex"000601010700c817a80482841e00d04300",
            withdraw ? hex"eb03000016000000" : hex"16000000eb030000",
            _leU128(amount),
            _leU128(minimum),
            withdraw ? hex"0404eb03000016000000140d01020400010100" : hex"040416000000eb030000140d01020400010100",
            HYDRATION_ACCOUNT,
            hex"2c",
            requestId
        );
    }

    function _homeMessage(uint256 amount, bytes32 topic) internal view returns (bytes memory) {
        bytes memory encoded = _compact(amount);
        return abi.encodePacked(
            hex"05140004010300a10f043205e51400",
            encoded,
            hex"13010300a10f043205e51400",
            encoded,
            hex"001410010204010100a10f08130002043205e51400",
            encoded,
            hex"000d01020400010100",
            _wrapperAccountId32(),
            hex"2c",
            topic
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
        uint32 raw32 = uint32((value << 2) | 2);
        return abi.encodePacked(
            bytes1(uint8(raw32)), bytes1(uint8(raw32 >> 8)), bytes1(uint8(raw32 >> 16)), bytes1(uint8(raw32 >> 24))
        );
    }

    function _leU128(uint256 value) internal pure returns (bytes memory encoded) {
        encoded = new bytes(16);
        for (uint256 i = 0; i < 16; i++) {
            encoded[i] = bytes1(uint8(value >> (i * 8)));
        }
    }

    function assertEq(bytes memory left, bytes memory right) internal pure {
        require(keccak256(left) == keccak256(right), "ASSERT_EQ_BYTES");
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "ASSERT_EQ_BYTES32");
    }

    function assertTrue(bool value) internal pure {
        require(value, "ASSERT_TRUE");
    }

    function assertFalse(bool value, string memory reason) internal pure {
        require(!value, reason);
    }

    function assertFalse(bool value) internal pure {
        require(!value, "ASSERT_FALSE");
    }

    function _bound(uint256 value, uint256 minimum, uint256 maximum) internal pure returns (uint256) {
        require(maximum >= minimum, "INVALID_BOUND");
        return minimum + (value % (maximum - minimum + 1));
    }
}

contract XcmWrapperV22Test is XcmWrapperV22Fixture {
    function testGoldenVectorsMatchKnownGoodV21FamiliesWithDocumentedSlots() public {
        bytes32 depositId = _stageDeposit(1, 150_000, 100_000, 95_000, 30_000, 0);

        (bytes memory destination, bytes memory message, IXcmWrapper.Weight memory measured) =
            wrapper.previewLegMessage(depositId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        assertEq(destination, LOCAL_DESTINATION);
        assertEq(message, _fundMessage(150_000, depositId));
        assertEq(measured.refTime, message.length * 20);
        assertEq(measured.proofSize, message.length * 2);

        _dispatch(depositId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        (destination, message,) = wrapper.previewLegMessage(depositId, IXcmWrapperV22.DispatchLeg.DepositSell, 29_500);
        assertEq(destination, HYDRATION_DESTINATION);
        assertEq(message, _sellMessage(false, 29_500, 100_000, 95_000, depositId));
        _dispatch(depositId, IXcmWrapperV22.DispatchLeg.DepositSell, 29_500);

        vm.prank(OPERATOR);
        adapter.settleRequest(
            depositId, IXcmWrapper.RequestStatus.Succeeded, 100_000, 100_000, 0, bytes32("AUSDC_MINT"), bytes32(0)
        );

        bytes32 withdrawId = _stageWithdraw(2, 100_000, 90_000, 28_000, 0);
        (destination, message,) = wrapper.previewLegMessage(withdrawId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 27_500);
        assertEq(destination, HYDRATION_DESTINATION);
        assertEq(message, _sellMessage(true, 27_500, 100_000, 90_000, withdrawId));
        _dispatch(withdrawId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 27_500);

        (destination, message,) = wrapper.previewLegMessage(withdrawId, IXcmWrapperV22.DispatchLeg.WithdrawHome, 0);
        assertEq(destination, HYDRATION_DESTINATION);
        assertEq(message, _homeMessage(90_000, withdrawId));
        _dispatch(withdrawId, IXcmWrapperV22.DispatchLeg.WithdrawHome, 0);

        assertEq(wrapper.requestDispatchBitmap(depositId), 0x03);
        assertEq(wrapper.requestDispatchBitmap(withdrawId), 0x0c);

        uint256 treasuryBefore = asset.balanceOf(TREASURY);
        asset.mint(address(wrapper), 90_000);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            withdrawId, IXcmWrapper.RequestStatus.Succeeded, 90_000, 100_000, 0, bytes32("USDC_RETURN"), bytes32(0)
        );
        assertEq(asset.balanceOf(TREASURY), treasuryBefore + 90_000);
        assertEq(adapter.totalAssets(), 0);
        assertEq(adapter.totalShares(), 0);
    }

    function testWithdrawSellZeroFeeReverts() public {
        _seedShares(12);
        bytes32 requestId = _stageWithdraw(13, 100_000, 95_000, 25_000, 0);

        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.FeeAboveMaximum.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 0);
    }

    function testWithdrawSellFeeAboveStagedMaximumReverts() public {
        _seedShares(14);
        bytes32 requestId = _stageWithdraw(15, 100_000, 95_000, 25_000, 0);

        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.FeeAboveMaximum.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 25_001);
    }

    function testWithdrawHomeRejectsOperatorFeeArgument() public {
        _seedShares(16);
        bytes32 requestId = _stageWithdraw(17, 100_000, 95_000, 25_000, 0);

        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 24_000);
        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.FeeAboveMaximum.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.WithdrawHome, 1);
    }

    function testDepositFeeAboveStagedMaximumReverts() public {
        bytes32 requestId = _stageDeposit(3, 150_000, 100_000, 95_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);

        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.FeeAboveMaximum.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.DepositSell, 30_001);
        assertEq(precompile.sendCount(), 0);
    }

    function testNonOperatorDispatchRevertsBeforePrecompile() public {
        bytes32 requestId = _stageDeposit(4, 150_000, 100_000, 95_000, 30_000, 0);
        vm.prank(OTHER);
        vmx.expectRevert(XcmWrapperV22.Unauthorized.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        assertEq(precompile.executeCount(), 0);
    }

    function testOperatorRotationImmediatelyRevokesPendingRequestAccess() public {
        bytes32 requestId = _stageDeposit(40, 150_000, 100_000, 95_000, 30_000, 0);

        vm.prank(TREASURY);
        wrapper.setDispatchPaused(true);
        vm.prank(TREASURY);
        wrapper.setOperator(OTHER);
        vm.prank(TREASURY);
        wrapper.setDispatchPaused(false);

        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.Unauthorized.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);

        vm.prank(OTHER);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        assertEq(precompile.executeCount(), 1);
    }

    function testLegReplayIsIdempotentAndDoesNotReprice() public {
        bytes32 requestId = _stageDeposit(5, 150_000, 100_000, 95_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, type(uint256).max);
        assertEq(precompile.executeCount(), 1);

        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositSell, 29_000);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositSell, 1);
        assertEq(precompile.sendCount(), 1);
    }

    function testDispatchDeadlineExpiresButCompletedReplayRemainsNoOp() public {
        uint64 deadline = uint64(block.timestamp + 10);
        bytes32 requestId = _stageDeposit(6, 150_000, 100_000, 95_000, 30_000, deadline);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        vm.warp(deadline + 1);

        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.DispatchDeadlineExpired.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.DepositSell, 29_000);
    }

    function testConstructiveSurfaceRejectsWrongLegAndHasNoRawPayloadArgument() public {
        bytes32 requestId = _stageDeposit(7, 150_000, 100_000, 95_000, 30_000, 0);
        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.InvalidRequest.selector);
        wrapper.dispatchLeg(requestId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 0);

        bytes4 oldRawQueueSelector = bytes4(
            keccak256(
                "queueRequest((bytes32,uint8,address,address,address,uint256,uint256,uint64),bytes,bytes,(uint64,uint64))"
            )
        );
        (bool ok,) = address(wrapper).call(abi.encodePacked(oldRawQueueSelector, bytes32(uint256(1))));
        assertFalse(ok, "v2.2 must not expose the raw-payload queue ABI");
        assertEq(precompile.executeCount(), 0);
        assertEq(precompile.sendCount(), 0);
    }

    function testFuzzConstructiveDepositSellOnlyEmitsReviewedShape(uint32 rawSell, uint32 rawMinimum, uint32 rawFee)
        public
    {
        uint256 sellAmount = _bound(uint256(rawSell), 1, 100_000);
        uint256 minimum = _bound(uint256(rawMinimum), 1, sellAmount);
        uint256 maxFee = _bound(uint256(rawFee), 1, 150_000 - sellAmount);
        bytes32 requestId = _stageDeposit(8, 150_000, sellAmount, minimum, maxFee, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        uint256 fee = _bound(uint256(rawFee), 1, maxFee);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositSell, fee);

        bytes memory emitted = precompile.lastMessage();
        assertEq(emitted, _sellMessage(false, fee, sellAmount, minimum, requestId));
        assertEq(precompile.sendCount(), 1);
    }

    function testFundingUsesFreshOnChainWeightTimesTwo() public {
        bytes32 requestId = _stageDeposit(9, 150_000, 100_000, 95_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        bytes memory emitted = precompile.lastMessage();
        (uint64 refTime, uint64 proofSize) = precompile.lastWeight();
        assertEq(refTime, emitted.length * 20);
        assertEq(proofSize, emitted.length * 2);

        bytes32 second = _stageDeposit(10, 150_000, 100_000, 95_000, 30_000, 0);
        precompile.setUnweighable(true);
        vm.prank(OPERATOR);
        vmx.expectRevert(XcmWrapperV22.XcmPrecompileUnavailable.selector);
        wrapper.dispatchLeg(second, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
    }

    function testConvertedAccountCannotChangeAfterInitialConfiguration() public {
        vm.prank(TREASURY);
        wrapper.setDispatchPaused(true);
        vm.prank(TREASURY);
        vmx.expectRevert(XcmWrapperV22.InvalidConfiguration.selector);
        wrapper.setHydrationAccountId32(bytes32(uint256(123)));
        assertEq(wrapper.hydrationAccountId32(), HYDRATION_ACCOUNT);
    }

    function testPauseRefusesStagingAndDispatch() public {
        vm.prank(PAUSER);
        wrapper.setDispatchPaused(true);
        vm.prank(TREASURY);
        vmx.expectRevert(XcmWrapperV22.ProtocolPaused.selector);
        adapter.stageTreasuryDeposit(TREASURY, 150_000, 100_000, 95_000, 30_000, 0, 11);
    }
}

contract HydrationUsdcAdapterV22TerminalTest is XcmWrapperV22Fixture {
    function _failedDeposit(uint64 nonce, uint256 observed) internal returns (bytes32 requestId) {
        requestId = _stageDeposit(nonce, 150_000, 100_000, 95_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, observed, bytes32("REMOTE_READ"), bytes32("XCM_FAILED")
        );
    }

    function testTerminalAccountingObservedBelowRequested() public {
        bytes32 requestId = _stageDeposit(20, 150_000, 100_000, 95_000, 30_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.DepositFunding, 0);

        vmx.expectEmit(true, false, false, true, address(adapter));
        emit TerminalAccounting(requestId, 150_000, 130_200, 130_200);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, 130_200, bytes32("REMOTE_READ"), bytes32("XCM_FAILED")
        );
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 130_200);
        assertTrue(adapter.requiresRemoteRecovery(requestId));
    }

    function testTerminalAccountingObservedZeroRecordsNoReceivable() public {
        bytes32 requestId = _failedDeposit(21, 0);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 0);
        assertFalse(adapter.requiresRemoteRecovery(requestId));
    }

    function testTerminalAccountingObservedAboveRequestedCapsAtRequested() public {
        bytes32 requestId = _failedDeposit(22, 175_000);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 150_000);
        assertTrue(adapter.requiresRemoteRecovery(requestId));
    }

    function testOwnerWritesOffResidueWithNamedEvent() public {
        bytes32 requestId = _failedDeposit(23, 130_200);
        bytes32 reason = bytes32("REMOTE_FEE_AND_TRAP");

        vmx.expectEmit(true, false, true, true, address(adapter));
        emit ResidueWrittenOff(requestId, 19_800, reason, 110_400);
        vm.prank(TREASURY);
        adapter.writeOffResidue(requestId, 19_800, reason);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 110_400);

        vm.prank(OTHER);
        vmx.expectRevert(HydrationUsdcAdapterV22.Unauthorized.selector);
        adapter.writeOffResidue(requestId, 1, reason);

        vm.prank(TREASURY);
        adapter.writeOffResidue(requestId, 110_400, reason);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 0);
        assertFalse(adapter.requiresRemoteRecovery(requestId));
    }

    function testRecoveryIsRequestBoundPausedOwnerOnlyAndFullBudget() public {
        bytes32 requestId = _failedDeposit(24, 100_000);
        vm.prank(TREASURY);
        wrapper.setDispatchPaused(true);
        bytes32 recoveryId = wrapper.previewRecoveryHomeId(requestId, 100_000, 1);

        (bytes memory destination, bytes memory message) = wrapper.previewRecoveryHomeMessage(requestId, 100_000, 1);
        assertEq(destination, HYDRATION_DESTINATION);
        assertEq(message, _homeMessage(100_000, recoveryId));

        vm.prank(OTHER);
        vmx.expectRevert(XcmWrapperV22.Unauthorized.selector);
        wrapper.dispatchRecoveryHome(requestId, 100_000, 1);

        vm.prank(TREASURY);
        wrapper.dispatchRecoveryHome(requestId, 100_000, 1);
        assertEq(precompile.sendCount(), 1);
        vm.prank(TREASURY);
        wrapper.dispatchRecoveryHome(requestId, 100_000, 1);
        assertEq(precompile.sendCount(), 1);

        asset.mint(address(wrapper), 100_000);
        vm.prank(TREASURY);
        wrapper.releaseRecoveredAssetsToAdapter(requestId, 100_000);
        uint256 before = asset.balanceOf(TREASURY);
        vm.prank(TREASURY);
        adapter.releaseRecoveredAssets(requestId, TREASURY, 100_000);
        assertEq(asset.balanceOf(TREASURY), before + 100_000);
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 0);
    }

    function testTerminalAccountingAlsoCapsFailedWithdraw() public {
        _seedShares(30);
        bytes32 requestId = _stageWithdraw(31, 100_000, 95_000, 25_000, 0);
        _dispatch(requestId, IXcmWrapperV22.DispatchLeg.WithdrawSell, 24_000);
        vm.prank(OPERATOR);
        adapter.settleRequest(
            requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, 120_000, bytes32("REMOTE_READ"), bytes32("HOME_FAILED")
        );
        assertEq(adapter.recoveryAssetsOutstanding(requestId), 100_000);
    }
}
