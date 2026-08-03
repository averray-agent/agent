// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {IXcmWrapper} from "./interfaces/IXcmWrapper.sol";
import {IXcmStrategyAdapter} from "./interfaces/IXcmStrategyAdapter.sol";
import {IXcmV2CustodyAdapter} from "./interfaces/IXcmV2CustodyAdapter.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";

interface IXcmPrecompileV2 {
    function execute(bytes calldata message, IXcmWrapper.Weight calldata maxWeight) external;
    function send(bytes calldata destination, bytes calldata message) external;
    function weighMessage(bytes calldata message) external view returns (IXcmWrapper.Weight memory);
}

/**
 * @title XcmWrapperV2
 * @notice Two-leg, request-scoped transport for the Hydration USDC supply lane.
 *
 * This is intentionally not a generic XCM executor. A request may dispatch only
 * the four request message grammars: fund, supply, redeem, and return home.
 * A fifth owner-only recovery-home grammar can return otherwise stranded
 * Hydration asset-22 to this wrapper's fixed Asset-Hub image while locally
 * paused; it cannot redirect funds to an arbitrary beneficiary.
 */
contract XcmWrapperV2 is IXcmWrapper, ReentrancyGuard {
    using SafeTransfer for address;

    enum DispatchLeg {
        DepositFunding,
        DepositSell,
        WithdrawSell,
        WithdrawHome
    }

    struct LegRecord {
        bytes32 destinationHash;
        bytes32 messageHash;
        uint64 refTime;
        uint64 proofSize;
        bool dispatched;
    }

    struct DispatchPlan {
        bytes32 requestId;
        address adapter;
        DispatchLeg leg;
        bool newRequest;
        bytes32 destinationHash;
        bytes32 messageHash;
    }

    address public constant DEFAULT_XCM_PRECOMPILE = 0x00000000000000000000000000000000000a0000;
    bytes internal constant LOCAL_HERE_DESTINATION = hex"050000";
    bytes internal constant HYDRATION_DESTINATION = hex"05010100c91f";
    bytes32 internal constant RECOVERY_HOME_DOMAIN = bytes32("HYDRATION_USDC_RECOVERY_V1");

    TreasuryPolicy public immutable policy;
    address public immutable override xcmPrecompile;

    address public operator;
    bytes32 public hydrationAccountId32;
    bool public dispatchPaused = true;

    mapping(bytes32 => address) public strategyAdapter;
    mapping(bytes32 => RequestRecord) internal requests;
    mapping(bytes32 => bytes32) public requestDestinationHash;
    mapping(bytes32 => bytes32) public requestMessageHash;
    mapping(bytes32 => address) public requestOperator;
    mapping(bytes32 => address) public requestAdapter;
    mapping(bytes32 => uint8) public requestDispatchBitmap;
    mapping(bytes32 => uint256) public requestRecoveryReleased;
    mapping(bytes32 => mapping(uint8 => LegRecord)) internal requestLegs;
    mapping(bytes32 => LegRecord) internal recoveryHomeLegs;

    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event StrategyAdapterUpdated(
        bytes32 indexed strategyId, address indexed previousAdapter, address indexed newAdapter
    );
    event HydrationAccountUpdated(bytes32 indexed previousAccount, bytes32 indexed newAccount);
    event DispatchPauseUpdated(bool paused);
    event RequestLegDispatched(
        bytes32 indexed requestId,
        DispatchLeg indexed leg,
        address indexed caller,
        bytes32 destinationHash,
        bytes32 messageHash
    );
    event RecoveredAssetsReleased(bytes32 indexed requestId, address indexed adapter, uint256 assets);
    event RecoveryHomeDispatched(
        bytes32 indexed recoveryId, uint256 amount, uint64 nonce, bytes32 destinationHash, bytes32 messageHash
    );

    error Unauthorized();
    error ProtocolPaused();
    error UnknownRequest();
    error InvalidRequest();
    error InvalidStatus();
    error InvalidTransition();
    error InvalidSettlement();
    error InvalidWeight();
    error InvalidConfiguration();
    error PayloadMismatch();
    error XcmContextMismatch();
    error XcmPrecompileUnavailable();
    error XcmDispatchFailed(bytes reason);
    error CustodyMismatch();

    constructor(TreasuryPolicy policy_, address xcmPrecompile_) {
        if (address(policy_) == address(0)) revert InvalidConfiguration();
        policy = policy_;
        xcmPrecompile = xcmPrecompile_ == address(0) ? DEFAULT_XCM_PRECOMPILE : xcmPrecompile_;
    }

    modifier onlyOwner() {
        if (msg.sender != policy.owner()) revert Unauthorized();
        _;
    }

    modifier whenDispatchOpen() {
        if (policy.paused() || dispatchPaused) revert ProtocolPaused();
        _;
    }

    function setOperator(address newOperator) external onlyOwner {
        if (!dispatchPaused) revert InvalidConfiguration();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function setStrategyAdapter(bytes32 strategyId, address adapter) external onlyOwner {
        if (!dispatchPaused || strategyId == bytes32(0)) revert InvalidConfiguration();
        emit StrategyAdapterUpdated(strategyId, strategyAdapter[strategyId], adapter);
        strategyAdapter[strategyId] = adapter;
    }

    function setHydrationAccountId32(bytes32 accountId32) external onlyOwner {
        if (!dispatchPaused) revert InvalidConfiguration();
        emit HydrationAccountUpdated(hydrationAccountId32, accountId32);
        hydrationAccountId32 = accountId32;
    }

    function setDispatchPaused(bool paused_) external {
        if (msg.sender != policy.owner()) {
            if (msg.sender != policy.pauser() || !paused_) revert Unauthorized();
        }
        if (!paused_ && (operator == address(0) || hydrationAccountId32 == bytes32(0))) {
            revert InvalidConfiguration();
        }
        dispatchPaused = paused_;
        emit DispatchPauseUpdated(paused_);
    }

    function previewRequestId(RequestContext calldata context) public pure override returns (bytes32 requestId) {
        return keccak256(
            abi.encode(
                context.strategyId,
                context.kind,
                context.account,
                context.asset,
                context.recipient,
                context.assets,
                context.shares,
                context.nonce
            )
        );
    }

    function weighMessage(bytes calldata message) external view override returns (Weight memory weight) {
        (bool ok, Weight memory quoted) = _tryWeighMessage(message);
        return ok ? quoted : Weight({refTime: 0, proofSize: 0});
    }

    function queueRequest(
        RequestContext calldata context,
        bytes calldata destination,
        bytes calldata message,
        Weight calldata maxWeight
    ) external override nonReentrant whenDispatchOpen returns (bytes32 requestId) {
        _validateContext(context);
        if (maxWeight.refTime == 0) revert InvalidWeight();

        DispatchPlan memory plan;
        plan.requestId = previewRequestId(context);
        plan.adapter = strategyAdapter[context.strategyId];
        if (plan.adapter == address(0)) revert InvalidConfiguration();

        RequestRecord storage record = requests[plan.requestId];
        plan.newRequest = record.context.account == address(0);
        bool firstLeg = plan.newRequest || msg.sender == plan.adapter;
        plan.leg = _expectedLeg(context.kind, firstLeg);
        _authorizeDispatch(firstLeg, plan.adapter, plan.requestId, context);
        _validatePayload(plan.leg, context, destination, message, plan.requestId);

        uint8 legIndex = uint8(plan.leg);
        LegRecord storage prior = requestLegs[plan.requestId][legIndex];
        plan.destinationHash = keccak256(destination);
        plan.messageHash = keccak256(message);
        if (prior.dispatched) {
            if (prior.destinationHash != plan.destinationHash || prior.messageHash != plan.messageHash) {
                revert PayloadMismatch();
            }
            return plan.requestId;
        }

        if (!firstLeg) {
            if (record.status != RequestStatus.Pending || requestAdapter[plan.requestId] != plan.adapter) {
                revert InvalidTransition();
            }
            if (requestOperator[plan.requestId] != msg.sender) revert Unauthorized();
        }

        if (plan.newRequest) {
            requests[plan.requestId] = RequestRecord({
                context: RequestContext({
                    strategyId: context.strategyId,
                    kind: context.kind,
                    account: context.account,
                    asset: context.asset,
                    recipient: context.recipient,
                    assets: context.assets,
                    shares: context.shares,
                    nonce: context.nonce
                }),
                queuedBy: plan.adapter,
                status: RequestStatus.Pending,
                settledAssets: 0,
                settledShares: 0,
                remoteRef: bytes32(0),
                failureCode: bytes32(0),
                createdAt: uint64(block.timestamp),
                updatedAt: uint64(block.timestamp)
            });
            requestOperator[plan.requestId] = operator;
            requestAdapter[plan.requestId] = plan.adapter;
            requestDestinationHash[plan.requestId] = plan.destinationHash;
            requestMessageHash[plan.requestId] = plan.messageHash;
        }

        if (plan.leg == DispatchLeg.DepositFunding) {
            // `execute` runs this message in the Asset-Hub runtime, so the
            // local precompile must be able to weigh it before custody moves.
            // Remote `send` messages contain Hydration pallet indices and are
            // intentionally not locally weighable on Asset Hub.
            _requireWeighable(message);
            uint256 beforeBalance = _balanceOf(context.asset, address(this));
            IXcmV2CustodyAdapter(plan.adapter).releaseAssetsToWrapper(plan.requestId, context.assets);
            if (_balanceOf(context.asset, address(this)) - beforeBalance != context.assets) revert CustodyMismatch();
            _executeXcm(message, maxWeight);
        } else {
            _sendXcm(destination, message);
        }

        prior.destinationHash = plan.destinationHash;
        prior.messageHash = plan.messageHash;
        prior.refTime = maxWeight.refTime;
        prior.proofSize = maxWeight.proofSize;
        prior.dispatched = true;
        requestDispatchBitmap[plan.requestId] |= uint8(1) << legIndex;

        if (plan.newRequest) {
            emit RequestQueued(
                plan.requestId,
                context.strategyId,
                context.kind,
                context.account,
                context.asset,
                context.recipient,
                context.assets,
                context.shares,
                context.nonce
            );
        }
        emit RequestPayloadStored(
            plan.requestId, plan.destinationHash, plan.messageHash, maxWeight.refTime, maxWeight.proofSize
        );
        emit RequestDispatched(plan.requestId, xcmPrecompile, plan.destinationHash, plan.messageHash);
        emit RequestLegDispatched(plan.requestId, plan.leg, msg.sender, plan.destinationHash, plan.messageHash);
        return plan.requestId;
    }

    function finalizeRequest(
        bytes32 requestId,
        RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external override nonReentrant {
        if (status == RequestStatus.Unknown || status == RequestStatus.Pending) {
            revert InvalidStatus();
        }
        RequestRecord storage record = requests[requestId];
        if (record.context.account == address(0)) revert UnknownRequest();
        if (msg.sender != requestAdapter[requestId] && msg.sender != policy.owner()) revert Unauthorized();
        if ((policy.paused() || dispatchPaused) && status == RequestStatus.Succeeded) revert ProtocolPaused();

        if (record.status != RequestStatus.Pending) {
            if (
                record.status == status && record.settledAssets == settledAssets
                    && record.settledShares == settledShares && record.remoteRef == remoteRef
                    && record.failureCode == failureCode
            ) return;
            revert InvalidTransition();
        }

        if (
            status == RequestStatus.Succeeded
                && !_bothLegsDispatched(record.context.kind, requestDispatchBitmap[requestId])
        ) {
            revert InvalidTransition();
        }
        _validateSettlementBounds(record.context, status, settledAssets, settledShares);

        if (status == RequestStatus.Succeeded && record.context.kind == RequestKind.Withdraw) {
            if (_balanceOf(record.context.asset, address(this)) < settledAssets) revert CustodyMismatch();
            record.context.asset.safeTransfer(requestAdapter[requestId], settledAssets);
        }

        record.status = status;
        record.settledAssets = settledAssets;
        record.settledShares = settledShares;
        record.remoteRef = remoteRef;
        record.failureCode = failureCode;
        record.updatedAt = uint64(block.timestamp);
        emit RequestStatusUpdated(requestId, status, settledAssets, settledShares, remoteRef, failureCode);
    }

    function getRequest(bytes32 requestId) external view override returns (RequestRecord memory) {
        return requests[requestId];
    }

    function getRequestLeg(bytes32 requestId, DispatchLeg leg) external view returns (LegRecord memory) {
        return requestLegs[requestId][uint8(leg)];
    }

    /**
     * @notice Derive the topic/id for an owner-operated recovery-home message.
     * @dev The destination account is not an input: strict payload decoding
     *      always binds the beneficiary to this wrapper's Asset-Hub image.
     */
    function previewRecoveryHomeId(uint256 amount, uint64 nonce) public view returns (bytes32 recoveryId) {
        return keccak256(abi.encode(RECOVERY_HOME_DOMAIN, address(this), hydrationAccountId32, amount, nonce));
    }

    /**
     * @notice Send one strictly encoded reserve-withdraw message that returns
     *         Hydration asset-22 to this wrapper's fixed Asset-Hub image.
     * @dev Recovery is deliberately owner-only and available only while local
     *      dispatch is paused. `_sendXcm` is the liveness/atomicity boundary;
     *      the remote Hydration message must not be weighed by Asset Hub.
     */
    function dispatchRecoveryHome(uint256 amount, uint64 nonce, bytes calldata destination, bytes calldata message)
        external
        onlyOwner
        nonReentrant
        returns (bytes32 recoveryId)
    {
        if (!dispatchPaused) revert InvalidStatus();
        if (amount == 0 || nonce == 0 || hydrationAccountId32 == bytes32(0)) revert InvalidRequest();
        if (keccak256(destination) != keccak256(HYDRATION_DESTINATION)) revert XcmContextMismatch();

        recoveryId = previewRecoveryHomeId(amount, nonce);
        uint256 nestedFee = _decodeHomeParameters(message, amount, recoveryId);
        if (nestedFee == 0 || nestedFee > amount) revert XcmContextMismatch();

        LegRecord storage prior = recoveryHomeLegs[recoveryId];
        bytes32 destinationHash = keccak256(destination);
        bytes32 messageHash = keccak256(message);
        if (prior.dispatched) {
            if (prior.destinationHash != destinationHash || prior.messageHash != messageHash) {
                revert PayloadMismatch();
            }
            return recoveryId;
        }

        _sendXcm(destination, message);
        prior.destinationHash = destinationHash;
        prior.messageHash = messageHash;
        prior.dispatched = true;
        emit RecoveryHomeDispatched(recoveryId, amount, nonce, destinationHash, messageHash);
    }

    function getRecoveryHomeLeg(bytes32 recoveryId) external view returns (LegRecord memory) {
        return recoveryHomeLegs[recoveryId];
    }

    /**
     * @notice Move assets returned by an owner-operated recovery XCM back to
     * the request's adapter. The recipient and token are request-bound.
     */
    function releaseRecoveredAssetsToAdapter(bytes32 requestId, uint256 assets) external onlyOwner nonReentrant {
        RequestRecord storage record = requests[requestId];
        if (record.context.account == address(0)) revert UnknownRequest();
        uint256 recoveryCap = record.context.kind == RequestKind.Deposit
            ? record.context.assets
            : record.context.kind == RequestKind.Withdraw ? record.context.shares : 0;
        if (
            !dispatchPaused || (record.status != RequestStatus.Failed && record.status != RequestStatus.Cancelled)
                || assets == 0 || requestRecoveryReleased[requestId] + assets > recoveryCap
        ) revert InvalidStatus();
        address adapter = requestAdapter[requestId];
        if (_balanceOf(record.context.asset, address(this)) < assets) revert CustodyMismatch();
        requestRecoveryReleased[requestId] += assets;
        record.context.asset.safeTransfer(adapter, assets);
        emit RecoveredAssetsReleased(requestId, adapter, assets);
    }

    function _validateSettlementBounds(
        RequestContext memory context,
        RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares
    ) internal pure {
        if (status != RequestStatus.Succeeded) {
            if (settledAssets != 0 || settledShares != 0) revert InvalidSettlement();
            return;
        }

        if (context.kind == RequestKind.Deposit) {
            if (settledAssets > context.assets) revert InvalidSettlement();
            return;
        }

        if (context.kind == RequestKind.Withdraw) {
            if (settledShares > context.shares || settledAssets > context.shares) revert InvalidSettlement();
            return;
        }

        if (context.assets != 0 && settledAssets > context.assets) revert InvalidSettlement();
        if (context.shares != 0 && settledShares > context.shares) revert InvalidSettlement();
    }

    function _validateContext(RequestContext calldata context) internal pure {
        if (
            context.strategyId == bytes32(0) || context.account == address(0) || context.asset == address(0)
                || context.recipient == address(0) || (context.assets == 0 && context.shares == 0)
        ) revert InvalidRequest();
        if (context.kind == RequestKind.Deposit && context.assets == 0) revert InvalidRequest();
        if (context.kind == RequestKind.Withdraw && context.shares == 0) revert InvalidRequest();
        if (context.kind == RequestKind.Claim) revert InvalidRequest();
    }

    function _expectedLeg(RequestKind kind, bool first) internal pure returns (DispatchLeg) {
        if (kind == RequestKind.Deposit) return first ? DispatchLeg.DepositFunding : DispatchLeg.DepositSell;
        if (kind == RequestKind.Withdraw) return first ? DispatchLeg.WithdrawSell : DispatchLeg.WithdrawHome;
        revert InvalidRequest();
    }

    function _authorizeDispatch(bool first, address adapter, bytes32 requestId, RequestContext calldata context)
        internal
        view
    {
        if (first) {
            if (msg.sender != adapter && msg.sender != policy.owner()) revert Unauthorized();
            IXcmStrategyAdapter.AdapterRequest memory staged = IXcmStrategyAdapter(adapter).getAdapterRequest(requestId);
            if (
                staged.account != context.account || staged.recipient != context.recipient
                    || staged.kind != context.kind || staged.status != RequestStatus.Pending || staged.settled
            ) revert XcmContextMismatch();
            if (context.kind == RequestKind.Deposit && staged.requestedAssets != context.assets) {
                revert XcmContextMismatch();
            }
            if (context.kind == RequestKind.Withdraw && staged.requestedShares != context.shares) {
                revert XcmContextMismatch();
            }
            return;
        }
        if (msg.sender != requestOperator[requestId]) revert Unauthorized();
    }

    function _validatePayload(
        DispatchLeg leg,
        RequestContext calldata context,
        bytes calldata destination,
        bytes calldata message,
        bytes32 requestId
    ) internal view {
        if (leg == DispatchLeg.DepositFunding) {
            if (keccak256(destination) != keccak256(LOCAL_HERE_DESTINATION)) revert XcmContextMismatch();
            if (keccak256(message) != keccak256(_buildDepositFunding(context.assets, requestId))) {
                revert XcmContextMismatch();
            }
            return;
        }
        if (keccak256(destination) != keccak256(HYDRATION_DESTINATION)) revert XcmContextMismatch();

        if (leg == DispatchLeg.DepositSell) {
            (uint256 feeAmount, uint256 actionAmount) = _decodeSellParameters(message, false, requestId);
            if (
                feeAmount == 0 || actionAmount == 0 || feeAmount > context.assets || actionAmount > context.assets
                    || feeAmount + actionAmount > context.assets
            ) {
                revert XcmContextMismatch();
            }
            return;
        }
        if (leg == DispatchLeg.WithdrawSell) {
            (uint256 feeAmount, uint256 actionAmount) = _decodeSellParameters(message, true, requestId);
            if (feeAmount == 0 || actionAmount != context.shares) revert XcmContextMismatch();
            return;
        }

        uint256 nestedFee = _decodeHomeParameters(message, context.shares, requestId);
        if (nestedFee == 0 || nestedFee > context.shares) revert XcmContextMismatch();
    }

    function _decodeSellParameters(bytes calldata message, bool withdraw, bytes32 requestId)
        internal
        view
        returns (uint256 feeAmount, uint256 actionAmount)
    {
        uint256 cursor = _expect(message, 0, hex"05180004010300a10f043205e51400");
        (feeAmount, cursor) = _decodeCompact(message, cursor);
        cursor = _expect(message, cursor, hex"13010300a10f043205e51400");
        (uint256 repeatedFee, uint256 next) = _decodeCompact(message, cursor);
        if (repeatedFee != feeAmount) revert XcmContextMismatch();
        cursor = _expect(message, next, hex"000601010700c817a80482841e00d04300");
        if (withdraw) {
            cursor = _expect(message, cursor, hex"eb03000016000000");
        } else {
            cursor = _expect(message, cursor, hex"16000000eb030000");
        }
        (actionAmount, cursor) = _decodeLeU128(message, cursor);
        cursor = _expect(message, cursor, new bytes(16));
        if (withdraw) {
            cursor = _expect(message, cursor, hex"0404eb03000016000000140d01020400010100");
        } else {
            cursor = _expect(message, cursor, hex"040416000000eb030000140d01020400010100");
        }
        cursor = _expectBytes32(message, cursor, hydrationAccountId32);
        cursor = _expect(message, cursor, hex"2c");
        cursor = _expectBytes32(message, cursor, requestId);
        if (cursor != message.length) revert XcmContextMismatch();
    }

    function _decodeHomeParameters(bytes calldata message, uint256 amount, bytes32 requestId)
        internal
        view
        returns (uint256 nestedFee)
    {
        uint256 cursor = _expect(message, 0, hex"05140004010300a10f043205e51400");
        (uint256 outerAmount, uint256 next) = _decodeCompact(message, cursor);
        if (outerAmount != amount) revert XcmContextMismatch();
        cursor = _expect(message, next, hex"13010300a10f043205e51400");
        (uint256 repeatedAmount, uint256 afterAmount) = _decodeCompact(message, cursor);
        if (repeatedAmount != amount) revert XcmContextMismatch();
        cursor = _expect(message, afterAmount, hex"001410010204010100a10f08130002043205e51400");
        (nestedFee, cursor) = _decodeCompact(message, cursor);
        cursor = _expect(message, cursor, hex"000d01020400010100");
        cursor = _expectBytes32(message, cursor, _wrapperAccountId32());
        cursor = _expect(message, cursor, hex"2c");
        cursor = _expectBytes32(message, cursor, requestId);
        if (cursor != message.length) revert XcmContextMismatch();
    }

    function _buildDepositFunding(uint256 amount, bytes32 requestId) internal view returns (bytes memory) {
        bytes memory encodedAmount = _compact(amount);
        return abi.encodePacked(
            hex"051000040002043205e51400",
            encodedAmount,
            hex"2b010e00040002043205e51400",
            encodedAmount,
            hex"010100c91f0813010300a10f043205e51400",
            encodedAmount,
            hex"000d01020400010100",
            hydrationAccountId32,
            hex"2c",
            requestId
        );
    }

    function _wrapperAccountId32() internal view returns (bytes32 result) {
        result = bytes32(bytes20(address(this))) | bytes32(uint256(0xeeeeeeeeeeeeeeeeeeeeeeee));
    }

    function _bothLegsDispatched(RequestKind kind, uint8 bitmap) internal pure returns (bool) {
        if (kind == RequestKind.Deposit) return (bitmap & 0x03) == 0x03;
        if (kind == RequestKind.Withdraw) return (bitmap & 0x0c) == 0x0c;
        return false;
    }

    function _executeXcm(bytes calldata message, Weight calldata maxWeight) internal {
        (bool ok, bytes memory data) =
            xcmPrecompile.call(abi.encodeCall(IXcmPrecompileV2.execute, (message, maxWeight)));
        if (!ok) revert XcmDispatchFailed(data);
    }

    function _sendXcm(bytes calldata destination, bytes calldata message) internal {
        (bool ok, bytes memory data) = xcmPrecompile.call(abi.encodeCall(IXcmPrecompileV2.send, (destination, message)));
        if (!ok) revert XcmDispatchFailed(data);
    }

    function _requireWeighable(bytes calldata message) internal view {
        (bool ok, Weight memory quoted) = _tryWeighMessage(message);
        if (!ok || quoted.refTime == 0) revert XcmPrecompileUnavailable();
    }

    function _tryWeighMessage(bytes calldata message) internal view returns (bool ok, Weight memory weight) {
        (bool callOk, bytes memory data) =
            xcmPrecompile.staticcall(abi.encodeCall(IXcmPrecompileV2.weighMessage, (message)));
        if (!callOk || data.length < 64) return (false, Weight({refTime: 0, proofSize: 0}));
        uint256 refTime;
        uint256 proofSize;
        assembly {
            refTime := mload(add(data, 32))
            proofSize := mload(add(data, 64))
        }
        if (refTime > type(uint64).max || proofSize > type(uint64).max) {
            return (false, Weight({refTime: 0, proofSize: 0}));
        }
        return (true, Weight({refTime: uint64(refTime), proofSize: uint64(proofSize)}));
    }

    function _balanceOf(address token, address account) internal view returns (uint256 balance) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || data.length != 32) revert CustodyMismatch();
        balance = abi.decode(data, (uint256));
    }

    function _expect(bytes calldata data, uint256 cursor, bytes memory expected) internal pure returns (uint256) {
        if (cursor + expected.length > data.length) revert XcmContextMismatch();
        for (uint256 i = 0; i < expected.length; i++) {
            if (data[cursor + i] != expected[i]) revert XcmContextMismatch();
        }
        return cursor + expected.length;
    }

    function _expectBytes32(bytes calldata data, uint256 cursor, bytes32 expected) internal pure returns (uint256) {
        if (cursor + 32 > data.length) revert XcmContextMismatch();
        bytes32 actual;
        assembly {
            actual := calldataload(add(data.offset, cursor))
        }
        if (actual != expected) revert XcmContextMismatch();
        return cursor + 32;
    }

    function _decodeLeU128(bytes calldata data, uint256 cursor) internal pure returns (uint256 value, uint256 next) {
        if (cursor + 16 > data.length) revert XcmContextMismatch();
        for (uint256 i = 0; i < 16; i++) {
            value |= uint256(uint8(data[cursor + i])) << (8 * i);
        }
        return (value, cursor + 16);
    }

    function _decodeCompact(bytes calldata data, uint256 cursor) internal pure returns (uint256 value, uint256 next) {
        if (cursor >= data.length) revert XcmContextMismatch();
        uint256 start = cursor;
        uint8 first = uint8(data[cursor]);
        uint8 mode = first & 3;
        if (mode == 0) {
            value = first >> 2;
            next = cursor + 1;
        } else if (mode == 1) {
            if (cursor + 2 > data.length) revert XcmContextMismatch();
            uint16 raw = uint16(first) | (uint16(uint8(data[cursor + 1])) << 8);
            value = raw >> 2;
            next = cursor + 2;
        } else if (mode == 2) {
            if (cursor + 4 > data.length) revert XcmContextMismatch();
            uint32 raw = uint32(first) | (uint32(uint8(data[cursor + 1])) << 8)
                | (uint32(uint8(data[cursor + 2])) << 16) | (uint32(uint8(data[cursor + 3])) << 24);
            value = raw >> 2;
            next = cursor + 4;
        } else {
            uint256 length = (first >> 2) + 4;
            if (length > 32 || cursor + 1 + length > data.length) revert XcmContextMismatch();
            for (uint256 i = 0; i < length; i++) {
                value |= uint256(uint8(data[cursor + 1 + i])) << (8 * i);
            }
            next = cursor + 1 + length;
        }

        bytes memory canonical = _compact(value);
        if (canonical.length != next - start) revert XcmContextMismatch();
        for (uint256 i = 0; i < canonical.length; i++) {
            if (data[start + i] != canonical[i]) revert XcmContextMismatch();
        }
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
        uint256 length;
        uint256 remaining = value;
        while (remaining != 0) {
            length++;
            remaining >>= 8;
        }
        if (length < 4) length = 4;
        encoded = new bytes(length + 1);
        encoded[0] = bytes1(uint8(((length - 4) << 2) | 3));
        for (uint256 i = 0; i < length; i++) {
            encoded[i + 1] = bytes1(uint8(value >> (8 * i)));
        }
    }
}
