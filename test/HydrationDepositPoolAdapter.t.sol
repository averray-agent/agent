// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {DepositPool} from "../contracts/DepositPool.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {IDepositPoolVenueAdapter} from "../contracts/interfaces/IDepositPoolVenueAdapter.sol";
import {IHydrationDepositPoolLane} from "../contracts/interfaces/IHydrationDepositPoolLane.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {IXcmV22CustodyAdapter} from "../contracts/interfaces/IXcmV22CustodyAdapter.sol";
import {HydrationDepositPoolAdapter} from "../contracts/strategies/HydrationDepositPoolAdapter.sol";

interface VmHydrationDepositPool {
    function expectRevert(bytes4 selector) external;
}

contract HydrationDepositPoolAdapterTest is Test {
    uint256 internal constant USDC = 1e6;
    VmHydrationDepositPool internal constant vmx =
        VmHydrationDepositPool(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal operator = address(0xA0);
    address internal pool;
    TreasuryPolicy internal policy;
    MockHydrationPoolUsdc internal asset;
    MockExclusiveHydrationLane internal lane;
    HydrationDepositPoolAdapter internal adapter;
    DepositPool internal depositPool;

    function setUp() public {
        policy = new TreasuryPolicy();
        policy.setStrategySettler(operator, true);
        asset = new MockHydrationPoolUsdc();
        MockHydrationPoolAdapterFactory factory = new MockHydrationPoolAdapterFactory();
        (lane, adapter, depositPool) = factory.deploy(policy, asset, operator);
        pool = address(depositPool);
        asset.mint(pool, 20 * USDC);
    }

    function testAsyncHydrationLifecycleKeepsPendingVisibleAndReturnsObservedYield() public {
        uint64 returnBy = uint64(block.timestamp + 7 days);
        vm.prank(pool);
        asset.transfer(address(adapter), 10 * USDC);
        vm.prank(pool);
        bytes32 deployRequest = adapter.requestDeploy(10 * USDC, returnBy);

        HydrationDepositPoolAdapter.LaneParameters memory deployParameters = HydrationDepositPoolAdapter.LaneParameters({
            sellAmount: 9 * USDC,
            minimumOutput: 10 * USDC,
            maxFeePerLeg: 1 * USDC,
            dispatchDeadline: uint64(block.timestamp + 1 days),
            nonce: 1
        });
        vm.prank(operator);
        bytes32 laneDeployRequest = adapter.stageDeploy(deployRequest, deployParameters);
        assertEq(adapter.managedAssets(pool), 10 * USDC);

        IDepositPoolVenueAdapter.Request memory pending = adapter.getRequest(deployRequest);
        assertEq(uint256(pending.status), uint256(IDepositPoolVenueAdapter.RequestStatus.Pending));
        vm.prank(pool);
        vmx.expectRevert(HydrationDepositPoolAdapter.RequestPending.selector);
        adapter.claimSettled(deployRequest);

        lane.settleDeposit(laneDeployRequest, 10 * USDC);
        vm.prank(pool);
        assertEq(adapter.claimSettled(deployRequest), 10 * USDC);
        assertEq(adapter.managedAssets(pool), 10 * USDC);

        lane.observeRebasingPosition(11 * USDC);
        assertEq(adapter.managedAssets(pool), 11 * USDC);

        vm.prank(pool);
        bytes32 recallRequest = adapter.requestRecall(11 * USDC, returnBy);
        HydrationDepositPoolAdapter.LaneParameters memory recallParameters = HydrationDepositPoolAdapter.LaneParameters({
            sellAmount: 11 * USDC,
            minimumOutput: 11 * USDC,
            maxFeePerLeg: 1 * USDC,
            dispatchDeadline: uint64(block.timestamp + 1 days),
            nonce: 2
        });
        vm.prank(operator);
        (bytes32 laneRecallRequest, uint256 shares) = adapter.stageRecall(recallRequest, recallParameters);
        assertEq(shares, 11 * USDC);
        lane.settleWithdraw(laneRecallRequest, 11 * USDC);

        vm.prank(pool);
        assertEq(adapter.claimSettled(recallRequest), 11 * USDC);
        assertEq(asset.balanceOf(pool), 21 * USDC);
        assertEq(adapter.managedAssets(pool), 0);
    }

    function testAdapterRejectsDispatchPlanPastPoolDeadline() public {
        uint64 returnBy = uint64(block.timestamp + 7 days);
        vm.prank(pool);
        asset.transfer(address(adapter), 10 * USDC);
        vm.prank(pool);
        bytes32 requestId = adapter.requestDeploy(10 * USDC, returnBy);

        HydrationDepositPoolAdapter.LaneParameters memory parameters = HydrationDepositPoolAdapter.LaneParameters({
            sellAmount: 9 * USDC,
            minimumOutput: 10 * USDC,
            maxFeePerLeg: 1 * USDC,
            dispatchDeadline: returnBy + 1,
            nonce: 1
        });
        vm.prank(operator);
        vmx.expectRevert(HydrationDepositPoolAdapter.InvalidRequest.selector);
        adapter.stageDeploy(requestId, parameters);
    }

    function testUnstagedDeploymentCanBeCancelledAndClaimedBackToPool() public {
        vm.prank(pool);
        asset.transfer(address(adapter), 10 * USDC);
        vm.prank(pool);
        bytes32 requestId = adapter.requestDeploy(10 * USDC, uint64(block.timestamp + 7 days));

        vm.prank(operator);
        adapter.cancelUnstaged(requestId);
        IDepositPoolVenueAdapter.Request memory cancelled = adapter.getRequest(requestId);
        assertEq(uint256(cancelled.status), uint256(IDepositPoolVenueAdapter.RequestStatus.Failed));

        vm.prank(pool);
        assertEq(adapter.claimSettled(requestId), 10 * USDC);
        assertEq(asset.balanceOf(pool), 20 * USDC);
        assertEq(adapter.managedAssets(pool), 0);
    }

    function testRemoteDepositFailureRemainsInNavUntilRecoveryReturnsToPool() public {
        uint64 returnBy = uint64(block.timestamp + 7 days);
        vm.prank(pool);
        asset.transfer(address(adapter), 10 * USDC);
        vm.prank(pool);
        bytes32 deployRequest = adapter.requestDeploy(10 * USDC, returnBy);

        HydrationDepositPoolAdapter.LaneParameters memory parameters = HydrationDepositPoolAdapter.LaneParameters({
            sellAmount: 9 * USDC,
            minimumOutput: 10 * USDC,
            maxFeePerLeg: 1 * USDC,
            dispatchDeadline: uint64(block.timestamp + 1 days),
            nonce: 1
        });
        vm.prank(operator);
        bytes32 laneRequest = adapter.stageDeploy(deployRequest, parameters);
        lane.failDepositWithRecovery(laneRequest, 10 * USDC);

        // A failed cross-chain request is still managed pool value while its
        // observer-capped recovery is outstanding. There is no low-NAV gap in
        // which a depositor can mint too many shares.
        assertEq(adapter.managedAssets(pool), 10 * USDC);
        IDepositPoolVenueAdapter.Request memory unresolved = adapter.getRequest(deployRequest);
        assertEq(uint256(unresolved.status), uint256(IDepositPoolVenueAdapter.RequestStatus.Pending));

        vm.prank(operator);
        adapter.releaseRecoveredToPool(deployRequest, 10 * USDC);
        assertEq(asset.balanceOf(pool), 20 * USDC);
        assertEq(adapter.managedAssets(pool), 0);

        IDepositPoolVenueAdapter.Request memory failed = adapter.getRequest(deployRequest);
        assertEq(uint256(failed.status), uint256(IDepositPoolVenueAdapter.RequestStatus.Failed));
        assertEq(failed.settledAssets, 10 * USDC);
        vm.prank(pool);
        assertEq(adapter.claimSettled(deployRequest), 10 * USDC);
    }
}

contract MockHydrationPoolAdapterFactory {
    function deploy(TreasuryPolicy policy, MockHydrationPoolUsdc asset, address operator)
        external
        returns (MockExclusiveHydrationLane lane, HydrationDepositPoolAdapter adapter, DepositPool pool)
    {
        // A fresh contract starts child CREATE nonces at one. The dedicated
        // lane is nonce one, the bridge adapter nonce two, and the pool nonce
        // three. Prediction resolves all three immutable links without an
        // upgradeable or operator-repointable venue slot.
        address predictedAdapter =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"02")))));
        address predictedPool =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"03")))));
        lane = new MockExclusiveHydrationLane(policy, asset, predictedAdapter);
        adapter = new HydrationDepositPoolAdapter(predictedPool, lane);
        pool = new DepositPool(address(asset), operator, adapter);
        require(address(adapter) == predictedAdapter, "PREDICTION");
        require(address(pool) == predictedPool, "POOL_PREDICTION");
    }
}

