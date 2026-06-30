// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {AgentAccountCore} from "./AgentAccountCore.sol";
import {ReputationSBT} from "./ReputationSBT.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

contract EscrowCore is ReentrancyGuard {
    bytes32 public constant EXTERNAL_SCHEMA_REGISTRATION_TYPEHASH =
        keccak256("ExternalSchemaRegistration(bytes32 schemaHash,string schemaUrl,bytes32 jobId)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant EIP712_NAME_HASH = keccak256("Averray EscrowCore");
    bytes32 internal constant EIP712_VERSION_HASH = keccak256("1");
    uint256 internal constant SECP256K1N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
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
        uint256 claimFee;
        uint16 claimFeeBps;
        bool claimEconomicsWaived;
        address rejectingVerifier;
        uint256 rejectedAt;
        uint256 disputedAt;
        PayoutMode payoutMode;
        JobState state;
    }

    struct ExternalSchemaRegistration {
        bytes32 schemaHash;
        string schemaUrl;
        address schemaIssuer;
        bytes schemaSignature;
    }

    struct RecurringSinglePayoutJob {
        bytes32 jobId;
        bytes32 templateId;
        address poster;
        address asset;
        uint256 reward;
        uint256 opsReserve;
        uint256 contingencyReserve;
        uint256 claimTtl;
        bytes32 verifierMode;
        bytes32 category;
        bytes32 specHash;
        bytes32 schemaHash;
        string schemaUrl;
        address schemaIssuer;
        bytes schemaSignature;
    }

    mapping(bytes32 => JobEscrow) internal _jobs;
    mapping(bytes32 => ExternalSchemaRegistration) public jobExternalSchemas;
    mapping(address => uint256) public workerClaimCount;
    mapping(bytes32 => uint256[]) public milestoneAmounts;
    mapping(bytes32 => mapping(uint256 => bool)) public milestoneReleased;
    mapping(bytes32 => mapping(bytes32 => bool)) public settlementExecuted;
    mapping(bytes32 => bytes32) public latestEvidence;
    mapping(bytes32 => uint256) public claimTtls;
    mapping(bytes32 => bool) public autoDisclosed;
    mapping(bytes32 => bool) public onboardingWaiverEligibleJobs;

    event JobFunded(
        bytes32 indexed jobId,
        address indexed poster,
        address indexed asset,
        uint256 totalReserved,
        PayoutMode payoutMode
    );
    event JobCreated(
        bytes32 indexed jobId,
        address indexed poster,
        bytes32 indexed specHash,
        address asset,
        uint256 totalReserved,
        PayoutMode payoutMode
    );
    event ExternalSchemaRegistered(
        bytes32 indexed jobId, bytes32 indexed schemaHash, address indexed schemaIssuer, string schemaUrl
    );
    event RecurringJobFundedFromTemplate(
        bytes32 indexed jobId, bytes32 indexed templateId, address indexed poster, address asset, uint256 totalReserved
    );
    event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry, uint256 claimStake);
    event ClaimEconomicsLocked(
        bytes32 indexed jobId,
        address indexed worker,
        uint256 claimStake,
        uint256 claimFee,
        bool waived,
        uint256 claimNumber
    );
    event OnboardingWaiverEligibilityUpdated(bytes32 indexed jobId, bool eligible);
    event WorkSubmitted(bytes32 indexed jobId, address indexed worker, bytes32 evidenceHash);
    event Submitted(bytes32 indexed jobId, address indexed worker, bytes32 indexed payloadHash);
    event JobReopened(bytes32 indexed jobId);
    event JobRejected(bytes32 indexed jobId, bytes32 reasonCode);
    event Verified(
        bytes32 indexed jobId, address indexed verifier, bool approved, bytes32 reasonCode, bytes32 reasoningHash
    );
    event DisputeOpened(bytes32 indexed jobId, address indexed opener, uint256 disputedAt);
    event DisputeResolved(
        bytes32 indexed jobId, address indexed arbitrator, uint256 workerPayout, bytes32 reasonCode, string metadataURI
    );
    event AutoResolvedOnTimeout(
        bytes32 indexed jobId, address indexed caller, uint256 workerPayout, bytes32 reasonCode
    );
    event JobClosed(bytes32 indexed jobId, address indexed worker, uint256 releasedAmount);
    event Disclosed(bytes32 indexed hash, address indexed byWallet, uint64 timestamp);
    event AutoDisclosed(bytes32 indexed hash, uint64 timestamp);

    error Unauthorized();
    error InvalidState();
    error UnknownJob();
    error ProtocolPaused();
    error MilestoneLimitExceeded();
    error AlreadyAutoDisclosed();
    error InvalidSchemaSignature();
    error UnauthorizedSchemaIssuer(address issuer);

    constructor(TreasuryPolicy policy_, AgentAccountCore accounts_, ReputationSBT reputation_) {
        policy = policy_;
        accounts = accounts_;
        reputation = reputation_;
    }

    modifier onlyVerifier() {
        _onlyVerifier();
        _;
    }

    modifier onlyDisclosurePublisher() {
        _onlyDisclosurePublisher();
        _;
    }

    modifier onlyArbitrator() {
        _onlyArbitrator();
        _;
    }

    modifier onlyOperator() {
        _onlyOperator();
        _;
    }

    modifier onlyParticipant(bytes32 jobId) {
        _onlyParticipant(jobId);
        _;
    }

    /// @dev Kill-switch: when TreasuryPolicy is paused, all state-mutating
    ///      entrypoints on this contract revert. AgentAccountCore already
    ///      enforces `whenNotPaused` on its mutating entrypoints, so the
    ///      paused state already halts value movement; this modifier makes
    ///      the escrow state machine fail fast with a clearer error instead
    ///      of bubbling an opaque ProtocolPaused from a nested call.
    modifier whenNotPaused() {
        _whenNotPaused();
        _;
    }

    function _onlyVerifier() internal view {
        if (!policy.verifiers(msg.sender)) revert Unauthorized();
    }

    function _onlyDisclosurePublisher() internal view {
        if (msg.sender != policy.owner() && !policy.serviceOperators(msg.sender) && !policy.verifiers(msg.sender)) {
            revert Unauthorized();
        }
    }

    function _onlyArbitrator() internal view {
        if (!policy.arbitrators(msg.sender)) revert Unauthorized();
    }

    function _onlyOperator() internal view {
        if (!policy.serviceOperators(msg.sender)) revert Unauthorized();
    }

    function _onlyParticipant(bytes32 jobId) internal view {
        JobEscrow memory job = _jobs[jobId];
        if (msg.sender != job.poster && msg.sender != job.worker) revert Unauthorized();
    }

    function _whenNotPaused() internal view {
        if (policy.paused()) revert ProtocolPaused();
    }

    function jobs(bytes32 jobId) external view returns (JobEscrow memory) {
        return _jobs[jobId];
    }

    function previewClaimEconomics(address worker, bytes32 jobId)
        external
        view
        returns (
            uint256 claimStake,
            uint16 claimStakeBps,
            uint256 claimFee,
            uint16 claimFeeBps,
            bool waived,
            uint256 claimNumber
        )
    {
        JobEscrow storage job = _jobs[jobId];
        if (job.state == JobState.None) revert UnknownJob();
        return _computeClaimEconomics(worker, jobId, job);
    }

    function setOnboardingWaiverEligible(bytes32 jobId, bool eligible) external whenNotPaused onlyOperator {
        if (_jobs[jobId].state == JobState.None) revert UnknownJob();
        onboardingWaiverEligibleJobs[jobId] = eligible;
        emit OnboardingWaiverEligibilityUpdated(jobId, eligible);
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
        ExternalSchemaRegistration memory emptySchema;
        _createSinglePayoutJob(
            jobId,
            asset,
            reward,
            opsReserve,
            contingencyReserve,
            claimTtl,
            verifierMode,
            category,
            specHash,
            emptySchema
        );
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
        bytes32 specHash,
        ExternalSchemaRegistration calldata externalSchema
    ) external whenNotPaused nonReentrant {
        _createSinglePayoutJob(
            jobId,
            asset,
            reward,
            opsReserve,
            contingencyReserve,
            claimTtl,
            verifierMode,
            category,
            specHash,
            externalSchema
        );
    }

    function _createSinglePayoutJob(
        bytes32 jobId,
        address asset,
        uint256 reward,
        uint256 opsReserve,
        uint256 contingencyReserve,
        uint256 claimTtl,
        bytes32 verifierMode,
        bytes32 category,
        bytes32 specHash,
        ExternalSchemaRegistration memory externalSchema
    ) internal {
        if (_jobs[jobId].state != JobState.None) revert InvalidState();
        if (reward == 0) revert InvalidState();
        _validateAndStoreExternalSchema(jobId, externalSchema);
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
            claimFee: 0,
            claimFeeBps: 0,
            claimEconomicsWaived: false,
            rejectingVerifier: address(0),
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

    function createSinglePayoutJobFromRecurringReserve(RecurringSinglePayoutJob calldata params)
        external
        whenNotPaused
        nonReentrant
        onlyOperator
    {
        if (_jobs[params.jobId].state != JobState.None) revert InvalidState();
        if (params.poster == address(0)) revert Unauthorized();
        if (params.reward == 0) revert InvalidState();
        _validateAndStoreExternalSchema(params.jobId, _externalSchemaFromRecurring(params));
        JobEscrow storage job = _jobs[params.jobId];
        job.poster = params.poster;
        job.worker = address(0);
        job.asset = params.asset;
        job.verifierMode = params.verifierMode;
        job.category = params.category;
        job.specHash = params.specHash;
        job.reward = params.reward;
        job.opsReserve = params.opsReserve;
        job.contingencyReserve = params.contingencyReserve;
        job.payoutMode = PayoutMode.Single;
        job.state = JobState.Open;
        claimTtls[params.jobId] = params.claimTtl;

        uint256 total = params.reward + params.opsReserve + params.contingencyReserve;
        accounts.consumeRecurringTemplateReserve(params.poster, params.asset, params.templateId, total);
        emit RecurringJobFundedFromTemplate(params.jobId, params.templateId, params.poster, params.asset, total);
        emit JobFunded(params.jobId, params.poster, params.asset, total, PayoutMode.Single);
        emit JobCreated(params.jobId, params.poster, params.specHash, params.asset, total, PayoutMode.Single);
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
        if (reward == 0) revert InvalidState();
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
            claimFee: 0,
            claimFeeBps: 0,
            claimEconomicsWaived: false,
            rejectingVerifier: address(0),
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
        _claimJob(jobId, msg.sender);
    }

    function claimJobFor(bytes32 jobId, address worker) external whenNotPaused nonReentrant onlyOperator {
        _claimJob(jobId, worker);
    }

    function _claimJob(bytes32 jobId, address worker) internal {
        if (worker == address(0)) revert Unauthorized();
        JobEscrow storage job = _jobs[jobId];
        if (job.state == JobState.None) revert UnknownJob();
        if (job.state != JobState.Open) revert InvalidState();

        (
            uint256 claimStake,
            uint16 claimStakeBps,
            uint256 claimFee,
            uint16 claimFeeBps,
            bool waived,
            uint256 claimNumber
        ) = _computeClaimEconomics(worker, jobId, job);

        uint256 totalLocked = claimStake + claimFee;
        if (totalLocked > 0) {
            accounts.lockJobStake(worker, job.asset, totalLocked);
        }

        job.worker = worker;
        job.claimStake = claimStake;
        job.claimStakeBps = claimStakeBps;
        job.claimFee = claimFee;
        job.claimFeeBps = claimFeeBps;
        job.claimEconomicsWaived = waived;
        job.rejectingVerifier = address(0);
        job.claimExpiry = block.timestamp + claimTtls[jobId];
        job.state = JobState.Claimed;
        workerClaimCount[worker] = claimNumber;
        emit JobClaimed(jobId, worker, job.claimExpiry, claimStake);
        emit ClaimEconomicsLocked(jobId, worker, claimStake, claimFee, waived, claimNumber);
    }

    function submitWork(bytes32 jobId, bytes32 evidenceHash) external whenNotPaused {
        _submitWork(jobId, msg.sender, evidenceHash);
    }

    /// @dev Operator-brokered submit. The backend signs as the service
    ///      operator on behalf of `worker` (the wallet that claimed the job)
    ///      so agents call HTTP only and never sign chain txs. Authorization
    ///      gates on the claimed `worker`, not msg.sender. Mirrors claimJobFor.
    function submitWorkFor(bytes32 jobId, address worker, bytes32 evidenceHash) external whenNotPaused onlyOperator {
        _submitWork(jobId, worker, evidenceHash);
    }

    function _submitWork(bytes32 jobId, address worker, bytes32 evidenceHash) internal {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Claimed) revert InvalidState();
        if (worker != job.worker) revert Unauthorized();
        if (block.timestamp > job.claimExpiry) revert InvalidState();
        latestEvidence[jobId] = evidenceHash;
        job.state = JobState.Submitted;
        emit WorkSubmitted(jobId, worker, evidenceHash);
        emit Submitted(jobId, worker, evidenceHash);
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
        if (job.claimFee > 0) {
            accounts.slashClaimFee(job.worker, job.asset, job.claimFee, address(0));
        }

        _decrementWorkerClaimCount(job.worker);
        job.worker = address(0);
        job.claimExpiry = 0;
        job.claimStake = 0;
        job.claimStakeBps = 0;
        job.claimFee = 0;
        job.claimFeeBps = 0;
        job.claimEconomicsWaived = false;
        job.rejectingVerifier = address(0);
        job.state = JobState.Open;
        emit JobReopened(jobId);
    }

    function resolveSinglePayout(
        bytes32 jobId,
        bool approved,
        bytes32 reasonCode,
        string calldata metadataURI,
        bytes32 reasoningHash
    ) external whenNotPaused nonReentrant onlyVerifier {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Submitted || job.payoutMode != PayoutMode.Single) revert InvalidState();
        emit Verified(jobId, msg.sender, approved, reasonCode, reasoningHash);

        if (!approved) {
            job.state = JobState.Rejected;
            job.rejectedAt = block.timestamp;
            job.disputedAt = 0;
            job.rejectingVerifier = msg.sender;
            emit JobRejected(jobId, reasonCode);
            return;
        }

        bytes32 settlementKey = keccak256(abi.encode(jobId, uint256(0), job.reward));
        require(!settlementExecuted[jobId][settlementKey], "SETTLED");
        settlementExecuted[jobId][settlementKey] = true;

        job.released = job.reward;
        job.state = JobState.Closed;

        _releaseClaimEconomics(job);
        accounts.settleReservedTo(settlementKey, job.poster, job.asset, job.worker, job.reward);
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

    function resolveMilestone(
        bytes32 jobId,
        uint256 milestoneIndex,
        bool approved,
        bytes32 reasonCode,
        string calldata metadataURI,
        bytes32 reasoningHash
    ) external whenNotPaused nonReentrant onlyVerifier {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Submitted || job.payoutMode != PayoutMode.Milestone) revert InvalidState();
        if (milestoneReleased[jobId][milestoneIndex]) revert InvalidState();
        emit Verified(jobId, msg.sender, approved, reasonCode, reasoningHash);

        if (!approved) {
            job.state = JobState.Rejected;
            job.rejectedAt = block.timestamp;
            job.disputedAt = 0;
            job.rejectingVerifier = msg.sender;
            emit JobRejected(jobId, reasonCode);
            return;
        }

        uint256 amount = milestoneAmounts[jobId][milestoneIndex];
        bytes32 settlementKey = keccak256(abi.encode(jobId, milestoneIndex, amount));
        require(!settlementExecuted[jobId][settlementKey], "SETTLED");
        settlementExecuted[jobId][settlementKey] = true;
        milestoneReleased[jobId][milestoneIndex] = true;
        job.released += amount;

        accounts.settleReservedTo(settlementKey, job.poster, job.asset, job.worker, amount);

        bool allReleased = true;
        for (uint256 i = 0; i < milestoneAmounts[jobId].length; i++) {
            if (!milestoneReleased[jobId][i]) {
                allReleased = false;
                break;
            }
        }

        if (allReleased) {
            job.state = JobState.Closed;
            _releaseClaimEconomics(job);
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
        _openDispute(jobId, msg.sender);
    }

    /// @dev Operator-brokered dispute. The backend signs as the service
    ///      operator on behalf of `participant` (the job's poster or worker).
    ///      Without it a brokered openDispute reverts Unauthorized whenever the
    ///      operator signer is neither participant — e.g. recurring-template
    ///      jobs whose poster is a distinct funding wallet. Mirrors submitWorkFor.
    function openDisputeFor(bytes32 jobId, address participant) external whenNotPaused onlyOperator {
        JobEscrow storage job = _jobs[jobId];
        if (participant != job.poster && participant != job.worker) revert Unauthorized();
        _openDispute(jobId, participant);
    }

    function _openDispute(bytes32 jobId, address opener) internal {
        JobEscrow storage job = _jobs[jobId];
        if (job.state != JobState.Rejected) revert InvalidState();
        require(job.rejectedAt != 0, "NO_REJECTION_TIMESTAMP");
        require(block.timestamp <= job.rejectedAt + DISPUTE_WINDOW, "DISPUTE_WINDOW_CLOSED");
        job.disputedAt = block.timestamp;
        job.state = JobState.Disputed;
        emit DisputeOpened(jobId, opener, job.disputedAt);
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
    ) internal {
        if (workerPayout > 0) {
            bytes32 settlementKey = keccak256(abi.encode(jobId, bytes32("DISPUTE"), job.released, workerPayout));
            accounts.settleReservedTo(settlementKey, job.poster, job.asset, job.worker, workerPayout);
            job.released += workerPayout;
            _releaseClaimEconomics(job);
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

    function _externalSchemaFromRecurring(RecurringSinglePayoutJob calldata params)
        internal
        pure
        returns (ExternalSchemaRegistration memory)
    {
        return ExternalSchemaRegistration({
            schemaHash: params.schemaHash,
            schemaUrl: params.schemaUrl,
            schemaIssuer: params.schemaIssuer,
            schemaSignature: params.schemaSignature
        });
    }

    function _validateAndStoreExternalSchema(bytes32 jobId, ExternalSchemaRegistration memory externalSchema) internal {
        bool hasHash = externalSchema.schemaHash != bytes32(0);
        bool hasUrl = bytes(externalSchema.schemaUrl).length > 0;
        bool hasIssuer = externalSchema.schemaIssuer != address(0);
        bool hasSignature = externalSchema.schemaSignature.length > 0;
        if (!hasHash && !hasUrl && !hasIssuer && !hasSignature) {
            return;
        }
        if (!hasHash || !hasUrl || !hasIssuer || !hasSignature) {
            revert InvalidSchemaSignature();
        }

        address recovered = _recoverExternalSchemaSigner(
            hashExternalSchemaRegistration(externalSchema.schemaHash, externalSchema.schemaUrl, jobId),
            externalSchema.schemaSignature
        );
        if (recovered != externalSchema.schemaIssuer) revert InvalidSchemaSignature();
        if (!policy.trustedSchemaIssuers(externalSchema.schemaIssuer)) {
            revert UnauthorizedSchemaIssuer(externalSchema.schemaIssuer);
        }

        jobExternalSchemas[jobId] = externalSchema;
        emit ExternalSchemaRegistered(
            jobId, externalSchema.schemaHash, externalSchema.schemaIssuer, externalSchema.schemaUrl
        );
    }

    function externalSchemaDomainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this))
        );
    }

    function hashExternalSchemaRegistration(bytes32 schemaHash, string memory schemaUrl, bytes32 jobId)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(EXTERNAL_SCHEMA_REGISTRATION_TYPEHASH, schemaHash, keccak256(bytes(schemaUrl)), jobId)
        );
        return keccak256(abi.encodePacked("\x19\x01", externalSchemaDomainSeparator(), structHash));
    }

    function _recoverExternalSchemaSigner(bytes32 ethSignedHash, bytes memory signature)
        internal
        pure
        returns (address)
    {
        if (signature.length != 65) revert InvalidSchemaSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) {
            v += 27;
        }
        if (v != 27 && v != 28) revert InvalidSchemaSignature();
        if (uint256(s) > SECP256K1N_HALF) revert InvalidSchemaSignature();

        address signer = ecrecover(ethSignedHash, v, r, s);
        if (signer == address(0)) revert InvalidSchemaSignature();
        return signer;
    }

    function _computeClaimEconomics(address worker, bytes32 jobId, JobEscrow storage job)
        internal
        view
        returns (
            uint256 claimStake,
            uint16 claimStakeBps,
            uint256 claimFee,
            uint16 claimFeeBps,
            bool waived,
            uint256 claimNumber
        )
    {
        claimNumber = workerClaimCount[worker] + 1;
        waived = onboardingWaiverEligibleJobs[jobId] && claimNumber <= policy.onboardingWaiverClaimCount();
        if (waived) {
            return (0, 0, 0, 0, true, claimNumber);
        }

        claimStakeBps = policy.defaultClaimStakeBps();
        claimStake = (job.reward * claimStakeBps) / 10_000;
        claimFeeBps = policy.claimFeeBps();
        uint256 percentageFee = (job.reward * claimFeeBps) / 10_000;
        uint256 minimumFee = policy.minClaimFeeByAsset(job.asset);
        claimFee = percentageFee > minimumFee ? percentageFee : minimumFee;
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

    function _releaseClaimEconomics(JobEscrow storage job) internal {
        uint256 totalLocked = job.claimStake + job.claimFee;
        if (totalLocked > 0 && job.worker != address(0)) {
            accounts.releaseJobStake(job.worker, job.asset, totalLocked);
        }
        _clearClaimEconomics(job);
    }

    function _clearClaimEconomics(JobEscrow storage job) internal {
        job.claimStake = 0;
        job.claimStakeBps = 0;
        job.claimFee = 0;
        job.claimFeeBps = 0;
        job.claimEconomicsWaived = false;
        job.rejectingVerifier = address(0);
    }

    function _slashRejectedWorker(JobEscrow storage job) internal {
        if (job.worker == address(0)) {
            return;
        }

        _decrementWorkerClaimCount(job.worker);
        if (job.claimStake > 0) {
            accounts.slashJobStake(job.worker, job.asset, job.claimStake, job.poster);
            job.claimStake = 0;
            job.claimStakeBps = 0;
        }
        if (job.claimFee > 0) {
            accounts.slashClaimFee(job.worker, job.asset, job.claimFee, job.rejectingVerifier);
            job.claimFee = 0;
            job.claimFeeBps = 0;
        }
        job.claimEconomicsWaived = false;
        job.rejectingVerifier = address(0);
        reputation.slashReputation(
            job.worker, policy.rejectionSkillPenalty(), policy.rejectionReliabilityPenalty(), 0, REASON_REJECTED
        );
    }

    function _slashDisputedWorker(JobEscrow storage job) internal {
        if (job.worker == address(0)) {
            return;
        }

        _decrementWorkerClaimCount(job.worker);
        if (job.claimStake > 0) {
            accounts.slashJobStake(job.worker, job.asset, job.claimStake, job.poster);
            job.claimStake = 0;
            job.claimStakeBps = 0;
        }
        if (job.claimFee > 0) {
            accounts.slashClaimFee(job.worker, job.asset, job.claimFee, job.rejectingVerifier);
            job.claimFee = 0;
            job.claimFeeBps = 0;
        }
        job.claimEconomicsWaived = false;
        job.rejectingVerifier = address(0);
        reputation.slashReputation(
            job.worker, policy.disputeLossSkillPenalty(), policy.disputeLossReliabilityPenalty(), 0, REASON_DISPUTE_LOST
        );
    }

    function _decrementWorkerClaimCount(address worker) internal {
        if (worker == address(0)) {
            return;
        }

        uint256 claimCount = workerClaimCount[worker];
        if (claimCount > 0) {
            workerClaimCount[worker] = claimCount - 1;
        }
    }
}
