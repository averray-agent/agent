export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

export const AGENT_ACCOUNT_ABI = [
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
  "function withdraw(address asset, uint256 amount)",
  "function getBorrowCapacity(address account, address asset) view returns (uint256)",
  "function escrowOperators(address escrowOperator) view returns (bool)",
  "function deposit(address asset, uint256 amount)",
  "function reserveForJob(address account, address asset, uint256 amount)",
  "function reserveForRecurringTemplate(address account, address asset, bytes32 templateId, uint256 amount)",
  "function consumeRecurringTemplateReserve(address account, address asset, bytes32 templateId, uint256 amount)",
  "function cancelRecurringTemplateReserve(address account, address asset, bytes32 templateId, uint256 amount)",
  "function recurringTemplateReserves(address account, address asset, bytes32 templateId) view returns (uint256)",
  "function setEscrowOperator(address escrowOperator, bool approved)",
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
  "function sendToAgentFor(address from, address recipient, address asset, uint256 amount, uint256 nonce, uint256 deadline, bytes signature)",
  "function hashSendToAgentAuthorization(address from, address recipient, address asset, uint256 amount, uint256 nonce, uint256 deadline) view returns (bytes32)",
  "function sendToAgentAuthorizationUsed(address from, uint256 nonce) view returns (bool)",
  "event JobStakeLocked(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeReleased(address indexed account, address indexed asset, uint256 amount)",
  "event JobStakeSlashed(address indexed account, address indexed asset, uint256 amount, uint256 posterAmount, uint256 treasuryAmount)",
  "event ClaimFeeSlashed(address indexed account, address indexed asset, uint256 amount, address indexed verifierRecipient, uint256 verifierAmount, uint256 treasuryAmount)",
  // Deployed AgentAccountCore event recovered from mainnet logs. The leading
  // indexed field is settlementId; the historical four-field source ABI is not
  // compatible with the deployed topic0.
  "event ReservationSettled(bytes32 indexed settlementId, address indexed account, address indexed recipient, address asset, uint256 amount)",
  "event AgentTransfer(address indexed from, address indexed to, address indexed asset, uint256 amount)"
];

export const DEPOSIT_POOL_ABI = [
  "function asset() view returns (address)",
  "function venueAdapter() view returns (address)",
  "function assetsOf(address account) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function availableShares(address account) view returns (uint256)",
  "function bufferAssets() view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function venuePrincipalCostBasis() view returns (uint256)",
  "function TOTAL_ASSET_CAP() view returns (uint256)",
  "function PER_AGENT_ASSET_CAP() view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event RedeemRequested(uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares, uint8 tier, uint64 unlockAt)",
  "event RedeemFulfilled(uint256 indexed requestId, uint256 shares, uint256 assets)",
  "event OperatorPrincipalContributed(uint256 assets, uint256 shares, uint256 totalPrincipal)",
  "event VenueLossWrittenOff(uint256 indexed deploymentId, uint256 assets, uint256 remainingPrincipalCostBasis)"
];

export const DEPOSIT_POOL_V2_ABI = [
  ...DEPOSIT_POOL_ABI,
  "function creditPool() view returns (address)",
  "function pledgedShares(address account) view returns (uint256)",
  "function pledges(bytes32 loanId) view returns (address owner, uint256 shares, bool active)",
  "function pledge(uint256 shares, bytes32 loanId)",
  "event SharesPledged(address indexed owner, uint256 shares, bytes32 indexed loanId)",
  "event SharesReleased(address indexed owner, uint256 shares, bytes32 indexed loanId)",
  "event SharesSeized(address indexed owner, address indexed receiver, uint256 shares, uint256 assets, bytes32 loanId)"
];

