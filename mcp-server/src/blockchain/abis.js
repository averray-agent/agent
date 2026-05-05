export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

export const AGENT_ACCOUNT_ABI = [
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
  "function getBorrowCapacity(address account, address asset) view returns (uint256)",
  "function deposit(address asset, uint256 amount)",
  "function reserveForJob(address account, address asset, uint256 amount)",
  "function reserveForRecurringTemplate(address account, address asset, bytes32 templateId, uint256 amount)",
  "function consumeRecurringTemplateReserve(address account, address asset, bytes32 templateId, uint256 amount)",
  "function recurringTemplateReserves(address account, address asset, bytes32 templateId) view returns (uint256)",
  "function lockJobStake(address account, address asset, uint256 amount)",
  "function releaseJobStake(address account, address asset, uint256 amount)",
  "function slashJobStake(address account, address asset, uint256 amount, address posterRecipient)",
  "function slashClaimFee(address account, address asset, uint256 amount, address verifierRecipient)",
  "function allocateIdleFunds(address account, bytes32 strategyId, uint256 amount)",
  "function deallocateIdleFunds(address account, bytes32 strategyId, uint256 amount)",
  "function requestStrategyDeposit(address account, (bytes32 strategyId, uint256 amount, bytes destination, bytes message, (uint64 refTime, uint64 proofSize) maxWeight, uint64 nonce) params) returns (bytes32)",
  "function requestStrategyWithdraw(address account, (bytes32 strategyId, uint256 shares, address recipient, bytes destination, bytes message, (uint64 refTime, uint64 proofSize) maxWeight, uint64 nonce) params) returns (bytes32)",
  "function settleStrategyRequest(bytes32 requestId, uint8 status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode)",
  "function strategyShares(address account, bytes32 strategyId) view returns (uint256)",
  "function pendingStrategyAssets(address account, address asset) view returns (uint256)",
  "function pendingStrategyWithdrawalShares(address account, bytes32 strategyId) view returns (uint256)",
  "function strategyRequests(bytes32 requestId) view returns (bytes32 strategyId, address adapter, address account, address asset, address recipient, uint8 kind, uint8 status, uint256 requestedAssets, uint256 requestedShares, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode, bool settled)",
  "function borrow(address asset, uint256 amount)",
  "function repay(address asset, uint256 amount)",
  "function sendToAgent(address recipient, address asset, uint256 amount)",
  "function sendToAgentFor(address from, address recipient, address asset, uint256 amount)",
  "event JobStakeLocked(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeReleased(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeSlashed(address indexed account, address indexed asset, uint256 amount, uint256 posterAmount, uint256 treasuryAmount)",
  "event ClaimFeeSlashed(address indexed account, address indexed asset, uint256 amount, address indexed verifierRecipient, uint256 verifierAmount, uint256 treasuryAmount)",
  "event AgentTransfer(address indexed from, address indexed to, address indexed asset, uint256 amount)"
];

export const ESCROW_CORE_ABI = [
  "function createSinglePayoutJob(bytes32 jobId, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash)",
  "function createSinglePayoutJobFromRecurringReserve((bytes32 jobId, bytes32 templateId, address poster, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash) params)",
  "function claimJob(bytes32 jobId)",
  "function handleClaimTimeout(bytes32 jobId)",
  "function submitWork(bytes32 jobId, bytes32 evidenceHash)",
  "function resolveSinglePayout(bytes32 jobId, bool approved, bytes32 reasonCode, string metadataURI, bytes32 reasoningHash)",
  "function finalizeRejectedJob(bytes32 jobId)",
  "function disclose(bytes32 hash)",
  "function discloseFor(bytes32 hash, address byWallet)",
  "function autoDisclose(bytes32 hash)",
  "function autoDisclosed(bytes32 hash) view returns (bool)",
  "function autoResolveOnTimeout(bytes32 jobId)",
  "function resolveDispute(bytes32 jobId, uint256 workerPayout, bytes32 reasonCode, string metadataURI)",
  "function previewClaimEconomics(address worker, bytes32 jobId) view returns (uint256 claimStake, uint16 claimStakeBps, uint256 claimFee, uint16 claimFeeBps, bool waived, uint256 claimNumber)",
  "function workerClaimCount(address worker) view returns (uint256)",
  "function jobs(bytes32 jobId) view returns ((address poster, address worker, address asset, bytes32 verifierMode, bytes32 category, bytes32 specHash, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 released, uint256 claimExpiry, uint256 claimStake, uint16 claimStakeBps, uint256 claimFee, uint16 claimFeeBps, bool claimEconomicsWaived, address rejectingVerifier, uint256 rejectedAt, uint256 disputedAt, uint8 payoutMode, uint8 state))",
  "event JobFunded(bytes32 indexed jobId, address indexed poster, address indexed asset, uint256 totalReserved, uint8 payoutMode)",
  "event JobCreated(bytes32 indexed jobId, address indexed poster, bytes32 indexed specHash, address asset, uint256 totalReserved, uint8 payoutMode)",
  "event RecurringJobFundedFromTemplate(bytes32 indexed jobId, bytes32 indexed templateId, address indexed poster, address asset, uint256 totalReserved)",
  "event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry, uint256 claimStake)",
  "event ClaimEconomicsLocked(bytes32 indexed jobId, address indexed worker, uint256 claimStake, uint256 claimFee, bool waived, uint256 claimNumber)",
  "event WorkSubmitted(bytes32 indexed jobId, address indexed worker, bytes32 evidenceHash)",
  "event Submitted(bytes32 indexed jobId, address indexed worker, bytes32 indexed payloadHash)",
  "event JobRejected(bytes32 indexed jobId, bytes32 reasonCode)",
  "event Verified(bytes32 indexed jobId, address indexed verifier, bool approved, bytes32 reasonCode, bytes32 reasoningHash)",
  "event JobClosed(bytes32 indexed jobId, address indexed worker, uint256 releasedAmount)",
  "event JobReopened(bytes32 indexed jobId)",
  "event DisputeOpened(bytes32 indexed jobId, address indexed opener, uint256 disputedAt)",
  "event DisputeResolved(bytes32 indexed jobId, address indexed arbitrator, uint256 workerPayout, bytes32 reasonCode, string metadataURI)",
  "event AutoResolvedOnTimeout(bytes32 indexed jobId, address indexed caller, uint256 workerPayout, bytes32 reasonCode)",
  "event Disclosed(bytes32 indexed hash, address indexed byWallet, uint64 timestamp)",
  "event AutoDisclosed(bytes32 indexed hash, uint64 timestamp)"
];

