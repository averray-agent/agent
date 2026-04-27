// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {AgentAccountCore} from "./AgentAccountCore.sol";
import {ReputationSBT} from "./ReputationSBT.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

contract EscrowCore is ReentrancyGuard {
    uint256 public constant DISPUTE_WINDOW = 7 days;
    uint256 public constant ARBITRATOR_SLA = 14 days;
    // Caps the per-job milestone count so the settlement loop in
    // resolveMilestone() has a known upper gas bound. 32 leaves plenty of
    // headroom for multi-stage deliverables while ruling out griefing via
    // unbounded arrays.
    uint256 public constant MAX_MILESTONES = 32;
    bytes32 public constant REASON_REJECTED = bytes32("REJECTED");
    bytes32 public constant REASON_DISPUTE_LOST = bytes32("DISPUTE_LOST");
    bytes32 public constant REASON_ARBITRATOR_TIMEOUT = bytes32("ARB_TIMEOUT");

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
        bytes32 specHash;
        uint256 reward;
        uint256 opsReserve;
        uint256 contingencyReserve;
        uint256 released;
        uint256 claimExpiry;
        uint256 claimStake;
        uint16 claimStakeBps;
        uint256 rejectedAt;
        uint256 disputedAt;
        PayoutMode payoutMode;
        JobState state;
    }

    mapping(bytes32 => JobEscrow) internal _jobs;
    mapping(bytes32 => uint256[]) public milestoneAmounts;
    mapping(bytes32 => mapping(uint256 => bool)) public milestoneReleased;
    mapping(bytes32 => mapping(bytes32 => bool)) public settlementExecuted;
    mapping(bytes32 => bytes32) public latestEvidence;
    mapping(bytes32 => uint256) public claimTtls;
    mapping(bytes32 => bool) public autoDisclosed;

    event JobFunded(bytes32 indexed jobId, address indexed poster, address indexed asset, uint256 totalReserved, PayoutMode payoutMode);
    event JobCreated(bytes32 indexed jobId, address indexed poster, bytes32 indexed specHash, address asset, uint256 totalReserved, PayoutMode payoutMode);
    event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry, uint256 claimStake);
    event WorkSubmitted(bytes32 indexed jobId, address indexed worker, bytes32 evidenceHash);
    event Submitted(bytes32 indexed jobId, address indexed worker, bytes32 indexed payloadHash);
    event JobReopened(bytes32 indexed jobId);
    event JobRejected(bytes32 indexed jobId, bytes32 reasonCode);
    event Verified(bytes32 indexed jobId, address indexed verifier, bool approved, bytes32 reasonCode, bytes32 reasoningHash);
    event DisputeOpened(bytes32 indexed jobId, address indexed opener, uint256 disputedAt);
    event DisputeResolved(bytes32 indexed jobId, address indexed arbitrator, uint256 workerPayout, bytes32 reasonCode, string metadataURI);
    event AutoResolvedOnTimeout(bytes32 indexed jobId, address indexed caller, uint256 workerPayout, bytes32 reasonCode);
    event JobClosed(bytes32 indexed jobId, address indexed worker, uint256 releasedAmount);
    event Disclosed(bytes32 indexed hash, address indexed byWallet, uint64 timestamp);
    event AutoDisclosed(bytes32 indexed hash, uint64 timestamp);

    error Unauthorized();
    error InvalidState();
    error UnknownJob();
    error ProtocolPaused();
    error MilestoneLimitExceeded();
    error AlreadyAutoDisclosed();

    constructor(TreasuryPolicy policy_, AgentAccountCore accounts_, ReputationSBT reputation_) {
        policy = policy_;
        accounts = accounts_;
        reputation = reputation_;
    }

    modifier onlyVerifier() {
        if (!policy.verifiers(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyDisclosurePublisher() {
        if (msg.sender != policy.owner() && !policy.serviceOperators(msg.sender) && !policy.verifiers(msg.sender)) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyArbitrator() {
        if (!policy.arbitrators(msg.sender)) revert Unauthorized();
        _;
    }

    modifier onlyParticipant(bytes32 jobId) {
        JobEscrow memory job = _jobs[jobId];
        if (msg.sender != job.poster && msg.sender != job.worker) revert Unauthorized();
        _;
    }

    /// @dev Kill-switch: when TreasuryPolicy is paused, all state-mutating
    ///      entrypoints on this contract revert. AgentAccountCore already
    ///      enforces `whenNotPaused` on its mutating entrypoints, so the
    ///      paused state already halts value movement; this modifier makes
    ///      the escrow state machine fail fast with a clearer error instead
    ///      of bubbling an opaque ProtocolPaused from a nested call.
    modifier whenNotPaused() {
        if (policy.paused()) revert ProtocolPaused();
        _;
    }

    function jobs(bytes32 jobId) external view returns (JobEscrow memory) {
        return _jobs[jobId];
    }

    function createSinglePayoutJob(
        bytes32 jobId,
        address asset,
        uint256 reward,
        uint256 opsReserve,
        uint256 contingencyReserve,
        uint256 claimTtl,
        bytes32 verifierMode,
        bytes32 category,
        bytes32 specHash
    ) external whenNotPaused nonReentrant {
        if (_jobs[jobId].state != JobState.None) revert InvalidState();
        _jobs[jobId] = JobEscrow({
            poster: msg.sender,
            worker: address(0),
            asset: asset,
            verifierMode: verifierMode,
            category: category,
            specHash: specHash,
            reward: reward,
            opsReserve: opsReserve,
            contingencyReserve: contingencyReserve,
            released: 0,
            claimExpiry: 0,
            claimStake: 0,
            claimStakeBps: 0,
            rejectedAt: 0,
            disputedAt: 0,
            payoutMode: PayoutMode.Single,
            state: JobState.Open
        });
        claimTtls[jobId] = claimTtl;

        uint256 total = reward + opsReserve + contingencyReserve;
        accounts.reserveForJob(msg.sender, asset, total);
        emit JobFunded(jobId, msg.sender, asset, total, PayoutMode.Single);
        emit JobCreated(jobId, msg.sender, specHash, asset, total, PayoutMode.Single);
    }

    function createMilestoneJob(
        bytes32 jobId,
        address asset,
        uint256[] calldata milestones,
        uint256 opsReserve,
        uint256 contingencyReserve,
        uint256 claimTtl,
        bytes32 verifierMode,
        bytes32 category,
        bytes32 specHash
    ) external whenNotPaused nonReentrant {
        if (_jobs[jobId].state != JobState.None) revert InvalidState();
        if (milestones.length == 0 || milestones.length > MAX_MILESTONES) revert MilestoneLimitExceeded();
        uint256 reward;
        for (uint256 i = 0; i < milestones.length; i++) {
            milestoneAmounts[jobId].push(milestones[i]);
            reward += milestones[i];
        }
        _jobs[jobId] = JobEscrow({
            poster: msg.sender,
            worker: address(0),
            asset: asset,
            verifierMode: verifierMode,
            category: category,
            specHash: specHash,
            reward: reward,
            opsReserve: opsReserve,
            contingencyReserve: contingencyReserve,
            released: 0,
            claimExpiry: 0,
            claimStake: 0,
            claimStakeBps: 0,
            rejectedAt: 0,
            disputedAt: 0,
            payoutMode: PayoutMode.Milestone,
            state: JobState.Open
        });
        claimTtls[jobId] = claimTtl;
        uint256 total = reward + opsReserve + contingencyReserve;
        accounts.reserveForJob(msg.sender, asset, total);
        emit JobFunded(jobId, msg.sender, asset, total, PayoutMode.Milestone);
        emit JobCreated(jobId, msg.sender, specHash, asset, total, PayoutMode.Milestone);
    }

    function claimJob(bytes32 jobId) external whenNotPaused nonReentrant {
        JobEscrow storage job = _jobs[jobId];
        if (job.state == JobState.None) revert UnknownJob();
        if (job.state != JobState.Open) revert InvalidState();

        uint16 claimStakeBps = policy.defaultClaimStakeBps();
        uint256 claimStake = (job.reward * claimStakeBps) / 10_000;
        if (claimStake > 0) {
            accounts.lockJobStake(msg.sender, job.asset, claimStake);
        }

        job.worker = msg.sender;
        job.claimStake = claimStake;
        job.claimStakeBps = claimStakeBps;
        job.claimExpiry = block.timestamp + claimTtls[jobId];
        job.state = JobState.Claimed;
        emit JobClaimed(jobId, msg.sender, job.claimExpiry, claimStake);
    }

    function submitWork(bytes32 jobId, bytes32 evidenceHash) external whenNotPaused {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Claimed) revert InvalidState();
        if (msg.sender != job.worker) revert Unauthorized();
        latestEvidence[jobId] = evidenceHash;
        job.state = JobState.Submitted;
        emit WorkSubmitted(jobId, msg.sender, evidenceHash);
        emit Submitted(jobId, msg.sender, evidenceHash);
    }

    function disclose(bytes32 hash) external whenNotPaused {
        emit Disclosed(hash, msg.sender, uint64(block.timestamp));
    }

    function discloseFor(bytes32 hash, address byWallet) external whenNotPaused onlyDisclosurePublisher {
        emit Disclosed(hash, byWallet, uint64(block.timestamp));
    }

    function autoDisclose(bytes32 hash) external whenNotPaused onlyDisclosurePublisher {
        if (autoDisclosed[hash]) revert AlreadyAutoDisclosed();
        autoDisclosed[hash] = true;
        emit AutoDisclosed(hash, uint64(block.timestamp));
    }

    /// @dev Permissionless by design so any party can finalize an expired claim and reopen the job.
    function handleClaimTimeout(bytes32 jobId) external whenNotPaused nonReentrant {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Claimed) revert InvalidState();
        require(block.timestamp > job.claimExpiry, "NOT_EXPIRED");

        if (job.claimStake > 0) {
            accounts.slashJobStake(job.worker, job.asset, job.claimStake, job.poster);
        }

        job.worker = address(0);
        job.claimExpiry = 0;
        job.claimStake = 0;
        job.claimStakeBps = 0;
        job.state = JobState.Open;
        emit JobReopened(jobId);
    }

    function resolveSinglePayout(bytes32 jobId, bool approved, bytes32 reasonCode, string calldata metadataURI, bytes32 reasoningHash)
        external
        whenNotPaused
        nonReentrant
        onlyVerifier
    {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Submitted || job.payoutMode != PayoutMode.Single) revert InvalidState();
        emit Verified(jobId, msg.sender, approved, reasonCode, reasoningHash);

        if (!approved) {
            job.state = JobState.Rejected;
            job.rejectedAt = block.timestamp;
            job.disputedAt = 0;
            emit JobRejected(jobId, reasonCode);
            return;
        }

        bytes32 settlementKey = keccak256(abi.encode(jobId, uint256(0), job.reward));
        require(!settlementExecuted[jobId][settlementKey], "SETTLED");
        settlementExecuted[jobId][settlementKey] = true;

        job.released = job.reward;
        job.state = JobState.Closed;

        _releaseClaimStake(job);
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

    function resolveMilestone(bytes32 jobId, uint256 milestoneIndex, bool approved, bytes32 reasonCode, string calldata metadataURI, bytes32 reasoningHash)
        external
        whenNotPaused
        nonReentrant
        onlyVerifier
    {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Submitted || job.payoutMode != PayoutMode.Milestone) revert InvalidState();
        if (milestoneReleased[jobId][milestoneIndex]) revert InvalidState();
        emit Verified(jobId, msg.sender, approved, reasonCode, reasoningHash);

        if (!approved) {
            job.state = JobState.Rejected;
            job.rejectedAt = block.timestamp;
            job.disputedAt = 0;
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
            _releaseClaimStake(job);
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

    function openDispute(bytes32 jobId) external whenNotPaused onlyParticipant(jobId) {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Rejected) revert InvalidState();
        require(job.rejectedAt != 0, "NO_REJECTION_TIMESTAMP");
        require(block.timestamp <= job.rejectedAt + DISPUTE_WINDOW, "DISPUTE_WINDOW_CLOSED");
        job.disputedAt = block.timestamp;
        job.state = JobState.Disputed;
        emit DisputeOpened(jobId, msg.sender, job.disputedAt);
    }

    function finalizeRejectedJob(bytes32 jobId) external whenNotPaused nonReentrant {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Rejected) revert InvalidState();
        require(job.rejectedAt != 0, "NO_REJECTION_TIMESTAMP");
        require(block.timestamp > job.rejectedAt + DISPUTE_WINDOW, "DISPUTE_WINDOW_ACTIVE");

        _slashRejectedWorker(job);
        _refundPosterBalances(job);
        job.claimExpiry = 0;
        job.state = JobState.Closed;
        emit JobClosed(jobId, job.worker, job.released);
    }

    function resolveDispute(bytes32 jobId, uint256 workerPayout, bytes32 reasonCode, string calldata metadataURI)
        external
        whenNotPaused
        nonReentrant
        onlyArbitrator
    {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Disputed) revert InvalidState();
        require(workerPayout <= (job.reward - job.released), "EXCESS_PAYOUT");
        _resolveDispute(jobId, job, workerPayout, reasonCode, metadataURI);
        emit DisputeResolved(jobId, msg.sender, workerPayout, reasonCode, metadataURI);
        emit JobClosed(jobId, job.worker, job.released);
    }

    function autoResolveOnTimeout(bytes32 jobId) external whenNotPaused nonReentrant {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Disputed) revert InvalidState();
        require(job.disputedAt != 0, "NO_DISPUTE_TIMESTAMP");
        require(block.timestamp >= job.disputedAt + ARBITRATOR_SLA, "ARBITRATOR_SLA_ACTIVE");

        uint256 workerPayout = job.reward - job.released;
        _resolveDispute(jobId, job, workerPayout, REASON_ARBITRATOR_TIMEOUT, "");
        emit DisputeResolved(jobId, msg.sender, workerPayout, REASON_ARBITRATOR_TIMEOUT, "");
        emit AutoResolvedOnTimeout(jobId, msg.sender, workerPayout, REASON_ARBITRATOR_TIMEOUT);
        emit JobClosed(jobId, job.worker, job.released);
    }

    function _resolveDispute(
        bytes32 jobId,
        JobEscrow storage job,
        uint256 workerPayout,
        bytes32 reasonCode,
        string memory metadataURI
    )
        internal
    {
        if (workerPayout > 0) {
            accounts.settleReservedTo(job.poster, job.asset, job.worker, workerPayout);
            job.released += workerPayout;
            _releaseClaimStake(job);
        } else {
            _slashDisputedWorker(job);
            emit JobRejected(jobId, reasonCode);
        }

        _refundPosterBalances(job);
        job.claimExpiry = 0;
        job.state = JobState.Closed;
        if (workerPayout > 0) {
            reputation.mintBadge(job.worker, job.category, 1, metadataURI);
        }
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

    function _releaseClaimStake(JobEscrow storage job) internal {
        if (job.claimStake > 0 && job.worker != address(0)) {
            accounts.releaseJobStake(job.worker, job.asset, job.claimStake);
            job.claimStake = 0;
            job.claimStakeBps = 0;
        }
    }

    function _slashRejectedWorker(JobEscrow storage job) internal {
        if (job.worker == address(0)) {
            return;
        }

        if (job.claimStake > 0) {
            accounts.slashJobStake(job.worker, job.asset, job.claimStake, job.poster);
            job.claimStake = 0;
            job.claimStakeBps = 0;
        }
        reputation.slashReputation(
            job.worker,
            policy.rejectionSkillPenalty(),
            policy.rejectionReliabilityPenalty(),
            0,
            REASON_REJECTED
        );
    }

    function _slashDisputedWorker(JobEscrow storage job) internal {
        if (job.worker == address(0)) {
            return;
        }

        if (job.claimStake > 0) {
            accounts.slashJobStake(job.worker, job.asset, job.claimStake, job.poster);
            job.claimStake = 0;
            job.claimStakeBps = 0;
        }
        reputation.slashReputation(
            job.worker,
            policy.disputeLossSkillPenalty(),
            policy.disputeLossReliabilityPenalty(),
            0,
            REASON_DISPUTE_LOST
        );
    }
}