export const CREDIT_POOL_ABI = [
  "function asset() view returns (address)",
  "function depositPool() view returns (address)",
  "function operator() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function bufferAssets() view returns (uint256)",
  "function principalOutstanding() view returns (uint256)",
  "function totalPledgedShares() view returns (uint256)",
  "function defaults() view returns (uint256)",
  "function ltvBps() view returns (uint256)",
  "function interestBps() view returns (uint256)",
  "function TOTAL_ASSET_CAP() view returns (uint256)",
  "function PER_LENDER_CAP() view returns (uint256)",
  "function MAX_LTV_BPS() view returns (uint256)",
  "function MAX_INTEREST_BPS() view returns (uint256)",
  "function PLATFORM_FEE_BPS() view returns (uint256)",
  "function RISK_DISCLOSURE() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function assetsOf(address account) view returns (uint256)",
  "function availableShares(address account) view returns (uint256)",
  "function outstandingDebt(address account) view returns (uint256)",
  "function nextLoanNonce(address account) view returns (uint256)",
  "function vestingAttestationNonces(address account) view returns (uint256)",
  "function previewLoanId(address borrower) view returns (bytes32)",
  "function vestingAttestationDigest(address borrower, bytes32 loanId, uint256 pledgeShares, uint256 amount, uint256 vestedRaw, uint64 validUntil, uint256 nonce) view returns (bytes32)",
  "function loans(bytes32 loanId) view returns (address borrower, uint256 principal, uint256 outstandingPrincipal, uint256 outstandingInterest, uint256 pledgeShares, uint256 vestedRawAtOrigination, uint16 interestBpsAtOrigination, uint8 status)",
  "function originate(uint256 pledgeShares, uint256 amount, uint256 vestedRaw, uint64 validUntil, bytes vestingSignature) returns (bytes32 loanId)",
  "function cancelUnusedPledge(bytes32 loanId)",
  "function repay(bytes32 loanId, uint256 amount)",
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "event LoanOriginated(bytes32 indexed loanId, address indexed borrower, uint256 amount, uint256 pledgedShares)",
  "event LoanRepaid(bytes32 indexed loanId, uint256 amount, uint256 outstanding)",
  "event LoanClosed(bytes32 indexed loanId)",
  "event PledgeSeized(bytes32 indexed loanId, uint256 value)",
  "event LtvBpsChanged(uint256 previousBps, uint256 newBps)",
  "event InterestBpsChanged(uint256 previousBps, uint256 newBps)"
];

export const CREDIT_BOOK_ABI = [
  "function asset() view returns (address)",
  "function operator() view returns (address)",
  "function accounts() view returns (address)",
  "function cashPerWalletCapRaw() view returns (uint256)",
  "function postingPerWalletCapRaw() view returns (uint256)",
  "function bookCapRaw() view returns (uint256)",
  "function interestBps() view returns (uint256)",
  "function repayBps() view returns (uint256)",
  "function totalOutstandingRaw() view returns (uint256)",
  "function accountedLiquidityRaw() view returns (uint256)",
  "function bookLiquidRaw() view returns (uint256)",
  "function l3Enabled() view returns (bool)",
  "function l3PosterWallet() view returns (address)",
  "function PER_WALLET_CAP_CEILING_RAW() view returns (uint256)",
  "function BOOK_CAP_CEILING_RAW() view returns (uint256)",
  "function INTEREST_BPS_CEILING() view returns (uint256)",
  "function BPS() view returns (uint256)",
  "function nextLoanNonce(address borrower) view returns (uint256)",
  "function activeLoanByMode(address borrower, uint8 mode) view returns (bytes32)",
  "function outstandingByModeRaw(address borrower, uint8 mode) view returns (uint256)",
  "function previewLoanId(address borrower) view returns (bytes32)",
  "function loans(bytes32 loanId) view returns (address borrower, uint8 mode, uint256 principalRaw, uint256 outstandingRaw, bytes32 termsHash, uint64 originatedAt, uint64 closedAt)",
  "function originate(address borrower, uint256 amountRaw, uint8 mode, bytes32 termsHash) returns (bytes32 loanId)",
  "function repay(bytes32 loanId, uint256 amountRaw)",
  "function recordSweepRepayment(bytes32 loanId, uint256 amountRaw)",
  "function repayFromRefund(bytes32 loanId)",
  "event LoanOriginated(bytes32 indexed loanId,address indexed borrower,uint8 indexed mode,uint256 principalRaw,address recipient,bytes32 termsHash)",
  "event LoanRepaid(bytes32 indexed loanId,address indexed payer,uint256 amountRaw,uint256 outstandingRaw)",
  "event LoanClosed(bytes32 indexed loanId,address indexed borrower,uint8 indexed mode)"
];

