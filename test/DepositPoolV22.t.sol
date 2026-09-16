// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DepositPoolV22} from "../contracts/DepositPoolV22.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {IDepositPoolVenueAdapter} from "../contracts/interfaces/IDepositPoolVenueAdapter.sol";
import {MockV21Usdc} from "./DepositPoolV21.t.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AacPoolAggregatorAdapterV22} from "../contracts/strategies/AacPoolAggregatorAdapterV22.sol";

interface VmV22 {
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract V22Venue is IDepositPoolVenueAdapter {
    MockV21Usdc public token;
    address public override lossReporter;
    mapping(bytes32 => Request) private requests;
    uint256 private nonce;
    uint256 public friction;
    bool public failRecall;

    constructor(MockV21Usdc token_, address owner) { token = token_; lossReporter = owner; }
    function asset() external view returns (address) { return address(token); }
    function managedAssets(address) external view returns (uint256) { return token.balanceOf(address(this)); }
    function setFriction(uint256 value) external { friction = value; }
    function setFailRecall(bool value) external { failRecall = value; }
    function requestDeploy(uint256 assets, uint64 returnBy) external returns (bytes32 id) {
        id = bytes32(++nonce);
        requests[id] = Request(RequestKind.Deploy, RequestStatus.Succeeded, assets, assets, returnBy, false);
    }
    function requestRecall(uint256 assets, uint64 returnBy) external returns (bytes32 id) {
        id = bytes32(++nonce);
        requests[id] = Request(RequestKind.Recall, failRecall ? RequestStatus.Failed : RequestStatus.Succeeded,
            assets, failRecall ? 0 : assets - friction, returnBy, false);
    }
    function getRequest(bytes32 id) external view returns (Request memory) { return requests[id]; }
    function claimSettled(bytes32 id) external returns (uint256 assets) {
        Request storage request = requests[id];
        require(!request.claimed);
        request.claimed = true;
        assets = request.settledAssets;
        if (request.kind == RequestKind.Recall && request.status == RequestStatus.Succeeded) {
            token.burn(address(this), request.requestedAssets - assets);
            token.transfer(msg.sender, assets);
        }
    }
}

contract DepositPoolV22Test is Test {
    VmV22 private constant vx = VmV22(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockV21Usdc internal token;
    TreasuryPolicy internal policy;
    V22Venue internal venue;
    DepositPoolV22 internal pool;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockV21Usdc();
        policy = new TreasuryPolicy();
        venue = new V22Venue(token, address(this));
        pool = new DepositPoolV22(policy, address(token), address(this), venue, address(0xC));
        _deposit(alice, 10e6);
        _deposit(bob, 10e6);
    }

    function _deposit(address holder, uint256 assets) internal {
        token.mint(holder, assets);
        vm.startPrank(holder);
        token.approve(address(pool), type(uint256).max);
        pool.deposit(assets, holder);
        vm.stopPrank();
    }

    function testPin2CommitmentBlocksEveryExitUntilExpiryWithoutSweep() public {
        vm.prank(alice);
        pool.commit(DepositPoolV22.NoticeTier.Notice30Days);
        (, uint64 until) = pool.commitment(alice);
        for (uint8 tier; tier < 3; ++tier) {
            vm.prank(alice);
            vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.CommitmentActive.selector, until));
            pool.requestRedeem(1e6, alice, DepositPoolV22.NoticeTier(tier));
        }
        vm.prank(alice);
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.CommitmentActive.selector, until));
        pool.redeem(1e6, alice, alice);
        vm.warp(until + 1);
        vm.prank(alice);
        assertEq(pool.requestRedeem(1e6, alice, DepositPoolV22.NoticeTier.Notice7Days), 1);
    }

    function testPin3CommitCannotShortenExceed90DaysOrMoveShares() public {
        uint256 start = block.timestamp;
        vm.prank(alice);
        pool.commit(DepositPoolV22.NoticeTier.Notice90Days);
        (, uint64 until) = pool.commitment(alice);
        assertEq(until, start + 90 days);
        vm.prank(alice);
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.CommitmentCannotShorten.selector,
            until, uint64(start + 7 days)));
        pool.commit(DepositPoolV22.NoticeTier.Notice7Days);
        pool.setAggregatorAdapter(alice, true);
        vm.prank(alice);
        vx.expectRevert(DepositPoolV22.InvalidReturnDeadline.selector);
        pool.commitUntil(DepositPoolV22.NoticeTier.Notice90Days, uint64(start + 90 days + 1));
        assertEq(pool.balanceOf(alice), 10e6);
        assertEq(pool.balanceOf(bob), 10e6);
        assertEq(pool.totalSupply(), 20e6);
    }

    function testPin4FlexKeepsSevenDayCapacityAndHasNoLongCapacity() public {
        assertEq(pool.deployableFor(7 days), pool.maxDeployableAssets());
        assertEq(pool.deployableFor(7 days), 10e6);
        assertEq(pool.deployableFor(30 days), 0);
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.BufferFloorBreached.selector, 20e6, 10e6, 1));
        pool.deployToVenue(1, uint64(block.timestamp + 7 days + 1));
        pool.deployToVenue(10e6, uint64(block.timestamp + 7 days));
        assertEq(pool.bufferAssets(), pool.bufferFloor());
    }

    function testPin4bLongWindowRequiresBothBackingAndFlexFloor() public {
        // Deliberately unequal: committed backing (15) exceeds liquid capacity
        // (25 - 15 = 10), so removing the Flex-floor cap cannot pass by equality.
        _deposit(alice, 5e6);
        vm.prank(alice);
        pool.commit(DepositPoolV22.NoticeTier.Notice90Days);
        assertEq(pool.deployableFor(90 days), 10e6);
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.BufferFloorBreached.selector, 25e6, 15e6, 10e6 + 1));
        pool.deployToVenue(10e6 + 1, uint64(block.timestamp + 90 days));
        uint256 id = pool.deployToVenue(10e6, uint64(block.timestamp + 90 days));
        assertEq(id, 1);
        assertEq(pool.longDeployedOutstanding(), 10e6);
        assertEq(pool.deployableFor(30 days), 0);
        require(pool.bufferAssets() >= pool.bufferFloor(), "FLEX_FLOOR_UNCOVERED");
    }

    function testPin4bBackingCanBeSmallerThanLiquidCapacity() public {
        _deposit(address(0xD), 1e6);
        vm.prank(address(0xD));
        pool.commit(DepositPoolV22.NoticeTier.Notice90Days);
        assertEq(pool.deployableFor(90 days), 1e6);
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.BufferFloorBreached.selector, 21e6, 10e6, 1e6 + 1));
        pool.deployToVenue(1e6 + 1, uint64(block.timestamp + 90 days));
    }

    function testPin5ExpiredBucketIsExitableWithoutTransaction() public {
        vm.prank(alice);
        pool.commit(DepositPoolV22.NoticeTier.Notice30Days);
        assertEq(pool.committedSharesBeyond(block.timestamp + 7 days), 10e6);
        vm.warp(block.timestamp + 31 days);
        assertEq(pool.committedSharesBeyond(block.timestamp + 7 days), 0);
        assertEq(pool.deployableFor(30 days), 0);
        // Mint after expiry must not revive the old bucket or break a later burn.
        _deposit(alice, 1e6);
        vm.prank(alice);
        pool.redeem(11e6, alice, alice);
    }

    function testPin6RebindRequiresOwnerTimelockAndNoActiveDeploymentOrRecall() public {
        V22Venue next = new V22Venue(token, address(this));
        vm.prank(alice);
        vx.expectRevert(DepositPoolV22.Unauthorized.selector);
        pool.proposeVenueAdapter(next);
        pool.proposeVenueAdapter(next);
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.VenueRebindNotReady.selector,
            uint64(block.timestamp + 7 days)));
        pool.applyVenueAdapter();
        uint256 id = pool.deployToVenue(5e6, uint64(block.timestamp + 7 days));
        pool.settleVenueDeployment(id);
        vm.warp(block.timestamp + 7 days);
        vx.expectRevert(DepositPoolV22.VenueDeploymentAlreadyActive.selector);
        pool.applyVenueAdapter();
        uint256 recall = pool.recallVenueDeployment(id, 5e6);
        vx.expectRevert(DepositPoolV22.VenueDeploymentAlreadyActive.selector);
        pool.applyVenueAdapter();
        pool.settleVenueRecall(recall);
        vm.prank(alice);
        vx.expectRevert(DepositPoolV22.Unauthorized.selector);
        pool.applyVenueAdapter();
        pool.applyVenueAdapter();
        assertEq(address(pool.venueAdapter()), address(next));
        vx.expectRevert(DepositPoolV22.VenueAdapterAlreadySet.selector);
        pool.setVenueAdapter(venue);
    }

    function testPin7CycleOneRealises51765AndClosesAtRecallSettlement() public {
        uint256 nav = pool.totalAssets();
        uint256 id = pool.deployToVenue(9_980_137, uint64(block.timestamp + 7 days));
        pool.settleVenueDeployment(id);
        venue.setFriction(51_765);
        uint256 recall = pool.recallVenueDeployment(id, 9_980_137);
        (, uint256 returned) = pool.settleVenueRecall(recall);
        assertEq(returned, 9_928_372);
        assertEq(pool.totalAssets(), nav - 51_765);
        assertEq(pool.venueWrittenOffPrincipalAssets(id), 51_765);
        assertEq(pool.venuePrincipalCostBasis(), 0);
        assertEq(pool.activeVenueDeploymentId(), 0);
        assertEq(pool.activeVenueRecallId(), 0);
    }

    function testPartialOrFailedRecallNeverWritesOffRemainingLivePrincipal() public {
        uint256 id = pool.deployToVenue(10e6, uint64(block.timestamp + 7 days));
        pool.settleVenueDeployment(id);
        uint256 recall = pool.recallVenueDeployment(id, 1e6);
        pool.settleVenueRecall(recall);
        assertEq(pool.venuePrincipalCostBasis(), 9e6);
        assertEq(pool.activeVenueDeploymentId(), id);
        venue.setFailRecall(true);
        recall = pool.recallVenueDeployment(id, 9e6);
        pool.settleVenueRecall(recall);
        assertEq(pool.venuePrincipalCostBasis(), 9e6);
        assertEq(pool.venueWrittenOffPrincipalAssets(id), 0);
    }

    function testV22AggregatorSynchronousAllocationAtomicCommitAndNoticeExit() public {
        StrategyAdapterRegistry registry = new StrategyAdapterRegistry(policy);
        AgentAccountCore accounts = new AgentAccountCore(policy, registry);
        AacPoolAggregatorAdapterV22 adapter = new AacPoolAggregatorAdapterV22(address(accounts), pool);
        policy.setApprovedAsset(address(token), true);
        policy.setApprovedStrategy(address(adapter), true);
        registry.registerStrategy(address(adapter));
        pool.setAggregatorAdapter(address(adapter), true);
        token.mint(alice, 25e6);
        vm.startPrank(alice);
        token.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(token), 25e6);
        accounts.allocateIdleFunds(alice, adapter.strategyId(), 25e6);
        vm.stopPrank();
        assertEq(accounts.strategyShares(alice, adapter.strategyId()), 25e6);
        uint64 consentUntil = uint64(block.timestamp + 20 days);
        adapter.sweepToPoolAndCommit(25e6, consentUntil);
        (, uint64 until) = pool.commitment(address(adapter));
        assertEq(until, consentUntil);
        vm.prank(bob);
        vx.expectRevert(AacPoolAggregatorAdapterV22.Unauthorized.selector);
        adapter.commitSharedUntil(uint64(block.timestamp + 30 days));
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.CommitmentCannotShorten.selector,
            consentUntil, uint64(block.timestamp + 7 days)));
        adapter.commitSharedUntil(uint64(block.timestamp + 7 days));
        vx.expectRevert(abi.encodeWithSelector(DepositPoolV22.CommitmentActive.selector, consentUntil));
        adapter.requestFloatExit(25e6, DepositPoolV22.NoticeTier.Notice7Days);
        vm.warp(consentUntil + 1);
        uint256 request = adapter.requestFloatExit(25e6, DepositPoolV22.NoticeTier.Notice7Days);
        vm.warp(block.timestamp + 7 days);
        adapter.fulfilFloatExit(request);
        bytes32 strategy = adapter.strategyId();
        vm.prank(alice);
        accounts.deallocateIdleFunds(alice, strategy, 25e6);
        assertEq(accounts.strategyShares(alice, adapter.strategyId()), 0);
        assertEq(pool.balanceOf(address(adapter)), 0);
    }
}

