// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";
import {MockVDotAdapter} from "../contracts/strategies/MockVDotAdapter.sol";

contract AgentPlatformTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    EscrowCore internal escrow;
    MockERC20 internal dot;

    address internal poster = address(0xA11CE);
    address internal worker = address(0xB0B);
    address internal verifier = address(0xCAFE);
    address internal arbitrator = address(0xDADA);

    uint256 internal constant POSTER_DEPOSIT = 5_000 ether;
    uint256 internal constant WORKER_DEPOSIT = 200 ether;
    bytes32 internal constant SPEC_HASH = bytes32("SPEC_HASH");
    bytes32 internal constant REASONING_HASH = bytes32("REASONING_HASH");

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        escrow = new EscrowCore(policy, accounts, reputation);
        dot = new MockERC20("Mock DOT", "mDOT");

        policy.setApprovedAsset(address(dot), true);
        policy.setServiceOperator(address(escrow), true);
        policy.setServiceOperator(address(accounts), true);
        policy.setServiceOperator(address(this), true);
        policy.setVerifier(verifier, true);
        policy.setArbitrator(arbitrator, true);
        policy.setDailyOutflowCap(type(uint256).max);
        policy.setPerAccountBorrowCap(1_000 ether);

        dot.mint(poster, 10_000 ether);
        dot.mint(worker, 1_000 ether);

        vm.startPrank(poster);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), POSTER_DEPOSIT);
        vm.stopPrank();

        vm.startPrank(worker);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), WORKER_DEPOSIT);
        vm.stopPrank();
    }

    function testSinglePayoutFlowLocksAndReleasesClaimStake() public {
        bytes32 jobId = keccak256("job/single/1");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 100 ether, 10 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("CODING"), SPEC_HASH);

        uint256 startingWorkerBalance = dot.balanceOf(worker);

        vm.prank(worker);
        escrow.claimJob(jobId);

        (uint256 liquidAfterClaim,,,, uint256 jobStakeAfterClaim,) = accounts.positions(worker, address(dot));
        assertEq(liquidAfterClaim, WORKER_DEPOSIT - 5 ether);
        assertEq(jobStakeAfterClaim, 5 ether);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "ipfs://badge/coding", REASONING_HASH);

        (uint256 posterLiquid, uint256 posterReserved,,,,) = accounts.positions(poster, address(dot));
        (uint256 workerLiquid,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));

        assertEq(posterLiquid, POSTER_DEPOSIT - 100 ether);
        assertEq(posterReserved, 0);
        assertEq(workerLiquid, WORKER_DEPOSIT);
        assertEq(workerJobStake, 0);
        assertEq(dot.balanceOf(worker), startingWorkerBalance + 100 ether);
        assertEq(reputation.balanceOf(worker), 1);
    }

    function testBorrowCapacityAndRepayment() public {
        vm.startPrank(worker);
        accounts.lockCollateral(address(dot), 150 ether);

        uint256 capacity = accounts.getBorrowCapacity(worker, address(dot));
        assertEq(capacity, 100 ether);

        accounts.borrow(address(dot), 100 ether);
        (, , , uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding) = accounts.positions(worker, address(dot));
        assertEq(collateralLocked, 150 ether);
        assertEq(jobStakeLocked, 0);
        assertEq(debtOutstanding, 100 ether);

        dot.mint(worker, 100 ether);
        accounts.repay(address(dot), 100 ether);
        (, , , , , debtOutstanding) = accounts.positions(worker, address(dot));
        assertEq(debtOutstanding, 0);
        vm.stopPrank();
    }

    function testStrategyAllocationSettlesIntoAdapterAndUnwindsWithYield() public {
        bytes32 strategyId = bytes32("VDOT_V1_MOCK");
        MockVDotAdapter adapter = new MockVDotAdapter(policy, address(dot), strategyId);
        policy.setApprovedStrategy(address(adapter), true);
        registry.registerStrategy(address(adapter));

        vm.prank(worker);
        accounts.allocateIdleFunds(worker, strategyId, 20 ether);

        (uint256 liquidAfterAllocate,, uint256 allocatedAfterAllocate,,,) = accounts.positions(worker, address(dot));
        assertEq(liquidAfterAllocate, WORKER_DEPOSIT - 20 ether);
        assertEq(allocatedAfterAllocate, 20 ether);
        assertEq(accounts.strategyShares(worker, strategyId), 20 ether);
        assertEq(dot.balanceOf(address(accounts)), POSTER_DEPOSIT + WORKER_DEPOSIT - 20 ether);
        assertEq(dot.balanceOf(address(adapter)), 20 ether);

        dot.mint(address(adapter), 1 ether);
        adapter.simulateYieldBps(500);

        vm.prank(worker);
        accounts.deallocateIdleFunds(worker, strategyId, 21 ether);

        (uint256 liquidAfterDeallocate,, uint256 allocatedAfterDeallocate,,,) = accounts.positions(worker, address(dot));
        assertEq(liquidAfterDeallocate, WORKER_DEPOSIT + 1 ether);
        assertEq(allocatedAfterDeallocate, 0);
        assertEq(accounts.strategyShares(worker, strategyId), 0);
        assertEq(dot.balanceOf(address(accounts)), POSTER_DEPOSIT + WORKER_DEPOSIT + 1 ether);
        assertEq(dot.balanceOf(address(adapter)), 0);
    }

    function testClaimTimeoutReopensJobAndSlashesStake() public {
        bytes32 jobId = keccak256("job/timeout/1");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH);

        uint256 posterBalanceBefore = dot.balanceOf(poster);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.warp(block.timestamp + 2 days);
        escrow.handleClaimTimeout(jobId);

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);

        (uint256 workerLiquid,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));

        assertEq(job.worker, address(0));
        assertEq(job.claimExpiry, 0);
        assertEq(job.claimStake, 0);
        assertEq(uint256(job.state), uint256(EscrowCore.JobState.Open));
        assertEq(workerLiquid, WORKER_DEPOSIT - 2.5 ether);
        assertEq(workerJobStake, 0);
        assertEq(dot.balanceOf(poster), posterBalanceBefore + 1.25 ether);
    }

    function testReclaimedJobGetsFreshClaimExpiry() public {
        bytes32 jobId = keccak256("job/timeout/2");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.warp(block.timestamp + 2 days);
        escrow.handleClaimTimeout(jobId);

        address replacementWorker = address(0xBEEF);
        dot.mint(replacementWorker, 50 ether);
        vm.startPrank(replacementWorker);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), 50 ether);
        escrow.claimJob(jobId);
        vm.stopPrank();

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);

        assertEq(job.worker, replacementWorker);
        assertEq(job.claimExpiry, block.timestamp + 1 days);
        assertEq(job.claimStake, 2.5 ether);
        assertEq(job.claimStakeBps, 500);
        assertEq(uint256(job.state), uint256(EscrowCore.JobState.Claimed));
    }

    function testMilestoneResolutionRefreshesClaimExpiryForNextStageWithoutReleasingStake() public {
        bytes32 jobId = keccak256("job/milestone/refresh");
        uint256[] memory milestones = new uint256[](2);
        milestones[0] = 25 ether;
        milestones[1] = 25 ether;

        vm.prank(poster);
        escrow.createMilestoneJob(jobId, address(dot), milestones, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.warp(block.timestamp + 12 hours);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("milestone-work"));

        vm.prank(verifier);
        escrow.resolveMilestone(jobId, 0, true, bytes32("OK"), "ipfs://badge/milestone", REASONING_HASH);

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);

        (, , , , uint256 workerJobStake,) = accounts.positions(worker, address(dot));

        assertEq(job.worker, worker);
        assertEq(job.claimExpiry, block.timestamp + 1 days);
        assertEq(job.claimStake, 2.5 ether);
        assertEq(workerJobStake, 2.5 ether);
        assertEq(uint256(job.state), uint256(EscrowCore.JobState.Claimed));
    }

    function testRejectedJobCanBeFinalizedAfterDisputeWindowAndThenSlashesReputation() public {
        bytes32 jobId = keccak256("job/rejected/finalize");

        reputation.updateReputation(worker, 100, 100, 0);

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH);

        uint256 posterBalanceBefore = dot.balanceOf(poster);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("rejected-work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected", REASONING_HASH);

        (, , , , uint256 workerJobStakeBeforeFinalize,) = accounts.positions(worker, address(dot));
        (uint256 skillBefore, uint256 reliabilityBefore,) = reputation.reputations(worker);
        assertEq(workerJobStakeBeforeFinalize, 2.5 ether);
        assertEq(skillBefore, 100);
        assertEq(reliabilityBefore, 100);

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        escrow.finalizeRejectedJob(jobId);

        (uint256 liquidPoster, uint256 reservedPoster,,,,) = accounts.positions(poster, address(dot));
        (, , , , uint256 workerJobStakeAfterFinalize,) = accounts.positions(worker, address(dot));
        (uint256 skillAfter, uint256 reliabilityAfter,) = reputation.reputations(worker);

        assertEq(liquidPoster, POSTER_DEPOSIT);
        assertEq(reservedPoster, 0);
        assertEq(workerJobStakeAfterFinalize, 0);
        assertEq(dot.balanceOf(poster), posterBalanceBefore + 1.25 ether);
        assertEq(skillAfter, 90);
        assertEq(reliabilityAfter, 80);
    }

    function testRejectedJobCannotBeFinalizedAfterDisputeOpenedAndDoesNotSlashEarly() public {
        bytes32 jobId = keccak256("job/rejected/disputed");

        reputation.updateReputation(worker, 100, 100, 0);

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("rejected-work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected", REASONING_HASH);

        vm.prank(worker);
        escrow.openDispute(jobId);

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        (bool finalizedDisputed,) = address(escrow).call(abi.encodeCall(escrow.finalizeRejectedJob, (jobId)));
        require(!finalizedDisputed, "EXPECTED_INVALID_STATE_REVERT");

        (, , , , uint256 workerJobStake,) = accounts.positions(worker, address(dot));
        (uint256 skillAfter, uint256 reliabilityAfter,) = reputation.reputations(worker);

        assertEq(workerJobStake, 2.5 ether);
        assertEq(skillAfter, 100);
        assertEq(reliabilityAfter, 100);
    }

    function testResolveDisputeAgainstWorkerSlashesStakeAndReputation() public {
        bytes32 jobId = keccak256("job/dispute/loss");

        reputation.updateReputation(worker, 100, 100, 0);

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH);

        uint256 posterBalanceBefore = dot.balanceOf(poster);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("contested-work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected", REASONING_HASH);

        vm.prank(worker);
        escrow.openDispute(jobId);

        vm.prank(arbitrator);
        escrow.resolveDispute(jobId, 0, bytes32("DISPUTE_LOSS"), "ipfs://badge/dispute");

        (, , , , uint256 workerJobStake,) = accounts.positions(worker, address(dot));
        (uint256 liquidPoster, uint256 reservedPoster,,,,) = accounts.positions(poster, address(dot));
        (uint256 skillAfter, uint256 reliabilityAfter,) = reputation.reputations(worker);

        assertEq(workerJobStake, 0);
        assertEq(liquidPoster, POSTER_DEPOSIT);
        assertEq(reservedPoster, 0);
        assertEq(dot.balanceOf(poster), posterBalanceBefore + 1.25 ether);
        assertEq(skillAfter, 70);
        assertEq(reliabilityAfter, 50);
    }

    function testSlashReputationSaturatesAtZero() public {
        reputation.updateReputation(worker, 5, 3, 1);
        reputation.slashReputation(worker, 10, 10, 10, bytes32("SATURATE"));

        (uint256 skill, uint256 reliability, uint256 economic) = reputation.reputations(worker);
        assertEq(skill, 0);
        assertEq(reliability, 0);
        assertEq(economic, 0);
    }

    function testSlashReputationRequiresOperator() public {
        vm.prank(worker);
        (bool ok,) = address(reputation).call(
            abi.encodeCall(reputation.slashReputation, (worker, 1, 1, 0, bytes32("NOPE")))
        );
        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
    }
}