export const ESCROW_CORE_ABI = [
  "function accounts() view returns (address)",
  "function treasuryAccount() view returns (address)",
  "function DISPUTE_WINDOW() view returns (uint256)",
  "function protocolFeeBps() view returns (uint16)",
  "function posterFeeBps() view returns (uint16)",
  "function posterFeeFloorRaw() view returns (uint256)",
  "function retentionFlatRaw() view returns (uint256)",
  "function retentionCapBps() view returns (uint16)",
  "function supportsGasRetention() pure returns (bool)",
  "function previewPosterFee(uint256 reward) view returns (uint256)",
  "function previewGasRetention(uint256 reward, bool brokered, bool waived) view returns (uint256)",
  "function MAX_PROTOCOL_FEE_BPS() view returns (uint16)",
  "function MAX_RETENTION_FLAT_RAW() view returns (uint256)",
  "function MAX_RETENTION_CAP_BPS() view returns (uint16)",
  "function MAX_POSTER_FEE_FLOOR_RAW() view returns (uint256)",
  "function previewProtocolFee(uint256 reward) view returns (uint256)",
  "function setTreasuryAccount(address newTreasuryAccount)",
  "function createSinglePayoutJob(bytes32 jobId, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash)",
  "function createSinglePayoutJobFeeWaived(bytes32 jobId, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash)",
  "function createSinglePayoutJobFeeWaived(bytes32 jobId, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash, (bytes32 schemaHash, string schemaUrl, address schemaIssuer, bytes schemaSignature) externalSchema)",
  "function createSinglePayoutJob(bytes32 jobId, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash, (bytes32 schemaHash, string schemaUrl, address schemaIssuer, bytes schemaSignature) externalSchema)",
  "function createSinglePayoutJobFromRecurringReserve((bytes32 jobId, bytes32 templateId, address poster, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash, bytes32 schemaHash, string schemaUrl, address schemaIssuer, bytes schemaSignature, bool protocolFeeWaived) params)",
  "function jobExternalSchemas(bytes32 jobId) view returns (bytes32 schemaHash, string schemaUrl, address schemaIssuer, bytes schemaSignature)",
  "function claimJob(bytes32 jobId)",
  "function claimJobFor(bytes32 jobId, address worker)",
  "function cancelOpenJob(bytes32 jobId)",
  "function setOnboardingWaiverEligible(bytes32 jobId, bool eligible)",
  "function onboardingWaiverEligibleJobs(bytes32 jobId) view returns (bool)",
  "function handleClaimTimeout(bytes32 jobId)",
  "function submitWork(bytes32 jobId, bytes32 evidenceHash)",
  "function submitWorkFor(bytes32 jobId, address worker, bytes32 evidenceHash)",
  "function latestEvidence(bytes32 jobId) view returns (bytes32)",
  "function resolveSinglePayout(bytes32 jobId, bool approved, bytes32 reasonCode, string metadataURI, bytes32 reasoningHash)",
  "function finalizeRejectedJob(bytes32 jobId)",
  "function disclose(bytes32 hash)",
  "function discloseFor(bytes32 hash, address byWallet)",
  "function autoDisclose(bytes32 hash)",
  "function autoDisclosed(bytes32 hash) view returns (bool)",
  "function autoResolveOnTimeout(bytes32 jobId)",
  "function openDispute(bytes32 jobId)",
  "function openDisputeFor(bytes32 jobId, address participant)",
  "function resolveDispute(bytes32 jobId, uint256 workerPayout, bytes32 reasonCode, string metadataURI)",
  "function previewClaimEconomics(address worker, bytes32 jobId) view returns (uint256 claimStake, uint16 claimStakeBps, uint256 claimFee, uint16 claimFeeBps, bool waived, uint256 claimNumber)",
  "function retainsClaimFeeOnSuccess() view returns (bool)",
  "function workerClaimCount(address worker) view returns (uint256)",
  "function jobs(bytes32 jobId) view returns ((address poster, address worker, address asset, bytes32 verifierMode, bytes32 category, bytes32 specHash, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 released, uint256 claimExpiry, uint256 claimStake, uint16 claimStakeBps, uint256 claimFee, uint16 claimFeeBps, bool claimEconomicsWaived, address rejectingVerifier, uint256 rejectedAt, uint256 disputedAt, uint8 payoutMode, uint8 state, uint256 protocolFee, uint256 protocolFeeReleased, uint16 protocolFeeBps, bool protocolFeeWaived))",
  "event JobFunded(bytes32 indexed jobId, address indexed poster, address indexed asset, uint256 totalReserved, uint8 payoutMode)",
  "event JobCreated(bytes32 indexed jobId, address indexed poster, bytes32 indexed specHash, address asset, uint256 totalReserved, uint8 payoutMode)",
  "event ExternalSchemaRegistered(bytes32 indexed jobId, bytes32 indexed schemaHash, address indexed schemaIssuer, string schemaUrl)",
  "event RecurringJobFundedFromTemplate(bytes32 indexed jobId, bytes32 indexed templateId, address indexed poster, address asset, uint256 totalReserved)",
  "event JobClaimed(bytes32 indexed jobId, address indexed worker, uint256 claimExpiry, uint256 claimStake)",
  "event ClaimRetentionSnapshot(bytes32 indexed jobId, address indexed worker, bool brokered, bool waived, uint256 retentionFlatRaw, uint16 retentionCapBps)",
  "event GasRetentionApplied(bytes32 indexed jobId, address indexed worker, uint256 retainedRaw, uint256 rewardRaw)",
  "event FeeScheduleChanged(uint256 previousRetentionFlatRaw, uint16 previousRetentionCapBps, uint16 previousPosterFeeBps, uint256 previousPosterFeeFloorRaw, uint256 newRetentionFlatRaw, uint16 newRetentionCapBps, uint16 newPosterFeeBps, uint256 newPosterFeeFloorRaw)",
  "event JobCancelled(bytes32 indexed jobId, address indexed poster, uint256 refundedRaw)",
  "event ClaimEconomicsLocked(bytes32 indexed jobId, address indexed worker, uint256 claimStake, uint256 claimFee, bool waived, uint256 claimNumber)",
  "event OnboardingWaiverEligibilityUpdated(bytes32 indexed jobId, bool eligible)",
  "event ProtocolFeeBpsUpdated(uint16 previousProtocolFeeBps, uint16 newProtocolFeeBps)",
  "event TreasuryAccountUpdated(address indexed previousTreasuryAccount, address indexed newTreasuryAccount)",
  "event SettlementSplit(bytes32 indexed jobId, address indexed worker, address indexed treasuryAccount, address asset, uint256 workerAmount, uint256 protocolFeeAmount, uint16 protocolFeeBps)",
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

export const ESCROW_CORE_V1_DRAIN_ABI = [
  ...ESCROW_CORE_ABI.filter((entry) =>
    !entry.startsWith("function jobs(")
    && !entry.startsWith("function createSinglePayoutJobFromRecurringReserve(")
  ),
  "function jobs(bytes32 jobId) view returns ((address poster, address worker, address asset, bytes32 verifierMode, bytes32 category, bytes32 specHash, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 released, uint256 claimExpiry, uint256 claimStake, uint16 claimStakeBps, uint256 claimFee, uint16 claimFeeBps, bool claimEconomicsWaived, address rejectingVerifier, uint256 rejectedAt, uint256 disputedAt, uint8 payoutMode, uint8 state))",
  "function createSinglePayoutJobFromRecurringReserve((bytes32 jobId, bytes32 templateId, address poster, address asset, uint256 reward, uint256 opsReserve, uint256 contingencyReserve, uint256 claimTtl, bytes32 verifierMode, bytes32 category, bytes32 specHash, bytes32 schemaHash, string schemaUrl, address schemaIssuer, bytes schemaSignature) params)"
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
  "function approvedAssets(address asset) view returns (bool)",
  "function approvedStrategies(address strategy) view returns (bool)",
  "function rejectionSkillPenalty() view returns (uint256)",
  "function rejectionReliabilityPenalty() view returns (uint256)",
  "function disputeLossSkillPenalty() view returns (uint256)",
  "function disputeLossReliabilityPenalty() view returns (uint256)",
  "function settlementBroker(address operator) view returns (bool)",
  "function agentTransferBroker(address operator) view returns (bool)",
  "function strategySettler(address operator) view returns (bool)",
  "function reputationWriter(address operator) view returns (bool)",
  "function outflowRecorder(address operator) view returns (bool)",
  "function trustedSchemaIssuers(address issuer) view returns (bool)",
  "function setTrustedSchemaIssuer(address issuer, bool approved)",
  "function verifiers(address verifier) view returns (bool)",
  "function arbitrators(address arbitrator) view returns (bool)",
  "function authorizedSince(address verifier) view returns (uint64)",
  "function authorizedUntil(address verifier) view returns (uint64)",
  "function wasAuthorizedAt(address verifier, uint64 timestamp) view returns (bool)",
  "event VerifierUpdated(address indexed verifier, bool approved)",
  "event TrustedSchemaIssuerSet(address indexed issuer, bool approved)"
];

export const ERC20_MOCK_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)"
];