contract V22WindowHandler is Test {
    DepositPoolV22 public pool;
    MockV21Usdc private token;
    V22Venue private venue;
    address[2] private holders = [address(0xA), address(0xB)];
    bool public violated;

    constructor() {
        TreasuryPolicy policy = new TreasuryPolicy();
        token = new MockV21Usdc();
        venue = new V22Venue(token, address(this));
        pool = new DepositPoolV22(policy, address(token), address(this), venue, address(0xC));
        for (uint256 i; i < 2; ++i) {
            token.mint(holders[i], 30e6);
            vm.startPrank(holders[i]);
            token.approve(address(pool), type(uint256).max);
            pool.deposit(30e6, holders[i]);
            vm.stopPrank();
        }
    }

    function commitOrAdvance(uint8 who, uint8 tier, uint32 secondsForward) external {
        vm.warp(block.timestamp + uint256(secondsForward) % (32 days));
        vm.prank(holders[who % 2]);
        try pool.commit(DepositPoolV22.NoticeTier(tier % 3)) {} catch {}
    }

    function deploy(uint256 amount, uint8 window) external {
        uint256 duration = window % 3 == 0 ? 7 days : window % 3 == 1 ? 30 days : 90 days;
        uint256 assets = amount % (65e6) + 1;
        uint256 buffer = pool.bufferAssets();
        uint256 floor = pool.bufferFloor();
        // Independent oracle: enumerate the TWO fixture holders, not the SUT's
        // deployableFor/buckets. The production read is deliberately conservative.
        uint256 committed;
        for (uint256 i; i < 2; ++i) {
            (, uint64 until) = pool.commitment(holders[i]);
            if (until >= block.timestamp + duration) committed += pool.convertToAssets(pool.balanceOf(holders[i]));
        }
        uint256 outstanding = pool.longDeployedOutstanding();
        try pool.deployToVenue(assets, uint64(block.timestamp + duration)) {
            if (buffer < floor || assets > buffer - floor) violated = true;
            if (duration > 7 days && (committed < outstanding || assets > committed - outstanding)) violated = true;
        } catch {}
    }

    function recall() external {
        uint256 id = pool.activeVenueDeploymentId();
        if (id == 0) return;
        try pool.settleVenueDeployment(id) {} catch {}
        uint256 assets = token.balanceOf(address(venue));
        if (assets == 0) return;
        try pool.recallVenueDeployment(id, assets) returns (uint256 recallId) {
            pool.settleVenueRecall(recallId);
        } catch {}
    }
}

contract DepositPoolV22InvariantTest is Test {
    V22WindowHandler private handler;
    function setUp() public { vm.warp(1_800_000_000); handler = new V22WindowHandler(); }
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1); targets[0] = address(handler);
    }
    function invariant_Pin1EveryCreatedWindowPreservesBothBackingAndFlexFloor() public view {
        require(!handler.violated(), "WINDOW_CONSTRAINT_VIOLATED");
    }
}
