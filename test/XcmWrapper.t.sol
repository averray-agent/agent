// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {XcmWrapper} from "../contracts/XcmWrapper.sol";

contract MockXcmPrecompile {
    uint256 public sendCount;
    bytes32 public lastDestinationHash;
    bytes32 public lastMessageHash;
    bool public failSend;

    error MockSendFailed();

    function setFailSend(bool value) external {
        failSend = value;
    }

    function send(bytes calldata destination, bytes calldata message) external {
        if (failSend) revert MockSendFailed();
        sendCount += 1;
        lastDestinationHash = keccak256(destination);
        lastMessageHash = keccak256(message);
    }

    function weighMessage(bytes calldata message) external pure returns (IXcmWrapper.Weight memory) {
        return IXcmWrapper.Weight({refTime: uint64(message.length * 10), proofSize: uint64(message.length)});
    }
}

contract MockMalformedXcmPrecompile {
    fallback() external {
        assembly {
            mstore(0x00, not(0))
            mstore(0x20, 0)
            return(0x00, 0x40)
        }
    }

    function send(bytes calldata, bytes calldata) external {}
}

contract XcmWrapperTest is Test {
    TreasuryPolicy internal policy;
    MockXcmPrecompile internal precompile;
    XcmWrapper internal wrapper;

    address internal operator = address(0xB0B);
    address internal operator2 = address(0xB0C);
    address internal stranger = address(0xDEAD);

    bytes32 internal constant STRATEGY_ID = bytes32("VDOT_XCM_V1");
    address internal constant ASSET = address(0x1234);
    address internal constant RECIPIENT = address(0x5678);
    address internal constant BACKEND_ACCOUNT = 0x1234567890123456789012345678901234567890;
    address internal constant BACKEND_RECIPIENT = 0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD;

    function setUp() public {
        policy = new TreasuryPolicy();
        precompile = new MockXcmPrecompile();
        wrapper = new XcmWrapper(policy, address(precompile));

        policy.setStrategySettler(operator, true);
        policy.setStrategySettler(operator2, true);
    }

    function testQueueRequestPersistsPendingRecord() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes32 previewId = wrapper.previewRequestId(context);
        bytes memory message = _depositMessage(previewId);

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 111, proofSize: 222}));

        require(requestId == previewId, "WRONG_REQUEST_ID");
        IXcmWrapper.RequestRecord memory record = wrapper.getRequest(requestId);
        assertEq(uint256(record.status), uint256(IXcmWrapper.RequestStatus.Pending));
        require(record.context.strategyId == STRATEGY_ID, "WRONG_STRATEGY_ID");
        assertEq(record.context.account, operator);
        assertEq(record.context.asset, ASSET);
        assertEq(record.context.recipient, RECIPIENT);
        assertEq(record.context.assets, 25 ether);
        assertEq(record.context.shares, 0);
        assertEq(record.context.nonce, 1);
        require(wrapper.requestDestinationHash(requestId) == keccak256(hex"0102"), "WRONG_DEST_HASH");
        require(wrapper.requestMessageHash(requestId) == keccak256(message), "WRONG_MESSAGE_HASH");
        assertEq(precompile.sendCount(), 1);
        require(precompile.lastDestinationHash() == keccak256(hex"0102"), "PRECOMPILE_DESTINATION_NOT_SENT");
        require(precompile.lastMessageHash() == keccak256(message), "PRECOMPILE_MESSAGE_NOT_SENT");
    }

    function testQueueRequestAcceptsBackendBuilderDepositFixture() public {
        IXcmWrapper.RequestContext memory context = IXcmWrapper.RequestContext({
            strategyId: STRATEGY_ID,
            kind: IXcmWrapper.RequestKind.Deposit,
            account: operator,
            asset: ASSET,
            recipient: BACKEND_ACCOUNT,
            assets: 1_000_000_000,
            shares: 0,
            nonce: 77
        });
        bytes32 requestId = wrapper.previewRequestId(context);
        bytes memory message = _backendDepositFixture(requestId);

        vm.prank(operator);
        bytes32 queued =
            wrapper.queueRequest(context, hex"05010100b91f", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        require(queued == requestId, "WRONG_REQUEST_ID");
        require(wrapper.requestMessageHash(requestId) == keccak256(message), "BACKEND_FIXTURE_NOT_QUEUED");
    }

    function testQueueRequestAcceptsBackendBuilderWithdrawFixture() public {
        IXcmWrapper.RequestContext memory context = IXcmWrapper.RequestContext({
            strategyId: STRATEGY_ID,
            kind: IXcmWrapper.RequestKind.Withdraw,
            account: operator,
            asset: ASSET,
            recipient: BACKEND_RECIPIENT,
            assets: 0,
            shares: 2_000_000_000,
            nonce: 78
        });
        bytes32 requestId = wrapper.previewRequestId(context);
        bytes memory message = _backendWithdrawFixture(requestId);

        vm.prank(operator);
        bytes32 queued =
            wrapper.queueRequest(context, hex"05010100b91f", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        require(queued == requestId, "WRONG_REQUEST_ID");
        require(wrapper.requestMessageHash(requestId) == keccak256(message), "BACKEND_FIXTURE_NOT_QUEUED");
    }

    function testQueueRequestIsIdempotentForSamePayload() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.startPrank(operator);
        bytes32 first =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));
        bytes32 second =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));
        vm.stopPrank();

        require(first == second, "request id mismatch");
        IXcmWrapper.RequestRecord memory record = wrapper.getRequest(first);
        assertEq(uint256(record.status), uint256(IXcmWrapper.RequestStatus.Pending));
        assertEq(precompile.sendCount(), 1);
    }

    function testQueueRequestRevertsWhenPrecompileSendFails() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes32 requestId = wrapper.previewRequestId(context);
        bytes memory message = _depositMessage(requestId);
        precompile.setFailSend(true);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.XcmDispatchFailed.selector);

        IXcmWrapper.RequestRecord memory record = wrapper.getRequest(requestId);
        assertEq(record.context.account, address(0));
        require(wrapper.requestDestinationHash(requestId) == bytes32(0), "DEST_HASH_SHOULD_ROLL_BACK");
        require(wrapper.requestMessageHash(requestId) == bytes32(0), "MESSAGE_HASH_SHOULD_ROLL_BACK");
    }

    function testQueueRequestRejectsMissingPrecompileBeforeRecording() public {
        XcmWrapper badWrapper = new XcmWrapper(policy, address(0xA11CE));
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes32 requestId = badWrapper.previewRequestId(context);
        bytes memory message = _depositMessage(requestId);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(badWrapper)
            .call(
                abi.encodeCall(
                    badWrapper.queueRequest,
                    (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.XcmPrecompileUnavailable.selector);

        IXcmWrapper.RequestRecord memory record = badWrapper.getRequest(requestId);
        assertEq(record.context.account, address(0));
        require(badWrapper.requestDestinationHash(requestId) == bytes32(0), "DEST_HASH_SHOULD_NOT_BE_RECORDED");
        require(badWrapper.requestMessageHash(requestId) == bytes32(0), "MESSAGE_HASH_SHOULD_NOT_BE_RECORDED");
    }

    function testQueueRequestRejectsPayloadMismatchForSameContext() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes32 requestId = wrapper.previewRequestId(context);

        vm.prank(operator);
        wrapper.queueRequest(
            context, hex"0102", _depositMessage(requestId), IXcmWrapper.Weight({refTime: 1, proofSize: 2})
        );
        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (
                        context,
                        hex"0102",
                        _depositMessageWithFee(requestId, 2),
                        IXcmWrapper.Weight({refTime: 1, proofSize: 2})
                    )
                )
            );
        _assertCustomError(ok, data, XcmWrapper.PayloadMismatch.selector);
    }

    function testQueueRequestRejectsBeneficiaryContextMismatch() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _message(wrapper.previewRequestId(context), ASSET, address(0x9999), 25 ether, 1);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.XcmContextMismatch.selector);
    }

    function testQueueRequestRejectsWithdrawAssetContextMismatch() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _message(wrapper.previewRequestId(context), address(0x9999), RECIPIENT, 25 ether, 1);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.XcmContextMismatch.selector);
    }

    function testQueueRequestRejectsNonCanonicalDepositFilter() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _messageWithFilter(
            wrapper.previewRequestId(context), address(0), RECIPIENT, 25 ether, 1, hex"010101000000"
        );

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.XcmContextMismatch.selector);
    }

    function testQueueRequestRejectsWithdrawAmountContextMismatch() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _message(wrapper.previewRequestId(context), ASSET, RECIPIENT, 24 ether, 1);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.XcmContextMismatch.selector);
    }

    function testQueueRequestRejectsMissingSetTopic() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (context, hex"0102", hex"aabbccdd", IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidSetTopic.selector);
    }

    function testQueueRequestRejectsSetTopicForDifferentRequest() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        IXcmWrapper.RequestContext memory otherContext = _context(25 ether, 0, 2);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (
                        context,
                        hex"0102",
                        _depositMessage(wrapper.previewRequestId(otherContext)),
                        IXcmWrapper.Weight({refTime: 1, proofSize: 2})
                    )
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidSetTopic.selector);
    }

    function testQueueRequestRejectsNonV5EnvelopeWithTopicSuffix() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes32 requestId = wrapper.previewRequestId(context);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (
                        context,
                        hex"0102",
                        abi.encodePacked(hex"9900", bytes1(0x2c), requestId),
                        IXcmWrapper.Weight({refTime: 1, proofSize: 2})
                    )
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidSetTopic.selector);
    }

    function testQueueRequestRejectsEmptyInstructionVectorWithTopicSuffix() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes32 requestId = wrapper.previewRequestId(context);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (
                        context,
                        hex"0102",
                        abi.encodePacked(hex"0500", bytes1(0x2c), requestId),
                        IXcmWrapper.Weight({refTime: 1, proofSize: 2})
                    )
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidSetTopic.selector);
    }

    function testQueueRequestRejectsSetTopicOutsideDeclaredInstructionVector() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes32 requestId = wrapper.previewRequestId(context);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest,
                    (
                        context,
                        hex"0102",
                        abi.encodePacked(hex"0504", bytes1(0x00), bytes1(0x2c), requestId),
                        IXcmWrapper.Weight({refTime: 1, proofSize: 2})
                    )
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidSetTopic.selector);
    }

    function testQueueRequestRejectsZeroRefTimeWeight() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 0, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidWeight.selector);
    }

    function testFinalizeRequestStoresTerminalOutcome() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        vm.prank(operator);
        wrapper.finalizeRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 25 ether, 23 ether, keccak256("remote-ref"), bytes32(0)
        );

        IXcmWrapper.RequestRecord memory record = wrapper.getRequest(requestId);
        assertEq(uint256(record.status), uint256(IXcmWrapper.RequestStatus.Succeeded));
        assertEq(record.queuedBy, operator);
        assertEq(record.settledAssets, 25 ether);
        assertEq(record.settledShares, 23 ether);
        require(record.remoteRef == keccak256("remote-ref"), "WRONG_REMOTE_REF");
    }

    function testOnlyQueueingOperatorOrOwnerCanFinalize() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        vm.prank(operator2);
        (bool operatorOk, bytes memory operatorData) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.finalizeRequest,
                    (
                        requestId,
                        IXcmWrapper.RequestStatus.Succeeded,
                        25 ether,
                        23 ether,
                        keccak256("remote-ref"),
                        bytes32(0)
                    )
                )
            );
        _assertCustomError(operatorOk, operatorData, XcmWrapper.Unauthorized.selector);

        wrapper.finalizeRequest(
            requestId, IXcmWrapper.RequestStatus.Succeeded, 25 ether, 23 ether, keccak256("remote-ref"), bytes32(0)
        );
    }

    function testFinalizeRejectsDepositAssetOverSettlement() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.finalizeRequest,
                    (
                        requestId,
                        IXcmWrapper.RequestStatus.Succeeded,
                        26 ether,
                        26 ether,
                        keccak256("remote-ref"),
                        bytes32(0)
                    )
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidSettlement.selector);
    }

    function testFinalizeRejectsWithdrawShareOverSettlement() public {
        IXcmWrapper.RequestContext memory context = _withdrawContext(10 ether, 1);
        bytes memory message = _withdrawMessage(wrapper.previewRequestId(context));

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.finalizeRequest,
                    (requestId, IXcmWrapper.RequestStatus.Succeeded, 0, 11 ether, keccak256("remote-ref"), bytes32(0))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.InvalidSettlement.selector);
    }

    function testFinalizeIsIdempotentForRepeatedSameSettlement() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        vm.startPrank(operator);
        wrapper.finalizeRequest(requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32(0), bytes32("XCM_FAIL"));
        wrapper.finalizeRequest(requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32(0), bytes32("XCM_FAIL"));
        vm.stopPrank();

        IXcmWrapper.RequestRecord memory record = wrapper.getRequest(requestId);
        assertEq(uint256(record.status), uint256(IXcmWrapper.RequestStatus.Failed));
        require(record.failureCode == bytes32("XCM_FAIL"), "WRONG_FAILURE_CODE");
    }

    function testOnlyOwnerOrOperatorCanQueueOrFinalize() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.prank(stranger);
        (bool queueOk, bytes memory queueData) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(queueOk, queueData, XcmWrapper.Unauthorized.selector);

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        vm.prank(stranger);
        (bool finalizeOk, bytes memory finalizeData) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.finalizeRequest,
                    (
                        requestId,
                        IXcmWrapper.RequestStatus.Succeeded,
                        25 ether,
                        23 ether,
                        keccak256("remote-ref"),
                        bytes32(0)
                    )
                )
            );
        _assertCustomError(finalizeOk, finalizeData, XcmWrapper.Unauthorized.selector);
    }

    function testPauseBlocksQueueAndSuccessfulFinalizeButAllowsFailureFinalize() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));

        vm.prank(operator);
        bytes32 requestId =
            wrapper.queueRequest(context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}));

        policy.setPaused(true);

        vm.prank(operator);
        (bool queueOk, bytes memory queueData) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(queueOk, queueData, XcmWrapper.ProtocolPaused.selector);

        vm.prank(operator);
        (bool successOk, bytes memory successData) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.finalizeRequest,
                    (
                        requestId,
                        IXcmWrapper.RequestStatus.Succeeded,
                        25 ether,
                        23 ether,
                        keccak256("remote-ref"),
                        bytes32(0)
                    )
                )
            );
        _assertCustomError(successOk, successData, XcmWrapper.ProtocolPaused.selector);

        vm.prank(operator);
        wrapper.finalizeRequest(requestId, IXcmWrapper.RequestStatus.Failed, 0, 0, bytes32(0), bytes32("XCM_FAIL"));

        IXcmWrapper.RequestRecord memory record = wrapper.getRequest(requestId);
        assertEq(uint256(record.status), uint256(IXcmWrapper.RequestStatus.Failed));
    }

    function testWeighMessageUsesConfiguredPrecompile() public view {
        IXcmWrapper.Weight memory weight = wrapper.weighMessage(hex"aabbcc");
        assertEq(weight.refTime, 30);
        assertEq(weight.proofSize, 3);
    }

    function testWeighMessageReturnsZeroForMalformedPrecompileQuote() public {
        XcmWrapper badWrapper = new XcmWrapper(policy, address(new MockMalformedXcmPrecompile()));

        IXcmWrapper.Weight memory weight = badWrapper.weighMessage(hex"aabbcc");

        assertEq(weight.refTime, 0);
        assertEq(weight.proofSize, 0);
    }

    function _context(uint256 assets, uint256 shares, uint64 nonce)
        internal
        view
        returns (IXcmWrapper.RequestContext memory)
    {
        return IXcmWrapper.RequestContext({
            strategyId: STRATEGY_ID,
            kind: IXcmWrapper.RequestKind.Deposit,
            account: operator,
            asset: ASSET,
            recipient: RECIPIENT,
            assets: assets,
            shares: shares,
            nonce: nonce
        });
    }

    function _withdrawContext(uint256 shares, uint64 nonce) internal view returns (IXcmWrapper.RequestContext memory) {
        return IXcmWrapper.RequestContext({
            strategyId: STRATEGY_ID,
            kind: IXcmWrapper.RequestKind.Withdraw,
            account: operator,
            asset: ASSET,
            recipient: RECIPIENT,
            assets: 0,
            shares: shares,
            nonce: nonce
        });
    }

    function _depositMessage(bytes32 requestId) internal pure returns (bytes memory) {
        return _message(requestId, address(0), RECIPIENT, 25 ether, 1);
    }

    function _depositMessageWithFee(bytes32 requestId, uint256 feeAmount) internal pure returns (bytes memory) {
        return _message(requestId, address(0), RECIPIENT, 25 ether, feeAmount);
    }

    function _withdrawMessage(bytes32 requestId) internal pure returns (bytes memory) {
        return _message(requestId, address(0), RECIPIENT, 10 ether, 1);
    }

    function _message(bytes32 requestId, address asset, address recipient, uint256 amount, uint256 feeAmount)
        internal
        pure
        returns (bytes memory)
    {
        return _messageWithFilter(requestId, asset, recipient, amount, feeAmount, hex"010204");
    }

    function _messageWithFilter(
        bytes32 requestId,
        address asset,
        address recipient,
        uint256 amount,
        uint256 feeAmount,
        bytes memory assetFilter
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"05",
            _compact(4),
            bytes1(0x00),
            _compact(1),
            _asset(asset, amount),
            bytes1(0x13),
            _asset(asset, feeAmount),
            bytes1(0x0d),
            assetFilter,
            _accountKey20Location(recipient),
            bytes1(0x2c),
            requestId
        );
    }

    function _backendDepositFixture(bytes32 requestId) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"0510000401000002286bee1301000002286bee0d0102040001030012345678901234567890123456789012345678902c",
            requestId
        );
    }

    function _backendWithdrawFixture(bytes32 requestId) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"0510000401000003009435771301000002286bee0d01020400010300abcdefabcdefabcdefabcdefabcdefabcdefabcd2c",
            requestId
        );
    }

    function _asset(address asset, uint256 amount) internal pure returns (bytes memory) {
        bytes memory location = asset == address(0) ? _nativeRelayAssetLocation() : _accountKey20Location(asset);
        return abi.encodePacked(location, bytes1(0x00), _compact(amount));
    }

    function _nativeRelayAssetLocation() internal pure returns (bytes memory) {
        return hex"0100";
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