export const STRATEGY_ADAPTER_ABI = [
  "function strategyId() view returns (bytes32)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function riskLabel() view returns (string)"
];

export const HYDRATION_USDC_ADAPTER_V22_ABI = [
  ...STRATEGY_ADAPTER_ABI,
  "function getAdapterRequest(bytes32 requestId) view returns ((uint8 kind, uint8 status, address account, address requester, address recipient, uint256 requestedAssets, uint256 requestedShares, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode, bool settled))",
  "function settleRequest(bytes32 requestId, uint8 status, uint256 settledAssets, uint256 settledShares, uint256 observedRemoteBalanceRaw, bytes32 remoteRef, bytes32 failureCode)"
];

export const XCM_WRAPPER_ABI = [
  // Keep this error block copied verbatim from contracts/XcmWrapperV22.sol.
  // abis.test.js compares the complete Solidity error set so new wrapper
  // errors cannot silently fall back to ethers' "unknown custom error".
  "error Unauthorized()",
  "error ProtocolPaused()",
  "error UnknownRequest()",
  "error InvalidRequest()",
  "error InvalidStatus()",
  "error InvalidTransition()",
  "error InvalidSettlement()",
  "error InvalidConfiguration()",
  "error PlanMismatch()",
  "error FeeAboveMaximum()",
  "error DispatchDeadlineExpired()",
  "error XcmPrecompileUnavailable()",
  "error XcmDispatchFailed(bytes reason)",
  "error CustodyMismatch()",
  "function strategyAdapter(bytes32 strategyId) view returns (address)",
  "function weighMessage(bytes message) view returns ((uint64 refTime, uint64 proofSize))",
  "function getRequest(bytes32 requestId) view returns (((bytes32 strategyId, uint8 kind, address account, address asset, address recipient, uint256 assets, uint256 shares, uint64 nonce) context, address queuedBy, uint8 status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode, uint64 createdAt, uint64 updatedAt))",
  "function getRequestParameters(bytes32 requestId) view returns ((uint256 sellAmount, uint256 minimumOutput, uint256 maxFeePerLeg, uint64 dispatchDeadline))",
  "function requestDispatchBitmap(bytes32 requestId) view returns (uint8)",
  "function dispatchPaused() view returns (bool)",
  "function operator() view returns (address)",
  "function previewLegMessage(bytes32 requestId, uint8 leg, uint256 feeAmount) view returns (bytes destination, bytes message, (uint64 refTime, uint64 proofSize) maxWeight)",
  "function dispatchLeg(bytes32 requestId, uint8 leg, uint256 feeAmount)",
  "function finalizeRequest(bytes32 requestId, uint8 status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode)",
  "event StrategyAdapterUpdated(bytes32 indexed strategyId, address indexed previousAdapter, address indexed newAdapter)",
  "event RequestQueued(bytes32 indexed requestId, bytes32 indexed strategyId, uint8 indexed kind, address account, address asset, address recipient, uint256 assets, uint256 shares, uint64 nonce)",
  "event RequestParametersStored(bytes32 indexed requestId, uint256 sellAmount, uint256 minimumOutput, uint256 maxFeePerLeg, uint64 dispatchDeadline)",
  "event RequestLegDispatched(bytes32 indexed requestId, uint8 indexed leg, address indexed caller, bytes32 destinationHash, bytes32 messageHash, uint256 feeAmount)",
  "event RequestPayloadStored(bytes32 indexed requestId, bytes32 destinationHash, bytes32 messageHash, uint64 refTime, uint64 proofSize)",
  "event RequestDispatched(bytes32 indexed requestId, address indexed xcmPrecompile, bytes32 destinationHash, bytes32 messageHash)",
  "event RequestStatusUpdated(bytes32 indexed requestId, uint8 indexed status, uint256 settledAssets, uint256 settledShares, bytes32 remoteRef, bytes32 failureCode)"
];

export const DISCOVERY_REGISTRY_ABI = [
  "function currentManifestHash() view returns (bytes32)",
  "function currentVersion() view returns (uint64)",
  "event ManifestPublished(uint64 indexed version, bytes32 indexed hash, uint64 timestamp, address publisher)"
];
