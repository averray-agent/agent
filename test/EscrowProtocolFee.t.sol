// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";

contract EscrowProtocolFeeTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    EscrowCore internal escrow;
    MockERC20 internal token;

    address internal poster = address(0xA11CE);
    address internal worker = address(0xB0B);
    address internal verifier = address(0xCAFE);
    address internal arbitrator = address(0xDADA);
    address internal treasury = address(0x7E45);
    address internal nextTreasury = address(0x7E46);
    address internal outsider = address(0xBAD);

    uint256 internal constant POSTER_DEPOSIT = 5_000 ether;
    uint256 internal constant WORKER_DEPOSIT = 200 ether;
    bytes32 internal constant SPEC_HASH = bytes32("SPEC_HASH");
    bytes32 internal constant REASONING_HASH = bytes32("REASONING_HASH");

    event SettlementSplit(
        bytes32 indexed jobId,
        address indexed worker,
        address indexed treasuryAccount,
        address asset,
        uint256 workerAmount,
        uint256 protocolFeeAmount,
        uint16 protocolFeeBps
    );

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        escrow = new EscrowCore(policy, accounts, reputation, treasury);
        token = new MockERC20("Mock Asset", "MOCK");

        policy.setApprovedAsset(address(token), true);
        policy.setSettlementBroker(address(escrow), true);
        policy.setReputationWriter(address(escrow), true);
        policy.setSettlementBroker(poster, true);
        policy.setVerifier(verifier, true);
        policy.setArbitrator(arbitrator, true);
        policy.setDefaultClaimStakeBps(0);
        policy.setClaimFeeBps(0);
        accounts.setEscrowOperator(address(escrow), true);

        token.mint(poster, POSTER_DEPOSIT);
        token.mint(worker, WORKER_DEPOSIT);

        vm.startPrank(poster);
        token.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(token), POSTER_DEPOSIT);
        vm.stopPrank();

        vm.startPrank(worker);
        token.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(token), WORKER_DEPOSIT);
        vm.stopPrank();
    }

    function testProtocolFeeDefaultsToZeroAndPreservesV1Economics() public {
        bytes32 jobId = keccak256("fee/default-zero");
        _createSingle(jobId, 100 ether);

        EscrowCore.JobEscrow memory funded = escrow.jobs(jobId);
        (, uint256 posterReserved,,,,) = accounts.positions(poster, address(token));
        assertEq(escrow.protocolFeeBps(), 0);
        assertEq(escrow.previewProtocolFee(100 ether), 0);
        assertEq(funded.protocolFee, 0);
        assertEq(funded.protocolFeeBps, 0);
        assertEq(posterReserved, 100 ether);

        _approveSingle(jobId);

        (uint256 workerLiquid,,,,,) = accounts.positions(worker, address(token));
        (uint256 treasuryLiquid,,,,,) = accounts.positions(treasury, address(token));
        assertEq(workerLiquid, WORKER_DEPOSIT + 100 ether);
        assertEq(treasuryLiquid, 0);
    }

    function testSuccessfulSinglePayoutReservesFeeOnTopAndKeepsWorkerRewardWhole() public {
        escrow.setProtocolFeeBps(1_000);
        bytes32 jobId = keccak256("fee/success");
        _createSingle(jobId, 100 ether);

        EscrowCore.JobEscrow memory funded = escrow.jobs(jobId);
        (uint256 posterLiquid, uint256 posterReserved,,,,) = accounts.positions(poster, address(token));
        assertEq(funded.reward, 100 ether);
        assertEq(funded.protocolFee, 10 ether);
        assertEq(funded.protocolFeeBps, 1_000);
        assertEq(posterLiquid, POSTER_DEPOSIT - 110 ether);
        assertEq(posterReserved, 110 ether);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit SettlementSplit(jobId, worker, treasury, address(token), 100 ether, 10 ether, 1_000);
        _approveSingle(jobId);

        EscrowCore.JobEscrow memory settled = escrow.jobs(jobId);
        (uint256 workerLiquid,,,,,) = accounts.positions(worker, address(token));
        (uint256 treasuryLiquid,,,,,) = accounts.positions(treasury, address(token));
        (, uint256 reservedAfter,,,,) = accounts.positions(poster, address(token));
        assertEq(workerLiquid, WORKER_DEPOSIT + 100 ether);
        assertEq(treasuryLiquid, 10 ether);
        assertEq(reservedAfter, 0);
        assertEq(settled.released, 100 ether);
        assertEq(settled.protocolFeeReleased, 10 ether);
    }

    function testJobSnapshotsFeeBpsSoLaterGovernanceChangeCannotRepriceIt() public {
        escrow.setProtocolFeeBps(500);
        bytes32 jobId = keccak256("fee/snapshot");
        _createSingle(jobId, 100 ether);

        escrow.setProtocolFeeBps(1_000);
        _approveSingle(jobId);

        EscrowCore.JobEscrow memory settled = escrow.jobs(jobId);
        (uint256 treasuryLiquid,,,,,) = accounts.positions(treasury, address(token));
        assertEq(settled.protocolFeeBps, 500);
        assertEq(settled.protocolFee, 5 ether);
        assertEq(settled.protocolFeeReleased, 5 ether);
        assertEq(treasuryLiquid, 5 ether);
    }

    function testRejectedJobRefundsEntireProtocolFeeToPoster() public {
        escrow.setProtocolFeeBps(1_000);
        bytes32 jobId = keccak256("fee/rejected");
        _createSingle(jobId, 100 ether);
        _submitSingle(jobId);

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "", REASONING_HASH);
        vm.warp(block.timestamp + escrow.DISPUTE_WINDOW() + 1);
        escrow.finalizeRejectedJob(jobId);

        EscrowCore.JobEscrow memory settled = escrow.jobs(jobId);
        (uint256 posterLiquid, uint256 posterReserved,,,,) = accounts.positions(poster, address(token));
        (uint256 treasuryLiquid,,,,,) = accounts.positions(treasury, address(token));
        assertEq(posterLiquid, POSTER_DEPOSIT);
        assertEq(posterReserved, 0);
        assertEq(treasuryLiquid, 0);
        assertEq(settled.protocolFeeReleased, 0);
    }

    function testDisputePayoutChargesOnlyProportionalSuccessFeeAndRefundsRemainder() public {
        escrow.setProtocolFeeBps(1_000);
        bytes32 jobId = keccak256("fee/dispute-partial");
        _createSingle(jobId, 100 ether);
        _submitSingle(jobId);

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, false, bytes32("REJECTED"), "", REASONING_HASH);
        vm.prank(worker);
        escrow.openDispute(jobId);
        vm.prank(arbitrator);
        escrow.resolveDispute(jobId, 40 ether, bytes32("SPLIT"), "");

        EscrowCore.JobEscrow memory settled = escrow.jobs(jobId);
        (uint256 posterLiquid, uint256 posterReserved,,,,) = accounts.positions(poster, address(token));
        (uint256 workerLiquid,,,,,) = accounts.positions(worker, address(token));
        (uint256 treasuryLiquid,,,,,) = accounts.positions(treasury, address(token));
        assertEq(workerLiquid, WORKER_DEPOSIT + 40 ether);
        assertEq(treasuryLiquid, 4 ether);
        assertEq(posterLiquid, POSTER_DEPOSIT - 44 ether);
        assertEq(posterReserved, 0);
        assertEq(settled.protocolFeeReleased, 4 ether);
    }

    function testExplicitCuratedWaiverDoesNotReserveOrSettleProtocolFee() public {
        escrow.setProtocolFeeBps(1_000);
        bytes32 jobId = keccak256("fee/curated-waiver");

        vm.prank(poster);
        escrow.createSinglePayoutJobFeeWaived(
            jobId,
            address(token),
            100 ether,
            0,
            0,
            1 days,
            bytes32("AUTO"),
            bytes32("STARTER"),
            SPEC_HASH
        );

        EscrowCore.JobEscrow memory funded = escrow.jobs(jobId);
        (, uint256 posterReserved,,,,) = accounts.positions(poster, address(token));
        require(funded.protocolFeeWaived, "EXPECTED_PROTOCOL_FEE_WAIVER");
        assertEq(funded.protocolFee, 0);
        assertEq(funded.protocolFeeBps, 0);
        assertEq(posterReserved, 100 ether);

        _approveSingle(jobId);
        (uint256 workerLiquid,,,,,) = accounts.positions(worker, address(token));
        (uint256 treasuryLiquid,,,,,) = accounts.positions(treasury, address(token));
        assertEq(workerLiquid, WORKER_DEPOSIT + 100 ether);
        assertEq(treasuryLiquid, 0);
    }

    function testCuratedWaiverRequiresSettlementBroker() public {
        vm.prank(outsider);
        vm.expectRevert(EscrowCore.Unauthorized.selector);
        escrow.createSinglePayoutJobFeeWaived(
            keccak256("fee/unauthorized-waiver"),
            address(token),
            100 ether,
            0,
            0,
            1 days,
            bytes32("AUTO"),
            bytes32("STARTER"),
            SPEC_HASH
        );
    }

    function testProtocolFeeGovernanceUsesPolicyOwnerAndEnforcesCapAndTreasury() public {
        assertEq(escrow.MAX_PROTOCOL_FEE_BPS(), 1_000);

        vm.prank(outsider);
        vm.expectRevert(EscrowCore.Unauthorized.selector);
        escrow.setProtocolFeeBps(100);

        vm.expectRevert(EscrowCore.ProtocolFeeTooHigh.selector);
        escrow.setProtocolFeeBps(1_001);

        vm.expectRevert(EscrowCore.InvalidTreasuryAccount.selector);
        escrow.setTreasuryAccount(address(0));

        escrow.setProtocolFeeBps(1_000);
        escrow.setTreasuryAccount(nextTreasury);
        assertEq(escrow.protocolFeeBps(), 1_000);
        assertEq(escrow.treasuryAccount(), nextTreasury);
    }

    function testTreasuryDestinationIsReadAtSettlementWhilePriceStaysSnapshotted() public {
        escrow.setProtocolFeeBps(1_000);
        bytes32 jobId = keccak256("fee/treasury-rotation");
        _createSingle(jobId, 100 ether);
        escrow.setTreasuryAccount(nextTreasury);
        _approveSingle(jobId);

        (uint256 oldTreasuryLiquid,,,,,) = accounts.positions(treasury, address(token));
        (uint256 nextTreasuryLiquid,,,,,) = accounts.positions(nextTreasury, address(token));
        assertEq(oldTreasuryLiquid, 0);
        assertEq(nextTreasuryLiquid, 10 ether);
    }

    function _createSingle(bytes32 jobId, uint256 reward) internal {
        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId, address(token), reward, 0, 0, 1 days, bytes32("AUTO"), bytes32("CODING"), SPEC_HASH
        );
    }

    function _submitSingle(bytes32 jobId) internal {
        vm.prank(worker);
        escrow.claimJob(jobId);
        vm.prank(worker);
        escrow.submitWork(jobId, keccak256(abi.encode(jobId, "work")));
    }

    function _approveSingle(bytes32 jobId) internal {
        _submitSingle(jobId);
        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "", REASONING_HASH);
    }
}