contract MockExclusiveHydrationLane is IHydrationDepositPoolLane {
    TreasuryPolicy public immutable override policy;
    MockHydrationPoolUsdc public immutable token;
    address public immutable override asset;
    address public immutable override agentAccountCore;
    uint256 public override totalAssets;
    uint256 public override totalShares;
    uint256 public override pendingDepositAssets;
    uint256 public pendingWithdrawalShares;
    mapping(bytes32 => bool) public fundingReleased;
    mapping(bytes32 => bool) public override requiresRemoteRecovery;
    mapping(bytes32 => uint256) public override recoveryAssetsOutstanding;
    mapping(bytes32 => IXcmV22CustodyAdapter.AdapterRequest) internal requests;

    constructor(TreasuryPolicy policy_, MockHydrationPoolUsdc token_, address agentAccountCore_) {
        policy = policy_;
        token = token_;
        asset = address(token_);
        agentAccountCore = agentAccountCore_;
    }

    function requestDeposit(address account, uint256 assets, uint256, uint256, uint256, uint64, uint64 nonce)
        external
        override
        returns (bytes32 requestId)
    {
        require(msg.sender == agentAccountCore, "CORE");
        token.transferFrom(msg.sender, address(this), assets);
        requestId = keccak256(abi.encode("DEPOSIT", msg.sender, account, assets, nonce));
        pendingDepositAssets += assets;
        requests[requestId] = IXcmV22CustodyAdapter.AdapterRequest({
            kind: IXcmWrapper.RequestKind.Deposit,
            status: IXcmWrapper.RequestStatus.Pending,
            account: account,
            requester: msg.sender,
            recipient: account,
            requestedAssets: assets,
            requestedShares: 0,
            settledAssets: 0,
            settledShares: 0,
            remoteRef: bytes32(0),
            failureCode: bytes32(0),
            settled: false
        });
    }

    function requestWithdraw(address account, uint256 shares, address recipient, uint256, uint256, uint64, uint64 nonce)
        external
        override
        returns (bytes32 requestId)
    {
        require(msg.sender == agentAccountCore, "CORE");
        require(shares <= totalShares - pendingWithdrawalShares, "SHARES");
        requestId = keccak256(abi.encode("WITHDRAW", msg.sender, account, shares, nonce));
        pendingWithdrawalShares += shares;
        requests[requestId] = IXcmV22CustodyAdapter.AdapterRequest({
            kind: IXcmWrapper.RequestKind.Withdraw,
            status: IXcmWrapper.RequestStatus.Pending,
            account: account,
            requester: msg.sender,
            recipient: recipient,
            requestedAssets: 0,
            requestedShares: shares,
            settledAssets: 0,
            settledShares: 0,
            remoteRef: bytes32(0),
            failureCode: bytes32(0),
            settled: false
        });
    }

    function settleDeposit(bytes32 requestId, uint256 settledAssets) external {
        IXcmV22CustodyAdapter.AdapterRequest storage request = requests[requestId];
        require(request.kind == IXcmWrapper.RequestKind.Deposit && !request.settled, "REQUEST");
        pendingDepositAssets -= request.requestedAssets;
        totalAssets += settledAssets;
        totalShares += settledAssets;
        request.status = IXcmWrapper.RequestStatus.Succeeded;
        request.settledAssets = settledAssets;
        request.settledShares = settledAssets;
        request.settled = true;
    }

    function settleWithdraw(bytes32 requestId, uint256 settledAssets) external {
        IXcmV22CustodyAdapter.AdapterRequest storage request = requests[requestId];
        require(request.kind == IXcmWrapper.RequestKind.Withdraw && !request.settled, "REQUEST");
        uint256 redeemedAssets = (request.requestedShares * totalAssets) / totalShares;
        pendingWithdrawalShares -= request.requestedShares;
        totalShares -= request.requestedShares;
        totalAssets -= redeemedAssets;
        request.status = IXcmWrapper.RequestStatus.Succeeded;
        request.settledAssets = settledAssets;
        request.settledShares = request.requestedShares;
        request.settled = true;
        token.transfer(request.recipient, settledAssets);
    }

    function failDepositWithRecovery(bytes32 requestId, uint256 recoverableAssets) external {
        IXcmV22CustodyAdapter.AdapterRequest storage request = requests[requestId];
        require(request.kind == IXcmWrapper.RequestKind.Deposit && !request.settled, "REQUEST");
        require(recoverableAssets <= request.requestedAssets, "RECOVERY");
        pendingDepositAssets -= request.requestedAssets;
        requiresRemoteRecovery[requestId] = recoverableAssets != 0;
        recoveryAssetsOutstanding[requestId] = recoverableAssets;
        request.status = IXcmWrapper.RequestStatus.Failed;
        request.settled = true;
    }

    function observeRebasingPosition(uint256 assets) external {
        require(pendingDepositAssets == 0 && pendingWithdrawalShares == 0, "PENDING");
        if (assets > totalAssets) token.mint(address(this), assets - totalAssets);
        totalAssets = assets;
        totalShares = assets;
    }

    function getAdapterRequest(bytes32 requestId)
        external
        view
        override
        returns (IXcmV22CustodyAdapter.AdapterRequest memory)
    {
        return requests[requestId];
    }

    function releaseRecoveredAssets(bytes32 requestId, address recipient, uint256 assets) external override {
        require(msg.sender == requests[requestId].requester, "REQUESTER");
        recoveryAssetsOutstanding[requestId] -= assets;
        if (recoveryAssetsOutstanding[requestId] == 0) requiresRemoteRecovery[requestId] = false;
        token.transfer(recipient, assets);
    }
}

    contract MockHydrationPoolUsdc {
        uint8 public constant decimals = 6;
        mapping(address => uint256) public balanceOf;
        mapping(address => mapping(address => uint256)) public allowance;

        function mint(address to, uint256 assets) external {
            balanceOf[to] += assets;
        }

        function approve(address spender, uint256 assets) external returns (bool) {
            allowance[msg.sender][spender] = assets;
            return true;
        }

        function transfer(address to, uint256 assets) external returns (bool) {
            _transfer(msg.sender, to, assets);
            return true;
        }

        function transferFrom(address from, address to, uint256 assets) external returns (bool) {
            uint256 allowed = allowance[from][msg.sender];
            require(allowed >= assets, "ALLOWANCE");
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - assets;
            _transfer(from, to, assets);
            return true;
        }

        function _transfer(address from, address to, uint256 assets) private {
            require(balanceOf[from] >= assets, "BALANCE");
            balanceOf[from] -= assets;
            balanceOf[to] += assets;
        }
    }
