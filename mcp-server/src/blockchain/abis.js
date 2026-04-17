export const AGENT_ACCOUNT_ABI = [
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
  "function getBorrowCapacity(address account, address asset) view returns (uint256)",
  "function deposit(address asset, uint256 amount)",
  "function reserveForJob(address account, address asset, uint256 amount)",
  "function lockJobStake(address account, address asset, uint256 amount)",
  "function releaseJobStake(address account, address asset, uint256 amount)",
  "function slashJobStake(address account, address asset, uint256 amount, address posterRecipient)",
  "function allocateIdleFunds(address account, bytes32 strategyId, uint256 amount)",
  "function borrow(address asset, uint256 amount)",
  "function repay(address asset, uint256 amount)",
  "function sendToAgent(address recipient, address asset, uint256 amount)",
  "function sendToAgentFor(address from, address recipient, address asset, uint256 amount)",
  "event JobStakeLocked(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeReleased(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeSlashed(address indexed account, address indexed asset, uint256 amount, uint256 posterAmount, uint256 treasuryAmount)",
  "event AgentTransfer(address indexed from, address indexed to, address indexed asset, uint256 amount)"
];

export const ESCROW_CORE_ABI = [
  "function createSinglePayoutJob(bytes32 jobId, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category)",
  "function claimJob(bytes32 jobId)",
  "function submitWork(bytes32 jobId, bytes32 evidenceHash)",
  "function resolveSinglePayout(bytes32 jobId, bool approved, bytes32 reasonCode, string metadataURI)",
  "function finalizeRejectedJob(bytes32 jobId)",
  "function resolveDispute(bytes32 jobId, uint256 workerPayout, bytes32 reasonCode, string metadataURI)",
  "function jobs(bytes32 jobId) view returns ((address poster, address worker, address asset, bytes32 verifierMode, bytes32 category, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 released, uint256 claimExpiry, uint256 claimStake, uint16 claimStakeBps, uint8 payoutMode, uint8 state))",
  "event JobFunded(bytes32 indexed jobId, address indexed poster, address indexed asset, uint256 totalReserved, uint8 payoutMode)",
  "event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry, uint256 claimStake)",
  "event WorkSubmitted(bytes32 indexed jobId, address indexed worker, bytes32 evidenceHash)",
  "event JobRejected(bytes32 indexed jobId, bytes32 reasonCode)",
  "event JobClosed(bytes32 indexed jobId, address indexed worker, uint256 releasedAmount)",
  "event JobReopened(bytes32 indexed jobId)",
  "event DisputeOpened(bytes32 indexed jobId, address indexed opener)"
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
  "function rejectionSkillPenalty() view returns (uint256)",
  "function rejectionReliabilityPenalty() view returns (uint256)",
  "function disputeLossSkillPenalty() view returns (uint256)",
  "function disputeLossReliabilityPenalty() view returns (uint256)"
];

export const ERC20_MOCK_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)"
];
