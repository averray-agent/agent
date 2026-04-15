// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";

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
        accounts.deposit(address(dot), 5_000 ether);
        vm.stopPrank();
    }

    function testSinglePayoutFlowMintsReputationAndSettles() public {
        bytes32 jobId = keccak256("job/single/1");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 100 ether, 10 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("CODING"));

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "ipfs://badge/coding");

        (uint256 liquidPoster, uint256 reservedPoster,,,) = accounts.positions(poster, address(dot));
        assertEq(liquidPoster, 4_900 ether);
        assertEq(reservedPoster, 0);
        assertEq(dot.balanceOf(worker), 1_100 ether);
        assertEq(reputation.balanceOf(worker), 1);
    }

    function testBorrowCapacityAndRepayment() public {
        vm.startPrank(worker);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), 500 ether);
        accounts.lockCollateral(address(dot), 300 ether);

        uint256 capacity = accounts.getBorrowCapacity(worker, address(dot));
        assertEq(capacity, 200 ether);

        accounts.borrow(address(dot), 150 ether);
        (, , , uint256 collateralLocked, uint256 debtOutstanding) = accounts.positions(worker, address(dot));
        assertEq(collateralLocked, 300 ether);
        assertEq(debtOutstanding, 150 ether);

        dot.mint(worker, 150 ether);
        accounts.repay(address(dot), 150 ether);
        (, , , , debtOutstanding) = accounts.positions(worker, address(dot));
        assertEq(debtOutstanding, 0);
        vm.stopPrank();
    }

    function testClaimTimeoutReopensJob() public {
        bytes32 jobId = keccak256("job/timeout/1");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"));

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.warp(block.timestamp + 2 days);
        escrow.handleClaimTimeout(jobId);

        (
            ,
            address assignedWorker,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            EscrowCore.JobState state
        ) = escrow.jobs(jobId);
        assertEq(assignedWorker, address(0));
        assertEq(uint256(state), uint256(EscrowCore.JobState.Open));
    }

    function testReclaimedJobGetsFreshClaimExpiry() public {
        bytes32 jobId = keccak256("job/timeout/2");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"));

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.warp(block.timestamp + 2 days);
        escrow.handleClaimTimeout(jobId);

        address replacementWorker = address(0xBEEF);
        vm.prank(replacementWorker);
        escrow.claimJob(jobId);

        (
            ,
            address assignedWorker,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 claimExpiry,
            ,
            EscrowCore.JobState state
        ) = escrow.jobs(jobId);

        assertEq(assignedWorker, replacementWorker);
        assertEq(claimExpiry, block.timestamp + 1 days);
        assertEq(uint256(state), uint256(EscrowCore.JobState.Claimed));
    }

    function testMilestoneResolutionRefreshesClaimExpiryForNextStage() public {
        bytes32 jobId = keccak256("job/milestone/refresh");
        uint256[] memory milestones = new uint256[](2);
        milestones[0] = 25 ether;
        milestones[1] = 25 ether;

        vm.prank(poster);
        escrow.createMilestoneJob(jobId, address(dot), milestones, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"));

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.warp(block.timestamp + 12 hours);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("milestone-work"));

        vm.prank(verifier);
        escrow.resolveMilestone(jobId, 0, true, bytes32("OK"), "ipfs://badge/milestone");

        (
            ,
            address assignedWorker,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 claimExpiry,
            ,
            EscrowCore.JobState state
        ) = escrow.jobs(jobId);

        assertEq(assignedWorker, worker);
        assertEq(claimExpiry, block.timestamp + 1 days);
        assertEq(uint256(state), uint256(EscrowCore.JobState.Claimed));
    }

    function testRejectedJobCanBeFinalizedAfterDisputeWindow() public {
        bytes32 jobId = keccak256("job/rejected/finalize");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"));

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("rejected-work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected");

        (bool finalizedEarly,) = address(escrow).call(abi.encodeCall(escrow.finalizeRejectedJob, (jobId)));
        require(!finalizedEarly, "EXPECTED_DISPUTE_WINDOW_REVERT");

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        escrow.finalizeRejectedJob(jobId);

        (uint256 liquidPoster, uint256 reservedPoster,,,) = accounts.positions(poster, address(dot));
        assertEq(liquidPoster, 5_000 ether);
        assertEq(reservedPoster, 0);

        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 claimExpiry,
            ,
            EscrowCore.JobState state
        ) = escrow.jobs(jobId);
        assertEq(claimExpiry, 0);
        assertEq(uint256(state), uint256(EscrowCore.JobState.Closed));
    }

    function testRejectedJobCannotBeFinalizedAfterDisputeOpened() public {
        bytes32 jobId = keccak256("job/rejected/disputed");

        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 50 ether, 5 ether, 5 ether, 1 days, bytes32("AUTO"), bytes32("DATA"));

        vm.prank(worker);
        escrow.claimJob(jobId);

        vm.prank(worker);
        escrow.submitWork(jobId, keccak256("rejected-work"));

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "ipfs://badge/rejected");

        vm.prank(worker);
        escrow.openDispute(jobId);

        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        (bool finalizedDisputed,) = address(escrow).call(abi.encodeCall(escrow.finalizeRejectedJob, (jobId)));
        require(!finalizedDisputed, "EXPECTED_INVALID_STATE_REVERT");
    }
}
