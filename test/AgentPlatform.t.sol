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
        policy.setOnboardingWaiverClaimCount(0);
        policy.setClaimFeeBps(0);

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
        escrow.createSinglePayoutJob(
            jobId, address(dot), 100 ether, 10 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("CODING"), SPEC_HASH
        );

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

    function testRecurringTemplateReserveFundsDerivativeWithoutFreshPosterLiquid() public {
        bytes32 templateId = keccak256("template/weekly/1");
        bytes32 jobId = keccak256("template/weekly/1/run/1");

        vm.prank(poster);
        accounts.reserveForRecurringTemplate(poster, address(dot), templateId, 10 ether);

        (uint256 liquidAfterTemplateReserve, uint256 reservedAfterTemplateReserve,,,,) =
            accounts.positions(poster, address(dot));
        assertEq(liquidAfterTemplateReserve, POSTER_DEPOSIT - 10 ether);
        assertEq(reservedAfterTemplateReserve, 10 ether);
        assertEq(accounts.recurringTemplateReserves(poster, address(dot), templateId), 10 ether);

        escrow.createSinglePayoutJobFromRecurringReserve(
            EscrowCore.RecurringSinglePayoutJob({
                jobId: jobId,
                templateId: templateId,
                poster: poster,
                asset: address(dot),
                reward: 5 ether,
                opsReserve: 0,
                contingencyReserve: 0,
                claimTtl: 1 days,
                verifierMode: bytes32("AUTO"),
                category: bytes32("CODING"),
                specHash: SPEC_HASH
            })
        );

        assertEq(accounts.recurringTemplateReserves(poster, address(dot), templateId), 5 ether);
        (uint256 liquidAfterDerivative, uint256 reservedAfterDerivative,,,,) = accounts.positions(poster, address(dot));
        assertEq(liquidAfterDerivative, POSTER_DEPOSIT - 10 ether);
        assertEq(reservedAfterDerivative, 10 ether);

        vm.prank(worker);
        escrow.claimJob(jobId);
        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("work"));
        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "ipfs://badge/recurring", REASONING_HASH);

        (uint256 liquidAfterClose, uint256 reservedAfterClose,,,,) = accounts.positions(poster, address(dot));
        assertEq(liquidAfterClose, POSTER_DEPOSIT - 10 ether);
        assertEq(reservedAfterClose, 5 ether);
        assertEq(dot.balanceOf(worker), 1_000 ether - WORKER_DEPOSIT + 5 ether);
    }

    function testOnboardingWaivesFirstThreeClaimsThenLocksStakeAndFee() public {
        policy.setOnboardingWaiverClaimCount(3);
        policy.setClaimFeeBps(200);
        policy.setMinClaimFee(address(dot), 0.05 ether);

        for (uint256 i = 0; i < 3; i++) {
            bytes32 jobId = keccak256(abi.encodePacked("job/onboarding/free", i));
            vm.prank(poster);
            escrow.createSinglePayoutJob(
                jobId, address(dot), 50 ether, 0, 0, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
            );

            vm.prank(worker);
            escrow.claimJob(jobId);

            EscrowCore.JobEscrow memory claimedJob = escrow.jobs(jobId);
            assertEq(claimedJob.claimStake, 0);
            assertEq(claimedJob.claimFee, 0);
            require(claimedJob.claimEconomicsWaived, "EXPECTED_WAIVER");

            vm.prank(worker);
            escrow.submitWork(jobId, keccak256(abi.encodePacked("work", i)));
            vm.prank(verifier);
            escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "ipfs://badge/free", REASONING_HASH);
        }

        bytes32 paidJobId = keccak256("job/onboarding/paid");
        vm.prank(poster);
        escrow.createSinglePayoutJob(
            paidJobId, address(dot), 50 ether, 0, 0, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

        vm.prank(worker);
        escrow.claimJob(paidJobId);

        EscrowCore.JobEscrow memory paidJob = escrow.jobs(paidJobId);
        (,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));

        assertEq(escrow.workerClaimCount(worker), 4);
        assertEq(paidJob.claimStake, 2.5 ether);
        assertEq(paidJob.claimFee, 1 ether);
        require(!paidJob.claimEconomicsWaived, "EXPECTED_NO_WAIVER");
        assertEq(workerJobStake, 3.5 ether);
    }

    function testSuccessfulVerificationRefundsClaimStakeAndFee() public {
        policy.setClaimFeeBps(200);
        policy.setMinClaimFee(address(dot), 0.05 ether);

        bytes32 jobId = keccak256("job/fee/success");
        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId, address(dot), 50 ether, 0, 0, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

        vm.prank(worker);
        escrow.claimJob(jobId);

        (,,,, uint256 lockedAfterClaim,) = accounts.positions(worker, address(dot));
        assertEq(lockedAfterClaim, 3.5 ether);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("fee-success"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "ipfs://badge/fee-success", REASONING_HASH);

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);
        (uint256 workerLiquid,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));
        assertEq(job.claimStake, 0);
        assertEq(job.claimFee, 0);
        assertEq(workerLiquid, WORKER_DEPOSIT);
        assertEq(workerJobStake, 0);
    }

    function testRejectedJobSlashesClaimFeeToVerifierAndTreasurySplit() public {
        policy.setClaimFeeBps(200);
        policy.setMinClaimFee(address(dot), 0.05 ether);

        bytes32 jobId = keccak256("job/fee/rejected");
        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId, address(dot), 50 ether, 0, 0, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

        uint256 posterBalanceBefore = dot.balanceOf(poster);
        uint256 verifierBalanceBefore = dot.balanceOf(verifier);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("fee-rejected"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected", REASONING_HASH);

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        escrow.finalizeRejectedJob(jobId);

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);
        (,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));

        assertEq(job.claimStake, 0);
        assertEq(job.claimFee, 0);
        assertEq(workerJobStake, 0);
        assertEq(dot.balanceOf(poster), posterBalanceBefore + 1.25 ether);
        assertEq(dot.balanceOf(verifier), verifierBalanceBefore + 0.7 ether);
    }

    function testBorrowCapacityAndRepayment() public {
        vm.startPrank(worker);
        accounts.lockCollateral(address(dot), 150 ether);

        uint256 capacity = accounts.getBorrowCapacity(worker, address(dot));
        assertEq(capacity, 100 ether);

        accounts.borrow(address(dot), 100 ether);
        (,,, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding) =
            accounts.positions(worker, address(dot));
        assertEq(collateralLocked, 150 ether);
        assertEq(jobStakeLocked, 0);
        assertEq(debtOutstanding, 100 ether);

        dot.mint(worker, 100 ether);
        accounts.repay(address(dot), 100 ether);
        (,,,,, debtOutstanding) = accounts.positions(worker, address(dot));
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
        escrow.createSinglePayoutJob(
            jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

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
        escrow.createSinglePayoutJob(
            jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

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
        escrow.createMilestoneJob(
            jobId, address(dot), milestones, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.warp(block.timestamp + 12 hours);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("milestone-work"));

        vm.prank(verifier);
        escrow.resolveMilestone(jobId, 0, true, bytes32("OK"), "ipfs://badge/milestone", REASONING_HASH);

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);

        (,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));

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
        escrow.createSinglePayoutJob(
            jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

        uint256 posterBalanceBefore = dot.balanceOf(poster);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("rejected-work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected", REASONING_HASH);

        (,,,, uint256 workerJobStakeBeforeFinalize,) = accounts.positions(worker, address(dot));
        (uint256 skillBefore, uint256 reliabilityBefore,) = reputation.reputations(worker);
        assertEq(workerJobStakeBeforeFinalize, 2.5 ether);
        assertEq(skillBefore, 100);
        assertEq(reliabilityBefore, 100);

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        escrow.finalizeRejectedJob(jobId);

        (uint256 liquidPoster, uint256 reservedPoster,,,,) = accounts.positions(poster, address(dot));
        (,,,, uint256 workerJobStakeAfterFinalize,) = accounts.positions(worker, address(dot));
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
        escrow.createSinglePayoutJob(
            jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("rejected-work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected", REASONING_HASH);

        vm.prank(worker);
        escrow.openDispute(jobId);
        EscrowCore.JobEscrow memory disputedJob = escrow.jobs(jobId);
        assertEq(disputedJob.disputedAt, block.timestamp);

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        (bool finalizedDisputed,) = address(escrow).call(abi.encodeCall(escrow.finalizeRejectedJob, (jobId)));
        require(!finalizedDisputed, "EXPECTED_INVALID_STATE_REVERT");

        (,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));
        (uint256 skillAfter, uint256 reliabilityAfter,) = reputation.reputations(worker);

        assertEq(workerJobStake, 2.5 ether);
        assertEq(skillAfter, 100);
        assertEq(reliabilityAfter, 100);
    }

    function testOpenDisputeRejectsAfterDisputeWindow() public {
        bytes32 jobId = createRejectedSinglePayoutJob("job/rejected/late-dispute", 50 ether);

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);

        vm.prank(worker);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.openDispute, (jobId)));
        require(!ok, "EXPECTED_DISPUTE_WINDOW_REVERT");
    }

    function testResolveDisputeAgainstWorkerSlashesStakeAndReputation() public {
        bytes32 jobId = keccak256("job/dispute/loss");

        reputation.updateReputation(worker, 100, 100, 0);

        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

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

        (,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));
        (uint256 liquidPoster, uint256 reservedPoster,,,,) = accounts.positions(poster, address(dot));
        (uint256 skillAfter, uint256 reliabilityAfter,) = reputation.reputations(worker);

        assertEq(workerJobStake, 0);
        assertEq(liquidPoster, POSTER_DEPOSIT);
        assertEq(reservedPoster, 0);
        assertEq(dot.balanceOf(poster), posterBalanceBefore + 1.25 ether);
        assertEq(skillAfter, 70);
        assertEq(reliabilityAfter, 50);
    }

    function testAutoResolveOnTimeoutRejectsBeforeArbitratorSla() public {
        bytes32 jobId = createRejectedSinglePayoutJob("job/dispute/timeout/early", 50 ether);

        vm.prank(worker);
        escrow.openDispute(jobId);

        vm.warp(block.timestamp + escrow.ARBITRATOR_SLA() - 1);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.autoResolveOnTimeout, (jobId)));
        require(!ok, "EXPECTED_ARBITRATOR_SLA_REVERT");
    }

    function testAutoResolveOnTimeoutPaysWorkerAndReleasesStake() public {
        bytes32 jobId = createRejectedSinglePayoutJob("job/dispute/timeout/success", 50 ether);
        uint256 workerTokenBalanceBefore = dot.balanceOf(worker);

        vm.prank(worker);
        escrow.openDispute(jobId);

        vm.warp(block.timestamp + escrow.ARBITRATOR_SLA());
        escrow.autoResolveOnTimeout(jobId);

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);
        (uint256 liquidPoster, uint256 reservedPoster,,,,) = accounts.positions(poster, address(dot));
        (uint256 liquidWorker,,,, uint256 workerJobStake,) = accounts.positions(worker, address(dot));

        assertEq(uint256(job.state), uint256(EscrowCore.JobState.Closed));
        assertEq(job.released, 50 ether);
        require(job.disputedAt > 0, "EXPECTED_DISPUTED_AT");
        assertEq(liquidPoster, POSTER_DEPOSIT - 50 ether);
        assertEq(reservedPoster, 0);
        assertEq(liquidWorker, WORKER_DEPOSIT);
        assertEq(workerJobStake, 0);
        assertEq(dot.balanceOf(worker), workerTokenBalanceBefore + 50 ether);
        assertEq(reputation.balanceOf(worker), 1);
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
        (bool ok,) =
            address(reputation).call(abi.encodeCall(reputation.slashReputation, (worker, 1, 1, 0, bytes32("NOPE"))));
        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
    }

    function createRejectedSinglePayoutJob(string memory label, uint256 reward) internal returns (bytes32 jobId) {
        jobId = keccak256(bytes(label));

        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId, address(dot), reward, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"), SPEC_HASH
        );

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256(bytes(label)));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected", REASONING_HASH);
    }
}
