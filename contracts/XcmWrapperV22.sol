// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {IXcmWrapper} from "./interfaces/IXcmWrapper.sol";
import {IXcmWrapperV22} from "./interfaces/IXcmWrapperV22.sol";
import {IXcmV22CustodyAdapter} from "./interfaces/IXcmV22CustodyAdapter.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";

interface IXcmPrecompileV22 {
    function execute(bytes calldata message, IXcmWrapper.Weight calldata maxWeight) external;
    function send(bytes calldata destination, bytes calldata message) external;
    function weighMessage(bytes calldata message) external view returns (IXcmWrapper.Weight memory);
}

/**
 * @title XcmWrapperV22
 * @notice Constructive Bank transport: staging stores typed parameters and
 *         this contract alone constructs the five reviewed XCM shapes.
 */
contract XcmWrapperV22 is IXcmWrapperV22, ReentrancyGuard {
    using SafeTransfer for address;

    address public constant DEFAULT_XCM_PRECOMPILE = 0x00000000000000000000000000000000000a0000;
    bytes internal constant LOCAL_HERE_DESTINATION = hex"050000";
    bytes internal constant HYDRATION_DESTINATION = hex"05010100c91f";
    bytes32 internal constant RECOVERY_HOME_DOMAIN = bytes32("HYDRATION_USDC_RECOVERY_V22");

    TreasuryPolicy public immutable policy;
    address public immutable override xcmPrecompile;

    address public operator;
    bytes32 public hydrationAccountId32;
    bool public dispatchPaused = true;

    mapping(bytes32 => address) public strategyAdapter;
    mapping(bytes32 => IXcmWrapper.RequestRecord) internal requests;
    mapping(bytes32 => RequestParameters) internal requestParameters;
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
    event RequestQueued(
        bytes32 indexed requestId,
        bytes32 indexed strategyId,
        IXcmWrapper.RequestKind indexed kind,
        address account,
        address asset,
        address recipient,
        uint256 assets,
        uint256 shares,
        uint64 nonce
    );
    event RequestDispatched(
        bytes32 indexed requestId, address indexed xcmPrecompile, bytes32 destinationHash, bytes32 messageHash
    );
    event RequestStatusUpdated(
        bytes32 indexed requestId,
        IXcmWrapper.RequestStatus indexed status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    );
    event RecoveryHomeDispatched(
        bytes32 indexed requestId,
        bytes32 indexed recoveryId,
        uint256 amount,
        uint64 nonce,
        bytes32 destinationHash,
        bytes32 messageHash
    );
    event RecoveredAssetsReleased(bytes32 indexed requestId, address indexed adapter, uint256 assets);

    error Unauthorized();
    error ProtocolPaused();
    error UnknownRequest();
    error InvalidRequest();
    error InvalidStatus();
    error InvalidTransition();
    error InvalidSettlement();
    error InvalidConfiguration();
    error PlanMismatch();
    error FeeAboveMaximum();
    error DispatchDeadlineExpired();
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
        if (!dispatchPaused || accountId32 == bytes32(0)) revert InvalidConfiguration();
        bytes32 previous = hydrationAccountId32;
        if (previous != bytes32(0) && previous != accountId32) revert InvalidConfiguration();
        if (previous == accountId32) return;
        hydrationAccountId32 = accountId32;
        emit HydrationAccountUpdated(previous, accountId32);
    }

    function setDispatchPaused(bool paused_) external {
        if (msg.sender != policy.owner()) {
            if (msg.sender != policy.pauser() || !paused_) revert Unauthorized();
        }
        if (!paused_ && (operator == address(0) || hydrationAccountId32 == bytes32(0))) revert InvalidConfiguration();
        dispatchPaused = paused_;
        emit DispatchPauseUpdated(paused_);
    }

    function previewRequestId(IXcmWrapper.RequestContext calldata context)
        public
        pure
        override
        returns (bytes32 requestId)
    {
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

    function queueRequest(IXcmWrapper.RequestContext calldata context, RequestParameters calldata parameters)
        external
        override
        nonReentrant
        whenDispatchOpen
        returns (bytes32 requestId)
    {
        _validateContextAndParameters(context, parameters);
        address adapter = strategyAdapter[context.strategyId];
        if (adapter == address(0) || msg.sender != adapter) revert Unauthorized();

        requestId = previewRequestId(context);
        _validateAdapterRequest(adapter, requestId, context);

        IXcmWrapper.RequestRecord storage prior = requests[requestId];
        if (prior.context.account != address(0)) {
            if (!_sameContext(prior.context, context) || !_sameParameters(requestParameters[requestId], parameters)) {
                revert PlanMismatch();
            }
            return requestId;
        }

        requests[requestId] = IXcmWrapper.RequestRecord({
            context: IXcmWrapper.RequestContext({
                strategyId: context.strategyId,
                kind: context.kind,
                account: context.account,
                asset: context.asset,
                recipient: context.recipient,
                assets: context.assets,
                shares: context.shares,
                nonce: context.nonce
            }),
            queuedBy: adapter,
            status: IXcmWrapper.RequestStatus.Pending,
            settledAssets: 0,
            settledShares: 0,
            remoteRef: bytes32(0),
            failureCode: bytes32(0),
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        requestParameters[requestId] = parameters;
        requestAdapter[requestId] = adapter;

        emit RequestQueued(
            requestId,
            context.strategyId,
            context.kind,
            context.account,
            context.asset,
            context.recipient,
            context.assets,
            context.shares,
            context.nonce
        );
        emit RequestParametersStored(
            requestId,
            parameters.sellAmount,
            parameters.minimumOutput,
            parameters.maxFeePerLeg,
            parameters.dispatchDeadline
        );
    }

    function dispatchLeg(bytes32 requestId, DispatchLeg leg, uint256 feeAmount)
        external
        override
        nonReentrant
        whenDispatchOpen
    {
        IXcmWrapper.RequestRecord storage record = requests[requestId];
        if (record.context.account == address(0)) revert UnknownRequest();
        // Authorization follows the live configured operator so rotating a key
        // revokes its access to every pending request immediately.
        if (msg.sender != operator) revert Unauthorized();
        _validateLeg(record.context.kind, leg);

        uint8 legIndex = uint8(leg);
        uint8 bit = uint8(1) << legIndex;
        if ((requestDispatchBitmap[requestId] & bit) != 0) return;
        if (record.status != IXcmWrapper.RequestStatus.Pending) revert InvalidTransition();
        _requirePriorLeg(record.context.kind, leg, requestDispatchBitmap[requestId]);

        RequestParameters memory parameters = requestParameters[requestId];
        if (parameters.dispatchDeadline != 0 && block.timestamp > parameters.dispatchDeadline) {
            revert DispatchDeadlineExpired();
        }

        (bytes memory destination, bytes memory message, IXcmWrapper.Weight memory maxWeight) =
            _constructLeg(record.context, parameters, requestId, leg, feeAmount);

        if (leg == DispatchLeg.DepositFunding) {
            uint256 beforeBalance = _balanceOf(record.context.asset, address(this));
            IXcmV22CustodyAdapter(requestAdapter[requestId]).releaseAssetsToWrapper(requestId, record.context.assets);
            if (_balanceOf(record.context.asset, address(this)) - beforeBalance != record.context.assets) {
                revert CustodyMismatch();
            }
            _executeXcm(message, maxWeight);
        } else {
            _sendXcm(destination, message);
        }

        bytes32 destinationHash = keccak256(destination);
        bytes32 messageHash = keccak256(message);
        requestLegs[requestId][legIndex] = LegRecord({
            destinationHash: destinationHash,
            messageHash: messageHash,
            refTime: maxWeight.refTime,
            proofSize: maxWeight.proofSize,
            dispatched: true
        });
        requestDispatchBitmap[requestId] |= bit;

        emit RequestDispatched(requestId, xcmPrecompile, destinationHash, messageHash);
        emit RequestLegDispatched(requestId, leg, msg.sender, destinationHash, messageHash, feeAmount);
    }

    function previewLegMessage(bytes32 requestId, DispatchLeg leg, uint256 feeAmount)
        external
        view
        override
        returns (bytes memory destination, bytes memory message, IXcmWrapper.Weight memory maxWeight)
    {
        IXcmWrapper.RequestRecord storage record = requests[requestId];
        if (record.context.account == address(0)) revert UnknownRequest();
        _validateLeg(record.context.kind, leg);
        return _constructLeg(record.context, requestParameters[requestId], requestId, leg, feeAmount);
    }

    function finalizeRequest(
        bytes32 requestId,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares,
        bytes32 remoteRef,
        bytes32 failureCode
    ) external override nonReentrant {
        if (status == IXcmWrapper.RequestStatus.Unknown || status == IXcmWrapper.RequestStatus.Pending) {
            revert InvalidStatus();
        }
        IXcmWrapper.RequestRecord storage record = requests[requestId];
        if (record.context.account == address(0)) revert UnknownRequest();
        if (msg.sender != requestAdapter[requestId] && msg.sender != policy.owner()) revert Unauthorized();
        if ((policy.paused() || dispatchPaused) && status == IXcmWrapper.RequestStatus.Succeeded) {
            revert ProtocolPaused();
        }
        if (record.status != IXcmWrapper.RequestStatus.Pending) {
            if (
                record.status == status && record.settledAssets == settledAssets
                    && record.settledShares == settledShares && record.remoteRef == remoteRef
                    && record.failureCode == failureCode
            ) return;
            revert InvalidTransition();
        }
        if (
            status == IXcmWrapper.RequestStatus.Succeeded
                && !_bothLegsDispatched(record.context.kind, requestDispatchBitmap[requestId])
        ) {
            revert InvalidTransition();
        }
        _validateSettlementBounds(record.context, status, settledAssets, settledShares);

        if (status == IXcmWrapper.RequestStatus.Succeeded && record.context.kind == IXcmWrapper.RequestKind.Withdraw) {
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

    function getRequest(bytes32 requestId) external view override returns (IXcmWrapper.RequestRecord memory) {
        return requests[requestId];
    }

    function getRequestParameters(bytes32 requestId) external view override returns (RequestParameters memory) {
        return requestParameters[requestId];
    }

    function getRequestLeg(bytes32 requestId, DispatchLeg leg) external view returns (LegRecord memory) {
        return requestLegs[requestId][uint8(leg)];
    }

    function previewRecoveryHomeId(bytes32 requestId, uint256 amount, uint64 nonce)
        public
        view
        override
        returns (bytes32 recoveryId)
    {
        return keccak256(
            abi.encode(RECOVERY_HOME_DOMAIN, address(this), requestId, hydrationAccountId32, amount, nonce)
        );
    }

    function previewRecoveryHomeMessage(bytes32 requestId, uint256 amount, uint64 nonce)
        external
        view
        override
        returns (bytes memory destination, bytes memory message)
    {
        _validateRecovery(requestId, amount, nonce);
        bytes32 recoveryId = previewRecoveryHomeId(requestId, amount, nonce);
        return (HYDRATION_DESTINATION, _buildHome(amount, amount, recoveryId));
    }

    function dispatchRecoveryHome(bytes32 requestId, uint256 amount, uint64 nonce)
        external
        override
        onlyOwner
        nonReentrant
        returns (bytes32 recoveryId)
    {
        if (!dispatchPaused) revert InvalidStatus();
        _validateRecovery(requestId, amount, nonce);
        recoveryId = previewRecoveryHomeId(requestId, amount, nonce);
        LegRecord storage prior = recoveryHomeLegs[recoveryId];
        if (prior.dispatched) return recoveryId;

        bytes memory message = _buildHome(amount, amount, recoveryId);
        _sendXcm(HYDRATION_DESTINATION, message);
        bytes32 destinationHash = keccak256(HYDRATION_DESTINATION);
        bytes32 messageHash = keccak256(message);
        recoveryHomeLegs[recoveryId] = LegRecord({
            destinationHash: destinationHash, messageHash: messageHash, refTime: 0, proofSize: 0, dispatched: true
        });
        emit RecoveryHomeDispatched(requestId, recoveryId, amount, nonce, destinationHash, messageHash);
    }

    function getRecoveryHomeLeg(bytes32 recoveryId) external view returns (LegRecord memory) {
        return recoveryHomeLegs[recoveryId];
    }

    function releaseRecoveredAssetsToAdapter(bytes32 requestId, uint256 assets)
        external
        override
        onlyOwner
        nonReentrant
    {
        IXcmWrapper.RequestRecord storage record = requests[requestId];
        if (record.context.account == address(0)) revert UnknownRequest();
        uint256 recoveryCap = record.context.kind == IXcmWrapper.RequestKind.Deposit
            ? record.context.assets
            : record.context.kind == IXcmWrapper.RequestKind.Withdraw ? record.context.shares : 0;
        if (
            !dispatchPaused
                || (record.status != IXcmWrapper.RequestStatus.Failed
                    && record.status != IXcmWrapper.RequestStatus.Cancelled) || assets == 0
                || requestRecoveryReleased[requestId] + assets > recoveryCap
        ) revert InvalidStatus();
        address adapter = requestAdapter[requestId];
        if (assets > IXcmV22CustodyAdapter(adapter).recoveryAssetsOutstanding(requestId)) {
            revert InvalidStatus();
        }
        if (_balanceOf(record.context.asset, address(this)) < assets) revert CustodyMismatch();
        requestRecoveryReleased[requestId] += assets;
        record.context.asset.safeTransfer(adapter, assets);
        emit RecoveredAssetsReleased(requestId, adapter, assets);
    }

    function _constructLeg(
        IXcmWrapper.RequestContext memory context,
        RequestParameters memory parameters,
        bytes32 requestId,
        DispatchLeg leg,
        uint256 feeAmount
    ) internal view returns (bytes memory destination, bytes memory message, IXcmWrapper.Weight memory maxWeight) {
        if (leg == DispatchLeg.DepositFunding) {
            if (feeAmount != 0) revert FeeAboveMaximum();
            destination = LOCAL_HERE_DESTINATION;
            message = _buildDepositFunding(context.assets, requestId);
            maxWeight = _freshExecutionWeight(message);
            return (destination, message, maxWeight);
        }
        destination = HYDRATION_DESTINATION;
        if (leg == DispatchLeg.DepositSell) {
            if (feeAmount == 0 || feeAmount > parameters.maxFeePerLeg) revert FeeAboveMaximum();
            if (parameters.sellAmount + feeAmount > context.assets) revert FeeAboveMaximum();
            message = _buildSell(false, feeAmount, parameters.sellAmount, parameters.minimumOutput, requestId);
            return (destination, message, maxWeight);
        }
        if (leg == DispatchLeg.WithdrawSell) {
            // The complete remote asset-22 operating float is only knowable at
            // dispatch. The operator supplies that fresh reading within the
            // multisig-staged ceiling; every surplus is deposited back.
            if (feeAmount == 0 || feeAmount > parameters.maxFeePerLeg) revert FeeAboveMaximum();
            message = _buildSell(true, feeAmount, parameters.sellAmount, parameters.minimumOutput, requestId);
            return (destination, message, maxWeight);
        }
        if (feeAmount != 0) revert FeeAboveMaximum();
        // The complete expected return is both the reserve-withdraw amount
        // and nested BuyExecution budget; the tail deposits every surplus.
        message = _buildHome(parameters.minimumOutput, parameters.minimumOutput, requestId);
        return (destination, message, maxWeight);
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

    function _buildSell(bool withdraw, uint256 feeBudget, uint256 amount, uint256 minimumOutput, bytes32 requestId)
        internal
        view
        returns (bytes memory)
    {
        bytes memory encodedFee = _compact(feeBudget);
        return abi.encodePacked(
            hex"05180004010300a10f043205e51400",
            encodedFee,
            hex"13010300a10f043205e51400",
            encodedFee,
            hex"000601010700c817a80482841e00d04300",
            withdraw ? hex"eb03000016000000" : hex"16000000eb030000",
            _leU128(amount),
            _leU128(minimumOutput),
            withdraw ? hex"0404eb03000016000000140d01020400010100" : hex"040416000000eb030000140d01020400010100",
            hydrationAccountId32,
            hex"2c",
            requestId
        );
    }

    function _buildHome(uint256 amount, uint256 feeBudget, bytes32 topic) internal view returns (bytes memory) {
        bytes memory encodedAmount = _compact(amount);
        return abi.encodePacked(
            hex"05140004010300a10f043205e51400",
            encodedAmount,
            hex"13010300a10f043205e51400",
            encodedAmount,
            hex"001410010204010100a10f08130002043205e51400",
            _compact(feeBudget),
            hex"000d01020400010100",
            _wrapperAccountId32(),
            hex"2c",
            topic
        );
    }

    function _freshExecutionWeight(bytes memory message) internal view returns (IXcmWrapper.Weight memory doubled) {
        (bool ok, bytes memory data) =
            xcmPrecompile.staticcall(abi.encodeCall(IXcmPrecompileV22.weighMessage, (message)));
        if (!ok || data.length < 64) revert XcmPrecompileUnavailable();
        (uint256 refTime, uint256 proofSize) = abi.decode(data, (uint256, uint256));
        if (refTime == 0 || refTime > type(uint64).max / 2 || proofSize > type(uint64).max / 2) {
            revert XcmPrecompileUnavailable();
        }
        doubled = IXcmWrapper.Weight({refTime: uint64(refTime * 2), proofSize: uint64(proofSize * 2)});
    }

    function _validateContextAndParameters(
        IXcmWrapper.RequestContext calldata context,
        RequestParameters calldata parameters
    ) internal view {
        if (
            context.strategyId == bytes32(0) || context.account == address(0) || context.asset == address(0)
                || context.recipient == address(0) || context.nonce == 0 || parameters.sellAmount == 0
                || parameters.minimumOutput == 0 || parameters.maxFeePerLeg == 0
                || (parameters.dispatchDeadline != 0 && parameters.dispatchDeadline <= block.timestamp)
        ) revert InvalidRequest();
        if (context.kind == IXcmWrapper.RequestKind.Deposit) {
            if (
                context.assets == 0 || context.shares != 0 || parameters.sellAmount > context.assets
                    || parameters.sellAmount + parameters.maxFeePerLeg > context.assets
            ) revert InvalidRequest();
            return;
        }
        if (context.kind == IXcmWrapper.RequestKind.Withdraw) {
            if (
                context.assets != 0 || context.shares == 0 || parameters.sellAmount != context.shares
                    || parameters.minimumOutput > context.shares
            ) revert InvalidRequest();
            return;
        }
        revert InvalidRequest();
    }

    function _validateAdapterRequest(address adapter, bytes32 requestId, IXcmWrapper.RequestContext calldata context)
        internal
        view
    {
        IXcmV22CustodyAdapter.AdapterRequest memory staged = IXcmV22CustodyAdapter(adapter).getAdapterRequest(requestId);
        if (
            staged.account != context.account || staged.recipient != context.recipient || staged.kind != context.kind
                || staged.status != IXcmWrapper.RequestStatus.Pending || staged.settled
        ) revert CustodyMismatch();
        if (context.kind == IXcmWrapper.RequestKind.Deposit && staged.requestedAssets != context.assets) {
            revert CustodyMismatch();
        }
        if (context.kind == IXcmWrapper.RequestKind.Withdraw && staged.requestedShares != context.shares) {
            revert CustodyMismatch();
        }
    }

    function _validateLeg(IXcmWrapper.RequestKind kind, DispatchLeg leg) internal pure {
        if (
            kind == IXcmWrapper.RequestKind.Deposit
                && (leg == DispatchLeg.DepositFunding || leg == DispatchLeg.DepositSell)
        ) return;
        if (
            kind == IXcmWrapper.RequestKind.Withdraw
                && (leg == DispatchLeg.WithdrawSell || leg == DispatchLeg.WithdrawHome)
        ) return;
        revert InvalidRequest();
    }

    function _requirePriorLeg(IXcmWrapper.RequestKind kind, DispatchLeg leg, uint8 bitmap) internal pure {
        if (kind == IXcmWrapper.RequestKind.Deposit && leg == DispatchLeg.DepositSell && (bitmap & 0x01) == 0) {
            revert InvalidTransition();
        }
        if (kind == IXcmWrapper.RequestKind.Withdraw && leg == DispatchLeg.WithdrawHome && (bitmap & 0x04) == 0) {
            revert InvalidTransition();
        }
    }

    function _validateRecovery(bytes32 requestId, uint256 amount, uint64 nonce) internal view {
        IXcmWrapper.RequestRecord storage record = requests[requestId];
        if (
            record.context.account == address(0) || amount == 0 || nonce == 0 || hydrationAccountId32 == bytes32(0)
                || (record.status != IXcmWrapper.RequestStatus.Failed
                    && record.status != IXcmWrapper.RequestStatus.Cancelled)
        ) revert InvalidRequest();
        uint256 cap = record.context.kind == IXcmWrapper.RequestKind.Deposit
            ? record.context.assets
            : record.context.kind == IXcmWrapper.RequestKind.Withdraw ? record.context.shares : 0;
        uint256 outstanding = IXcmV22CustodyAdapter(requestAdapter[requestId]).recoveryAssetsOutstanding(requestId);
        if (amount > outstanding || requestRecoveryReleased[requestId] + amount > cap) revert InvalidRequest();
    }

    function _validateSettlementBounds(
        IXcmWrapper.RequestContext memory context,
        IXcmWrapper.RequestStatus status,
        uint256 settledAssets,
        uint256 settledShares
    ) internal pure {
        if (status != IXcmWrapper.RequestStatus.Succeeded) {
            if (settledAssets != 0 || settledShares != 0) revert InvalidSettlement();
            return;
        }
        if (context.kind == IXcmWrapper.RequestKind.Deposit) {
            if (settledAssets > context.assets) revert InvalidSettlement();
            return;
        }
        if (context.kind == IXcmWrapper.RequestKind.Withdraw) {
            if (settledShares > context.shares || settledAssets > context.shares) revert InvalidSettlement();
            return;
        }
        revert InvalidSettlement();
    }

    function _bothLegsDispatched(IXcmWrapper.RequestKind kind, uint8 bitmap) internal pure returns (bool) {
        if (kind == IXcmWrapper.RequestKind.Deposit) return (bitmap & 0x03) == 0x03;
        if (kind == IXcmWrapper.RequestKind.Withdraw) return (bitmap & 0x0c) == 0x0c;
        return false;
    }

    function _sameContext(IXcmWrapper.RequestContext storage stored, IXcmWrapper.RequestContext calldata supplied)
        internal
        view
        returns (bool)
    {
        return stored.strategyId == supplied.strategyId && stored.kind == supplied.kind
            && stored.account == supplied.account && stored.asset == supplied.asset
            && stored.recipient == supplied.recipient && stored.assets == supplied.assets
            && stored.shares == supplied.shares && stored.nonce == supplied.nonce;
    }

    function _sameParameters(RequestParameters storage stored, RequestParameters calldata supplied)
        internal
        view
        returns (bool)
    {
        return stored.sellAmount == supplied.sellAmount && stored.minimumOutput == supplied.minimumOutput
            && stored.maxFeePerLeg == supplied.maxFeePerLeg && stored.dispatchDeadline == supplied.dispatchDeadline;
    }

    function _executeXcm(bytes memory message, IXcmWrapper.Weight memory maxWeight) internal {
        (bool ok, bytes memory data) =
            xcmPrecompile.call(abi.encodeCall(IXcmPrecompileV22.execute, (message, maxWeight)));
        if (!ok) revert XcmDispatchFailed(data);
    }

    function _sendXcm(bytes memory destination, bytes memory message) internal {
        (bool ok, bytes memory data) =
            xcmPrecompile.call(abi.encodeCall(IXcmPrecompileV22.send, (destination, message)));
        if (!ok) revert XcmDispatchFailed(data);
    }

    function _wrapperAccountId32() internal view returns (bytes32 result) {
        result = bytes32(bytes20(address(this))) | bytes32(uint256(0xeeeeeeeeeeeeeeeeeeeeeeee));
    }

    function _balanceOf(address token, address account) internal view returns (uint256 balance) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || data.length != 32) revert CustodyMismatch();
        balance = abi.decode(data, (uint256));
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
        uint256 cursor = value;
        while (cursor != 0) {
            length++;
            cursor >>= 8;
        }
        if (length < 4 || length > 67) revert InvalidRequest();
        encoded = new bytes(length + 1);
        encoded[0] = bytes1(uint8(((length - 4) << 2) | 3));
        for (uint256 i = 0; i < length; i++) {
            encoded[i + 1] = bytes1(uint8(value >> (i * 8)));
        }
    }

    function _leU128(uint256 value) internal pure returns (bytes memory encoded) {
        if (value > type(uint128).max) revert InvalidRequest();
        encoded = new bytes(16);
        for (uint256 i = 0; i < 16; i++) {
            encoded[i] = bytes1(uint8(value >> (i * 8)));
        }
    }
}