export const ESCROW_CORE_LEGACY_ABI = [
  "function createSinglePayoutJob(bytes32 jobId, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category)",
  "function jobs(bytes32 jobId) view returns ((address poster, address worker, address asset, bytes32 verifierMode, bytes32 category, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 released, uint256 claimExpiry, uint256 claimStake, uint16 claimStakeBps, uint8 payoutMode, uint8 state))"
];

export const REPUTATION_SBT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function reputations(address account) view returns (uint256 skill, uint256 reliability, uint256 economic)",
  "function categoryLevels(address account, bytes32 category) view returns (uint256)",
  "function slashReputation(address account, uint256 skillDelta, uint256 reliabilityDelta, uint256 economicDelta, bytes32 reasonCode)",
  "event BadgeMinted(uint256 indexed tokenId, address indexed account, bytes32 indexed category, uint256 level, string metadataURI)",
  "event ReputationUpdated(address indexed account, uint256 skill, uint256 reliability, uint256 economic)",
  "event ReputationSlashed(address indexed account, uint256 skillDelta, uint256 reliabilityDelta, uint256 economicDelta, bytes32 reasonCode, uint256 newSkill, uint256 newReliability, uint256 newEconomic)"
];

export const TREASURY_POLICY_ABI = [
  "function owner() view returns (address)",
  "function pauser() view returns (address)",
  "function paused() view returns (bool)",
  "function dailyOutflowCap() view returns (uint256)",
  "function perAccountBorrowCap() view returns (uint256)",
  "function minimumCollateralRatioBps() view returns (uint256)",
  "function defaultClaimStakeBps() view returns (uint16)",
  "function claimFeeBps() view returns (uint16)",
  "function claimFeeVerifierBps() view returns (uint16)",
  "function onboardingWaiverClaimCount() view returns (uint256)",
  "function minClaimFeeByAsset(address asset) view returns (uint256)",
  "function rejectionSkillPenalty() view returns (uint256)",
  "function rejectionReliabilityPenalty() view returns (uint256)",
  "function disputeLossSkillPenalty() view returns (uint256)",
  "function disputeLossReliabilityPenalty() view returns (uint256)",
  "function verifiers(address verifier) view returns (bool)",
  "function authorizedSince(address verifier) view returns (uint64)",
  "function authorizedUntil(address verifier) view returns (uint64)",
  "function wasAuthorizedAt(address verifier, uint64 timestamp) view returns (bool)",
  "event VerifierUpdated(address indexed verifier, bool approved)"
];

export const ERC20_MOCK_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)"
];

export const STRATEGY_ADAPTER_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function riskLabel() view returns (string)"
];

export const XCM_WRAPPER_ABI = [
  "function getRequest(bytes32 requestId) view returns (((bytes32 strategyId, uint8 kind, address account, address asset, address recipient, uint256 assets, uint256 shares, uint64 nonce) context, uint8 status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode, uint64 createdAt, uint64 updatedAt))",
  "function finalizeRequest(bytes32 requestId, uint8 status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode)",
  "event RequestQueued(bytes32 indexed requestId, bytes32 indexed strategyId, uint8 indexed kind, address account, address asset, address recipient, uint256 assets, uint256 shares, uint64 nonce)",
  "event RequestPayloadStored(bytes32 indexed requestId, bytes32 destinationHash, bytes32 messageHash, uint64 refTime, uint64 proofSize)",
  "event RequestStatusUpdated(bytes32 indexed requestId, uint8 indexed status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode)"
];

export const DISCOVERY_REGISTRY_ABI = [
  "function currentManifestHash() view returns (bytes32)",
  "function currentVersion() view returns (uint64)",
  "event ManifestPublished(uint64 indexed version, bytes32 indexed hash, uint64 timestamp, address publisher)"
];
