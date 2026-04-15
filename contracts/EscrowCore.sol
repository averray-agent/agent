// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {AgentAccountCore} from "./AgentAccountCore.sol";
import {ReputationSBT} from "./ReputationSBT.sol";

contract EscrowCore {
    uint256 public constant DISPUTE_WINDOW = 1 days;

    TreasuryPolicy public immutable policy;
    AgentAccountCore public immutable accounts;
    ReputationSBT public immutable reputation;

    enum PayoutMode {
        Single,
        Milestone
    }

    enum JobState {
        None,
        Open,
        Claimed,
        Submitted,
        Rejected,
        Disputed,
        Closed
    }

    struct JobEscrow {
        address poster;
        address worker;
        address asset;
        bytes32 verifierMode;
        bytes32 category;
        uint256 reward;
        uint256 opsReserve;
        uint256 contingencyReserve;
        uint256 released;
        uint256 claimExpiry;
        PayoutMode payoutMode;
        JobState state;
    }

    mapping(bytes32 => JobEscrow) public jobs;
    mapping(bytes32 => uint256[]) public milestoneAmounts;
    mapping(bytes32 => mapping(uint256 => bool)) public milestoneReleased;
    mapping(bytes32 => mapping(bytes32 => bool)) public settlementExecuted;
    mapping(bytes32 => bytes32) public latestEvidence;
    mapping(bytes32 => uint256) public claimTtls;
    mapping(bytes32 => uint256) public rejectionTimestamps;

    event JobFunded(bytes32 indexed jobId, address indexed poster, address indexed asset, uint256 totalReserved, PayoutMode payoutMode);
    event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry);
    event WorkSubmitted(bytes32 indexed jobId, address indexed worker, bytes32 evidenceHash);
    event JobReopened(bytes32 indexed jobId);
    event JobRejected(bytes32 indexed jobId, bytes32 reasonCode);
    event DisputeOpened(bytes32 indexed jobId, address indexed opener);
    event JobClosed(bytes32 indexed jobId, address indexed worker, uint256 releasedAmount);

    error Unauthorized();
    error InvalidState();
    error UnknownJob();

    constructor(TreasuryPolicy policy_, AgentAccountCore accounts_, ReputationSBT reputation_) {
        policy = policy_;
        accounts = accounts_;
        reputation = reputation_;
    }

    modifier onlyVerifier() {
        if (!policy.verifiers(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyArbitrator() {
        if (!policy.arbitrators(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyParticipant(bytes32 jobId) {
        JobEscrow memory job = jobs[jobId];
        if (msg.sender != job.poster && msg.sender != job.worker) revert Unauthorized();
        _;
    }

    function createSinglePayoutJob(
        bytes32 jobId,
        address asset,
        uint256 reward,
        uint256 opsReserve,
        uint256 contingencyReserve,
        uint256 claimTtl,
        bytes32 verifierMode,
        bytes32 category
    ) external {
        if (jobs[jobId].state != JobState.None) revert InvalidState();
        jobs[jobId] = JobEscrow({
            poster: msg.sender,
            worker: address(0),
            asset: asset,
            verifierMode: verifierMode,
            category: category,
            reward: reward,
            opsReserve: opsReserve,
            contingencyReserve: contingencyReserve,
            released: 0,
            claimExpiry: claimTtl,
            payoutMode: PayoutMode.Single,
            state: JobState.Open
        });
        claimTtls[jobId] = claimTtl;

        uint256 total = reward + opsReserve + contingencyReserve;
        accounts.reserveForJob(msg.sender, asset, total);
        emit JobFunded(jobId, msg.sender, asset, total, PayoutMode.Single);
    }

    function createMilestoneJob(
        bytes32 jobId,
        address asset,
        uint256[] calldata milestones,
        uint256 opsReserve,
        uint256 contingencyReserve,
        uint256 claimTtl,
        bytes32 verifierMode,
        bytes32 category
    ) external {
        if (jobs[jobId].state != JobState.None) revert InvalidState();
        uint256 reward;
        for (uint256 i = 0; i < milestones.length; i++) {
            milestoneAmounts[jobId].push(milestones[i]);
            reward += milestones[i];
        }
        jobs[jobId] = JobEscrow({
            poster: msg.sender,
            worker: address(0),
            asset: asset,
            verifierMode: verifierMode,
            category: category,
            reward: reward,
            opsReserve: opsReserve,
            contingencyReserve: contingencyReserve,
            released: 0,
            claimExpiry: claimTtl,
            payoutMode: PayoutMode.Milestone,
            state: JobState.Open
        });
        claimTtls[jobId] = claimTtl;
        uint256 total = reward + opsReserve + contingencyReserve;
        accounts.reserveForJob(msg.sender, asset, total);
        emit JobFunded(jobId, msg.sender, asset, total, PayoutMode.Milestone);
    }

    function claimJob(bytes32 jobId) external {
        JobEscrow storage job = jobs[jobId];
        if (job.state == JobState.None) revert UnknownJob();
        if (job.state != JobState.Open) revert InvalidState();
        job.worker = msg.sender;
        job.claimExpiry = block.timestamp + claimTtls[jobId];
        job.state = JobState.Claimed;
        emit JobClaimed(jobId, msg.sender, job.claimExpiry);
    }

    function submitWork(bytes32 jobId, bytes32 evidenceHash) external {
        JobEscrow storage job = jobs[jobId];
        if (job.state != JobState.Claimed) revert InvalidState();
        if (msg.sender != job.worker) revert Unauthorized();
        latestEvidence[jobId] = evidenceHash;
        job.state = JobState.Submitted;
        emit WorkSubmitted(jobId, msg.sender, evidenceHash);
    }

    function handleClaimTimeout(bytes32 jobId) external {
        JobEscrow storage job = jobs[jobId];
        if (job.state != JobState.Claimed) revert InvalidState();
        require(block.timestamp > job.claimExpiry, "NOT_EXPIRED");
        job.worker = address(0);
        job.claimExpiry = 0;
        job.state = JobState.Open;
        emit JobReopened(jobId);
    }

    function resolveSinglePayout(bytes32 jobId, bool approved, bytes32 reasonCode, string calldata metadataURI) external onlyVerifier {
        JobEscrow storage job = jobs[jobId];
        if (job.state != JobState.Submitted || job.payoutMode != PayoutMode.Single) revert InvalidState();

        if (!approved) {
            job.state = JobState.Rejected;
            rejectionTimestamps[jobId] = block.timestamp;
            emit JobRejected(jobId, reasonCode);
            return;
        }

        bytes32 settlementKey = keccak256(abi.encode(jobId, uint256(0), job.reward));
        require(!settlementExecuted[jobId][settlementKey], "SETTLED");
        settlementExecuted[jobId][settlementKey] = true;

        job.released = job.reward;
        job.state = JobState.Closed;

        accounts.settleReservedTo(job.poster, job.asset, job.worker, job.reward);
        if (job.opsReserve > 0) {
            accounts.refundReserved(job.poster, job.asset, job.opsReserve);
        }
        if (job.contingencyReserve > 0) {
            accounts.refundReserved(job.poster, job.asset, job.contingencyReserve);
        }

        reputation.mintBadge(job.worker, job.category, 1, metadataURI);
        reputation.updateReputation(job.worker, 100, 100, job.reward);

        emit JobClosed(jobId, job.worker, job.reward);
    }

    function resolveMilestone(bytes32 jobId, uint256 milestoneIndex, bool approved, bytes32 reasonCode, string calldata metadataURI) external onlyVerifier {
        JobEscrow storage job = jobs[jobId];
        if (job.state != JobState.Submitted || job.payoutMode != PayoutMode.Milestone) revert InvalidState();
        if (milestoneReleased[jobId][milestoneIndex]) revert InvalidState();

        if (!approved) {
            job.state = JobState.Rejected;
            rejectionTimestamps[jobId] = block.timestamp;
            emit JobRejected(jobId, reasonCode);
            return;
        }

        uint256 amount = milestoneAmounts[jobId][milestoneIndex];
        bytes32 settlementKey = keccak256(abi.encode(jobId, milestoneIndex, amount));
        require(!settlementExecuted[jobId][settlementKey], "SETTLED");
        settlementExecuted[jobId][settlementKey] = true;
        milestoneReleased[jobId][milestoneIndex] = true;
        job.released += amount;

        accounts.settleReservedTo(job.poster, job.asset, job.worker, amount);

        bool allReleased = true;
        for (uint256 i = 0; i < milestoneAmounts[jobId].length; i++) {
            if (!milestoneReleased[jobId][i]) {
                allReleased = false;
                break;
            }
        }

        if (allReleased) {
            job.state = JobState.Closed;
            if (job.opsReserve > 0) {
                accounts.refundReserved(job.poster, job.asset, job.opsReserve);
            }
            if (job.contingencyReserve > 0) {
                accounts.refundReserved(job.poster, job.asset, job.contingencyReserve);
            }
            reputation.mintBadge(job.worker, job.category, 2, metadataURI);
            reputation.updateReputation(job.worker, 200, 150, job.reward);
            emit JobClosed(jobId, job.worker, job.reward);
        } else {
            job.claimExpiry = block.timestamp + claimTtls[jobId];
            job.state = JobState.Claimed;
        }
    }

    function openDispute(bytes32 jobId) external onlyParticipant(jobId) {
        JobEscrow storage job = jobs[jobId];
        if (job.state != JobState.Rejected && job.state != JobState.Submitted) revert InvalidState();
        rejectionTimestamps[jobId] = 0;
        job.state = JobState.Disputed;
        emit DisputeOpened(jobId, msg.sender);
    }

    function finalizeRejectedJob(bytes32 jobId) external {
        JobEscrow storage job = jobs[jobId];
        if (job.state != JobState.Rejected) revert InvalidState();
        require(rejectionTimestamps[jobId] != 0, "NO_REJECTION_TIMESTAMP");
        require(block.timestamp > rejectionTimestamps[jobId] + DISPUTE_WINDOW, "DISPUTE_WINDOW_ACTIVE");

        _refundPosterBalances(job);
        rejectionTimestamps[jobId] = 0;
        job.claimExpiry = 0;
        job.state = JobState.Closed;
        emit JobClosed(jobId, job.worker, job.released);
    }

    function resolveDispute(bytes32 jobId, uint256 workerPayout, bytes32 reasonCode, string calldata metadataURI) external onlyArbitrator {
        JobEscrow storage job = jobs[jobId];
        if (job.state != JobState.Disputed) revert InvalidState();
        require(workerPayout <= (job.reward - job.released), "EXCESS_PAYOUT");
        if (workerPayout > 0) {
            accounts.settleReservedTo(job.poster, job.asset, job.worker, workerPayout);
            job.released += workerPayout;
        }

        _refundPosterBalances(job);
        rejectionTimestamps[jobId] = 0;
        job.claimExpiry = 0;
        job.state = JobState.Closed;
        if (workerPayout > 0) {
            reputation.mintBadge(job.worker, job.category, 1, metadataURI);
        }
        emit JobClosed(jobId, job.worker, job.released);
        emit JobRejected(jobId, reasonCode);
    }

    function _refundPosterBalances(JobEscrow storage job) internal {
        uint256 rewardRefund = job.reward - job.released;
        if (rewardRefund > 0) {
            accounts.refundReserved(job.poster, job.asset, rewardRefund);
        }
        if (job.opsReserve > 0) {
            accounts.refundReserved(job.poster, job.asset, job.opsReserve);
        }
        if (job.contingencyReserve > 0) {
            accounts.refundReserved(job.poster, job.asset, job.contingencyReserve);
        }
    }
}
