// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";

struct EscrowV3Log {
    bytes32[] topics;
    bytes data;
    address emitter;
}

interface EscrowV3Vm {
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (EscrowV3Log[] memory logs);
}

contract EscrowCoreV3Test is Test {
    EscrowV3Vm internal constant v3vm = EscrowV3Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    EscrowCore internal escrow;
    MockERC20 internal usdc;

    address internal poster = address(0xA11CE);
    address internal worker = address(0xB0B);
    address internal verifier = address(0xCAFE);
    address internal arbitrator = address(0xDADA);
    address internal treasury = address(0x7E45);
    address internal outsider = address(0xBAD);

    uint256 internal constant POSTER_DEPOSIT = 100_000_000;
    bytes32 internal constant SPEC_HASH = bytes32("SPEC_HASH");
    bytes32 internal constant REASONING_HASH = bytes32("REASONING_HASH");

    event ClaimRetentionSnapshot(
        bytes32 indexed jobId,
        address indexed worker,
        bool brokered,
        bool waived,
        uint256 retentionFlatRaw,
        uint16 retentionCapBps
    );
    event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry, uint256 claimStake);
    event GasRetentionApplied(bytes32 indexed jobId, address indexed worker, uint256 retainedRaw, uint256 rewardRaw);
    event FeeScheduleChanged(
        uint256 previousRetentionFlatRaw,
        uint16 previousRetentionCapBps,
        uint16 previousPosterFeeBps,
        uint256 previousPosterFeeFloorRaw,
        uint256 newRetentionFlatRaw,
        uint16 newRetentionCapBps,
        uint16 newPosterFeeBps,
        uint256 newPosterFeeFloorRaw
    );
    event JobCancelled(bytes32 indexed jobId, address indexed poster, uint256 refundedRaw);

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        escrow = new EscrowCore(policy, accounts, reputation, treasury);
        usdc = new MockERC20("Mock USDC", "mUSDC");

        policy.setApprovedAsset(address(usdc), true);
        policy.setSettlementBroker(address(escrow), true);
        policy.setReputationWriter(address(escrow), true);
        policy.setSettlementBroker(address(this), true);
        policy.setVerifier(verifier, true);
        policy.setArbitrator(arbitrator, true);
        policy.setDefaultClaimStakeBps(0);
        policy.setClaimFeeBps(0);
        policy.setOnboardingWaiverClaimCount(3);
        accounts.setEscrowOperator(address(escrow), true);

        usdc.mint(poster, POSTER_DEPOSIT);
        vm.startPrank(poster);
        usdc.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(usdc), POSTER_DEPOSIT);
        vm.stopPrank();

        _setRatifiedSchedule();
    }

    function testRatifiedScheduleAndCeilingsAreOnChainConstants() public view {
        assertEq(escrow.retentionFlatRaw(), 50_000);
        assertEq(escrow.retentionCapBps(), 2_000);
        assertEq(escrow.posterFeeBps(), 500);
        assertEq(escrow.posterFeeFloorRaw(), 50_000);
        assertEq(escrow.MAX_RETENTION_FLAT_RAW(), 500_000);
        assertEq(escrow.MAX_RETENTION_CAP_BPS(), 2_500);
        assertEq(escrow.MAX_PROTOCOL_FEE_BPS(), 1_000);
        assertEq(escrow.MAX_POSTER_FEE_FLOOR_RAW(), 500_000);
        require(escrow.supportsGasRetention(), "EXPECTED_V3_RETENTION_CAPABILITY");
        require(!escrow.retainsClaimFeeOnSuccess(), "CLAIM_FEE_RETENTION_MUST_BE_RETIRED");
    }

    function testFeeScheduleEmitsOldAndNewValues() public {
        v3vm.expectEmit(false, false, false, true, address(escrow));
        emit FeeScheduleChanged(50_000, 2_000, 500, 50_000, 75_000, 2_100, 600, 80_000);
        escrow.setFeeSchedule(75_000, 2_100, 600, 80_000);
    }

    function testEveryFeeScheduleKnobRevertsAboveItsCeiling() public {
        v3vm.expectRevert(EscrowCore.RetentionFlatTooHigh.selector);
        escrow.setFeeSchedule(500_001, 2_000, 500, 50_000);

        v3vm.expectRevert(EscrowCore.RetentionCapTooHigh.selector);
        escrow.setFeeSchedule(50_000, 2_501, 500, 50_000);

        v3vm.expectRevert(EscrowCore.ProtocolFeeTooHigh.selector);
        escrow.setFeeSchedule(50_000, 2_000, 1_001, 50_000);

        v3vm.expectRevert(EscrowCore.PosterFeeFloorTooHigh.selector);
        escrow.setFeeSchedule(50_000, 2_000, 500, 500_001);

        vm.prank(outsider);
        v3vm.expectRevert(EscrowCore.Unauthorized.selector);
        escrow.setFeeSchedule(50_000, 2_000, 500, 50_000);
    }

    function testPosterFeeIsMaxOfBpsAndFloorAndSnapshotsAtCreation() public {
        bytes32 dust = keccak256("v3/poster-fee/dust");
        _create(dust, 100_000, 0, 0);
        assertEq(escrow.jobs(dust).protocolFee, 50_000);
        assertEq(escrow.previewPosterFee(100_000), 50_000);

        bytes32 standard = keccak256("v3/poster-fee/standard");
        _create(standard, 2_000_000, 0, 0);
        assertEq(escrow.jobs(standard).protocolFee, 100_000);

        escrow.setFeeSchedule(50_000, 2_000, 1_000, 200_000);
        assertEq(escrow.jobs(dust).protocolFee, 50_000);
        assertEq(escrow.jobs(standard).protocolFee, 100_000);
        assertEq(escrow.previewPosterFee(100_000), 200_000);
    }

    function testBrokeredRetentionDustStandardAndCapBoundary() public {
        _brokerApprove(keccak256("v3/retention/dust"), 100_000);
        assertEq(_workerLiquid(), 80_000);
        assertEq(_treasuryLiquid(), 70_000); // 0.02 retention + 0.05 poster fee

        _brokerApprove(keccak256("v3/retention/standard"), 250_000);
        assertEq(_workerLiquid(), 80_000 + 200_000);
        assertEq(_treasuryLiquid(), 70_000 + 100_000); // 0.05 retention + 0.05 poster fee

        assertEq(escrow.previewGasRetention(249_999, true, false), 49_999);
        assertEq(escrow.previewGasRetention(250_000, true, false), 50_000);
        assertEq(escrow.previewGasRetention(250_001, true, false), 50_000);
    }

    function testBrokeredClaimSnapshotsScheduleAndEmitsLogClassifiableFlag() public {
        bytes32 jobId = keccak256("v3/retention/snapshot");
        _create(jobId, 250_000, 0, 0);

        v3vm.expectEmit(true, true, false, true, address(escrow));
        emit JobClaimed(jobId, worker, block.timestamp + 1 days, 0);
        v3vm.expectEmit(true, true, false, true, address(escrow));
        emit ClaimRetentionSnapshot(jobId, worker, true, false, 50_000, 2_000);
        escrow.claimJobFor(jobId, worker);

        require(escrow.brokeredClaims(jobId), "EXPECTED_BROKERED_SNAPSHOT");
        assertEq(escrow.retentionFlatRawAtClaim(jobId), 50_000);
        assertEq(escrow.retentionCapBpsAtClaim(jobId), 2_000);

        escrow.setFeeSchedule(100_000, 1_000, 500, 50_000);
        escrow.submitWorkFor(jobId, worker, keccak256("work"));
        v3vm.expectEmit(true, true, false, true, address(escrow));
        emit GasRetentionApplied(jobId, worker, 50_000, 250_000);
        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "", REASONING_HASH);
        assertEq(_workerLiquid(), 200_000);
    }

    function testSelfPaidAndWaivedBrokeredClaimsRetainZero() public {
        bytes32 selfPaid = keccak256("v3/retention/self-paid");
        _create(selfPaid, 250_000, 0, 0);
        vm.prank(worker);
        escrow.claimJob(selfPaid);
        require(!escrow.brokeredClaims(selfPaid), "SELF_PAID_MUST_NOT_BE_BROKERED");
        vm.prank(worker);
        escrow.submitWork(selfPaid, keccak256("self-work"));
        vm.prank(verifier);
        escrow.resolveSinglePayout(selfPaid, true, bytes32("OK"), "", REASONING_HASH);
        assertEq(_workerLiquid(), 250_000);

        bytes32 waived = keccak256("v3/retention/waived");
        _create(waived, 250_000, 0, 0);
        escrow.setOnboardingWaiverEligible(waived, true);
        escrow.claimJobFor(waived, worker);
        require(escrow.jobs(waived).claimEconomicsWaived, "EXPECTED_WAIVER_SNAPSHOT");
        escrow.submitWorkFor(waived, worker, keccak256("waived-work"));
        vm.prank(verifier);
        escrow.resolveSinglePayout(waived, true, bytes32("OK"), "", REASONING_HASH);
        assertEq(_workerLiquid(), 500_000);
    }

    function testRejectedDisputedLostTimeoutAndCancelledPathsNeverRetain() public {
        v3vm.recordLogs();
        bytes32 rejected = keccak256("v3/no-retention/rejected");
        _create(rejected, 250_000, 0, 0);
        _brokerSubmit(rejected);
        vm.prank(verifier);
        escrow.resolveSinglePayout(rejected, false, bytes32("REJECTED"), "", REASONING_HASH);
        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        escrow.finalizeRejectedJob(rejected);
        assertEq(_treasuryLiquid(), 0);

        bytes32 disputedLost = keccak256("v3/no-retention/disputed-lost");
        _create(disputedLost, 250_000, 0, 0);
        _brokerSubmit(disputedLost);
        vm.prank(verifier);
        escrow.resolveSinglePayout(disputedLost, false, bytes32("REJECTED"), "", REASONING_HASH);
        vm.prank(worker);
        escrow.openDispute(disputedLost);
        vm.prank(arbitrator);
        escrow.resolveDispute(disputedLost, 0, bytes32("LOST"), "");
        assertEq(_treasuryLiquid(), 0);

        bytes32 timedOut = keccak256("v3/no-retention/timeout");
        _create(timedOut, 250_000, 0, 0);
        escrow.claimJobFor(timedOut, worker);
        vm.warp(escrow.jobs(timedOut).claimExpiry + 1);
        escrow.handleClaimTimeout(timedOut);
        assertEq(_treasuryLiquid(), 0);

        bytes32 cancelled = keccak256("v3/no-retention/cancelled");
        _create(cancelled, 250_000, 0, 0);
        vm.warp(escrow.createdAt(cancelled) + 1 hours);
        vm.prank(poster);
        escrow.cancelOpenJob(cancelled);
        assertEq(_treasuryLiquid(), 0);

        EscrowV3Log[] memory logs = v3vm.getRecordedLogs();
        bytes32 retentionTopic = keccak256("GasRetentionApplied(bytes32,address,uint256,uint256)");
        for (uint256 index = 0; index < logs.length; ++index) {
            require(logs[index].topics[0] != retentionTopic, "NON_PAYOUT_PATH_RETAINED_GAS");
        }
    }

    function testCancelOpenJobRefundsRewardFeeAndReservesExactlyAfterOneHour() public {
        bytes32 jobId = keccak256("v3/cancel/refund");
        _create(jobId, 1_000_000, 100_000, 200_000);
        uint256 expectedRefund = 1_350_000; // reward + 0.05 fee + both reserves

        vm.prank(poster);
        v3vm.expectRevert(bytes("OPEN_FLOOR_ACTIVE"));
        escrow.cancelOpenJob(jobId);

        vm.warp(escrow.createdAt(jobId) + 1 hours);
        v3vm.expectEmit(true, true, false, true, address(escrow));
        emit JobCancelled(jobId, poster, expectedRefund);
        vm.prank(poster);
        escrow.cancelOpenJob(jobId);

        (uint256 liquid, uint256 reserved,,,,) = accounts.positions(poster, address(usdc));
        assertEq(liquid, POSTER_DEPOSIT);
        assertEq(reserved, 0);
        assertEq(uint256(escrow.jobs(jobId).state), uint256(EscrowCore.JobState.Cancelled));
    }

    function testCancelOpenJobRejectsNonPosterAndNonOpenAndClaimWinsRace() public {
        bytes32 jobId = keccak256("v3/cancel/race");
        _create(jobId, 250_000, 0, 0);
        vm.warp(escrow.createdAt(jobId) + 1 hours);

        vm.prank(outsider);
        v3vm.expectRevert(EscrowCore.Unauthorized.selector);
        escrow.cancelOpenJob(jobId);

        escrow.claimJobFor(jobId, worker);
        vm.prank(poster);
        v3vm.expectRevert(EscrowCore.InvalidState.selector);
        escrow.cancelOpenJob(jobId);

        vm.warp(escrow.jobs(jobId).claimExpiry + 1);
        escrow.handleClaimTimeout(jobId);
        vm.prank(poster);
        escrow.cancelOpenJob(jobId);

        vm.prank(poster);
        v3vm.expectRevert(EscrowCore.InvalidState.selector);
        escrow.cancelOpenJob(jobId);
    }

    function _setRatifiedSchedule() internal {
        escrow.setFeeSchedule(50_000, 2_000, 500, 50_000);
    }

    function _create(bytes32 jobId, uint256 reward, uint256 opsReserve, uint256 contingencyReserve) internal {
        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId,
            address(usdc),
            reward,
            opsReserve,
            contingencyReserve,
            1 days,
            bytes32("AUTO"),
            bytes32("CODING"),
            SPEC_HASH
        );
    }

    function _brokerSubmit(bytes32 jobId) internal {
        escrow.claimJobFor(jobId, worker);
        escrow.submitWorkFor(jobId, worker, keccak256(abi.encode(jobId, "work")));
    }

    function _brokerApprove(bytes32 jobId, uint256 reward) internal {
        _create(jobId, reward, 0, 0);
        _brokerSubmit(jobId);
        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "", REASONING_HASH);
    }

    function _workerLiquid() internal view returns (uint256 liquid) {
        (liquid,,,,,) = accounts.positions(worker, address(usdc));
    }

    function _treasuryLiquid() internal view returns (uint256 liquid) {
        (liquid,,,,,) = accounts.positions(treasury, address(usdc));
    }
}
