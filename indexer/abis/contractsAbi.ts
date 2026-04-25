import { parseAbi } from "viem";

export const EscrowCoreAbi = parseAbi([
  "event JobFunded(bytes32 indexed jobId, address indexed poster, address indexed asset, uint256 totalReserved, uint8 payoutMode)",
  "event JobCreated(bytes32 indexed jobId, address indexed poster, bytes32 indexed specHash, address asset, uint256 totalReserved, uint8 payoutMode)",
  "event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry, uint256 claimStake)",
  "event WorkSubmitted(bytes32 indexed jobId, address indexed worker, bytes32 evidenceHash)",
  "event Submitted(bytes32 indexed jobId, address indexed worker, bytes32 indexed payloadHash)",
  "event JobReopened(bytes32 indexed jobId)",
  "event JobRejected(bytes32 indexed jobId, bytes32 reasonCode)",
  "event Verified(bytes32 indexed jobId, address indexed verifier, bool approved, bytes32 reasonCode, bytes32 reasoningHash)",
  "event DisputeOpened(bytes32 indexed jobId, address indexed opener)",
  "event JobClosed(bytes32 indexed jobId, address indexed worker, uint256 releasedAmount)",
  "function jobs(bytes32 jobId) view returns ((address poster, address worker, address asset, bytes32 verifierMode, bytes32 category, bytes32 specHash, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 released, uint256 claimExpiry, uint256 claimStake, uint16 claimStakeBps, uint8 payoutMode, uint8 state))"
]);

export const ReputationSbtAbi = parseAbi([
  "event BadgeMinted(uint256 indexed tokenId, address indexed account, bytes32 indexed category, uint256 level, string metadataURI)",
  "event ReputationUpdated(address indexed account, uint256 skill, uint256 reliability, uint256 economic)",
  "event ReputationSlashed(address indexed account, uint256 skillDelta, uint256 reliabilityDelta, uint256 economicDelta, bytes32 reasonCode, uint256 newSkill, uint256 newReliability, uint256 newEconomic)"
]);

export const TreasuryPolicyAbi = parseAbi([
  "event OutflowRecorded(uint256 day, uint256 amount, uint256 newTotal)"
]);

export const AgentAccountCoreAbi = parseAbi([
  "event JobStakeLocked(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeReleased(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeSlashed(address indexed account, address indexed asset, uint256 amount, uint256 posterAmount, uint256 treasuryAmount)"
]);

export const XcmWrapperAbi = parseAbi([
  "event RequestQueued(bytes32 indexed requestId, bytes32 indexed strategyId, uint8 indexed kind, address account, address asset, address recipient, uint256 assets, uint256 shares, uint64 nonce)",
  "event RequestPayloadStored(bytes32 indexed requestId, bytes32 destinationHash, bytes32 messageHash, uint64 refTime, uint64 proofSize)",
  "event RequestStatusUpdated(bytes32 indexed requestId, uint8 indexed status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode)"
]);

export const VerifierRegistryAbi = parseAbi([
  "event VerifierAdded(address indexed verifier, uint64 timestamp)",
  "event VerifierRemoved(address indexed verifier, uint64 timestamp)",
  "event AdminTransferred(address indexed from, address indexed to)"
]);

export const DiscoveryRegistryAbi = parseAbi([
  "event ManifestPublished(uint64 indexed version, bytes32 indexed hash, uint64 timestamp, address publisher)"
]);

export const DisclosureLogAbi = parseAbi([
  "event Disclosed(bytes32 indexed hash, address indexed byWallet, uint64 timestamp)",
  "event AutoDisclosed(bytes32 indexed hash, uint64 timestamp)"
]);
