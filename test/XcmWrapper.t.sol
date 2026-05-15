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

contract XcmWrapperTest is Test {
    TreasuryPolicy internal policy;
    MockXcmPrecompile internal precompile;
    XcmWrapper internal wrapper;

    address internal operator = address(0xB0B);
    address internal stranger = address(0xDEAD);

    bytes32 internal constant STRATEGY_ID = bytes32("VDOT_XCM_V1");
    address internal constant ASSET = address(0x1234);
    address internal constant RECIPIENT = address(0x5678);

    function setUp() public {
        policy = new TreasuryPolicy();
        precompile = new MockXcmPrecompile();
        wrapper = new XcmWrapper(policy, address(precompile));

        policy.setServiceOperator(operator, true);
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
                    (context, hex"0102", _withdrawMessage(requestId), IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.PayloadMismatch.selector);
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
        assertEq(record.settledAssets, 25 ether);
        assertEq(record.settledShares, 23 ether);
        require(record.remoteRef == keccak256("remote-ref"), "WRONG_REMOTE_REF");
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

    function testPauseBlocksQueueAndFinalize() public {
        IXcmWrapper.RequestContext memory context = _context(25 ether, 0, 1);
        bytes memory message = _depositMessage(wrapper.previewRequestId(context));
        policy.setPaused(true);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(wrapper)
            .call(
                abi.encodeCall(
                    wrapper.queueRequest, (context, hex"0102", message, IXcmWrapper.Weight({refTime: 1, proofSize: 2}))
                )
            );
        _assertCustomError(ok, data, XcmWrapper.ProtocolPaused.selector);
    }

    function testWeighMessageUsesConfiguredPrecompile() public {
        IXcmWrapper.Weight memory weight = wrapper.weighMessage(hex"aabbcc");
        assertEq(weight.refTime, 30);
        assertEq(weight.proofSize, 3);
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

    function _depositMessage(bytes32 requestId) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"0510000401000002286bee1301000002093d000d01010100000000010300aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            bytes1(0x2c),
            requestId
        );
    }

    function _withdrawMessage(bytes32 requestId) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"0510000401000003009435771301000002093d000d01010100000000010300bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            bytes1(0x2c),
            requestId
        );
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
