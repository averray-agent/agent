export const API_DECLARATIONS = String.raw`
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type WalletAddress = string;
export type AssetSymbol = string;
export type ISODateTime = string;
export type JobId = string;
export type SessionId = string;
export type IdempotencyKey = string;

export interface AgentPlatformClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
}

export interface ApiEnvelope {
  [key: string]: unknown;
}

export interface HealthResponse extends ApiEnvelope {
  ok?: boolean;
  status?: string;
}

export interface OnboardingResponse extends ApiEnvelope {
  onboarding?: ApiEnvelope;
  entrypoint?: string;
}

export interface DiscoveryManifest extends ApiEnvelope {
  name?: string;
  version?: string;
  tools?: ApiEnvelope[];
  capabilities?: ApiEnvelope;
}

export interface JobTierLadderResponse extends ApiEnvelope {
  tiers?: ApiEnvelope[];
}

export interface StrategySummary extends ApiEnvelope {
  strategyId: string;
  id?: string;
  label?: string;
  asset?: AssetSymbol;
  kind?: string;
  riskLabel?: string;
}

export interface StrategiesResponse extends ApiEnvelope {
  strategies: StrategySummary[];
  docs?: string;
}

export interface SessionStateMachineResponse extends ApiEnvelope {
  statuses?: ApiEnvelope[];
  transitions?: ApiEnvelope[];
}

export interface JobSchemaSummary extends ApiEnvelope {
  name: string;
  path?: string;
  schema?: JsonObject;
}

export interface JobSchemasResponse extends ApiEnvelope {
  schemas?: JobSchemaSummary[];
}

export interface AgentProfile extends ApiEnvelope {
  wallet: WalletAddress;
  handle?: string;
  reputation?: number;
  badges?: ApiEnvelope[];
  currentActivity?: ApiEnvelope | null;
  lifetimeStats?: ApiEnvelope;
}

export interface AgentListResponse extends ApiEnvelope {
  agents?: AgentProfile[];
  count?: number;
}

export interface BadgeResponse extends ApiEnvelope {
  name?: string;
  description?: string;
  image?: string;
  attributes?: ApiEnvelope[];
}

export interface AlertListResponse extends ApiEnvelope {
  alerts?: ApiEnvelope[];
  count?: number;
}

export interface AuditEventListResponse extends ApiEnvelope {
  events?: ApiEnvelope[];
  count?: number;
}

export interface PolicySummary extends ApiEnvelope {
  tag: string;
  status?: string;
}

export interface PolicyListResponse extends ApiEnvelope {
  policies?: PolicySummary[];
}

export interface VerifierHandlersResponse extends ApiEnvelope {
  handlers?: ApiEnvelope[];
}

export interface NonceResponse extends ApiEnvelope {
  nonce?: string;
  message?: string;
}

export interface AuthSessionResponse extends ApiEnvelope {
  wallet?: WalletAddress;
  roles?: string[];
  capabilities?: string[];
}

export interface AssetBalances {
  [asset: AssetSymbol]: number;
}

export interface AccountSummary extends ApiEnvelope {
  wallet: WalletAddress;
  liquid?: AssetBalances;
  reserved?: AssetBalances;
  strategyAllocated?: AssetBalances;
  debtOutstanding?: AssetBalances;
}

export interface BorrowCapacityResponse extends ApiEnvelope {
  wallet?: WalletAddress;
  asset?: AssetSymbol;
  capacity?: number;
  available?: number;
}

export interface StrategyPositionsResponse extends ApiEnvelope {
  positions?: ApiEnvelope[];
}

export interface FundAccountInput {
  asset?: AssetSymbol;
  amount: number | string;
}

export interface StrategyMutationInput {
  asset?: AssetSymbol;
  amount: number | string;
  strategyId?: string;
  idempotencyKey?: IdempotencyKey;
  destination?: string;
  message?: string;
  maxWeight?: unknown;
  nonce?: number | string;
  recipient?: string;
}

export interface SendToAgentInput {
  recipient: WalletAddress;
  asset?: AssetSymbol;
  amount: number | string;
}

export interface BalanceMutationInput {
  asset?: AssetSymbol;
  amount: number | string;
  idempotencyKey?: IdempotencyKey;
}

export interface ClaimStatus extends ApiEnvelope {
  claimState?: string;
  effectiveState?: string;
  claimable?: boolean;
  currentWalletCanClaim?: boolean | null;
  reason?: string | null;
  retryLimit?: number | null;
  claimAttemptCount?: number | null;
  remainingClaimAttempts?: number | null;
  claimExpiresAt?: ISODateTime | null;
  expiredAt?: ISODateTime | null;
}

export interface DelegationPolicy extends ApiEnvelope {
  budgetAmount?: number;
  budgetAsset?: AssetSymbol;
  maxSubJobs?: number;
  maxDepth?: number;
}

export interface RecurringPolicy extends ApiEnvelope {
  reserveAmount?: number;
  reserveAsset?: AssetSymbol;
  maxRuns?: number;
}

{{BUILTIN_JOB_SCHEMA_TYPES}}

export interface JobDefinition extends ApiEnvelope {
  id: JobId;
  title?: string;
  category?: string;
  tier?: string;
  rewardAmount?: number;
  rewardAsset?: AssetSymbol;
  verifierMode?: string;
  retryLimit?: number;
  parentSessionId?: SessionId;
  delegationPolicy?: DelegationPolicy;
  recurringPolicy?: RecurringPolicy;
  claimStatus?: ClaimStatus;
  claimable?: boolean;
  claimState?: string;
  effectiveState?: string;
  currentWalletCanClaim?: boolean | null;
  reason?: string | null;
  submissionContract?: ApiEnvelope;
  source?: ApiEnvelope;
  verification?: ApiEnvelope;
  lineage?: SubJobLineageMetadata;
}

export interface JobSummary extends ApiEnvelope {
  id: JobId;
  title?: string;
  category?: string;
  tier?: string;
  state?: string;
  status?: string;
  effectiveState?: string;
  claimState?: string;
  claimable?: boolean;
  currentWalletCanClaim?: boolean | null;
  reason?: string | null;
  rewardAmount?: number;
  rewardAsset?: AssetSymbol;
  claimExpiresAt?: ISODateTime | null;
  retryLimit?: number | null;
  parentSessionId?: SessionId;
  delegationPolicy?: DelegationPolicy;
  recurringPolicy?: RecurringPolicy;
  lineage?: SubJobLineageMetadata;
}

export interface JobsListResponse extends ApiEnvelope {
  jobs: JobSummary[];
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
  nextOffset?: number | null;
  compact?: boolean;
}

export interface ListJobsOptions {
  wallet?: WalletAddress;
  source?: string;
  category?: string;
  state?: string;
  format?: string;
  limit?: number;
  offset?: number;
}

export interface RecommendationResponse extends ApiEnvelope {
  recommendations?: JobSummary[];
  jobs?: JobSummary[];
}

export interface PreflightResponse extends ApiEnvelope {
  jobId?: JobId;
  eligible?: boolean;
  claimable?: boolean;
  currentWalletCanClaim?: boolean | null;
  reason?: string | null;
  retryLimit?: number | null;
  claimExpiresAt?: ISODateTime | null;
}

export interface ValidationResponse<TSubmission = unknown> extends ApiEnvelope {
  valid: boolean;
  errors?: ApiEnvelope[];
  submission?: TSubmission;
}

export interface ClaimResponse extends SessionRecord {
  sessionId: SessionId;
  jobId: JobId;
  wallet: WalletAddress;
}

export interface SubmitResponse extends SessionRecord {
  sessionId: SessionId;
}

export interface SessionRecord extends ApiEnvelope {
  sessionId: SessionId;
  jobId?: JobId;
  wallet?: WalletAddress;
  status?: string;
  state?: string;
  claimExpiresAt?: ISODateTime | null;
  deadline?: ISODateTime | null;
  claimedAt?: ISODateTime;
  submittedAt?: ISODateTime;
  updatedAt?: ISODateTime;
  parentSessionId?: SessionId;
}

export interface TimelineEntry extends ApiEnvelope {
  id?: string;
  type?: string;
  at?: ISODateTime;
  label?: string;
}

export interface SubJobBudgetSummary extends ApiEnvelope {
  asset: AssetSymbol;
  budgetAmount?: number;
  usedAmount?: number;
  remainingAmount?: number;
  parentBudgetAmount?: number;
  usedBeforeAmount?: number;
  usedAfterAmount?: number;
  remainingAfterAmount?: number;
}

export interface SubJobLineageMetadata extends ApiEnvelope {
  kind?: "sub_job" | string;
  parentSessionId?: SessionId;
  parentJobId?: JobId;
  parentWallet?: WalletAddress;
  depth?: number;
  createdBy?: WalletAddress;
  createdAt?: ISODateTime;
  budget?: SubJobBudgetSummary;
  funding?: ApiEnvelope;
}

export interface SessionLineage extends ApiEnvelope {
  parentSessionId?: SessionId;
  childJobIds?: JobId[];
  childSessionIds?: SessionId[];
  subJobBudget?: SubJobBudgetSummary;
  subJobPolicy?: DelegationPolicy;
}

export interface SessionTimelineResponse extends ApiEnvelope {
  timelineVersion?: string;
  session?: SessionRecord;
  lineage?: SessionLineage;
  stateMachine?: ApiEnvelope;
  timeline: TimelineEntry[];
}

export interface JobTimelineLineage extends ApiEnvelope {
  sessionIds?: SessionId[];
  childJobIds?: JobId[];
  terminalSessionIds?: SessionId[];
}

export interface JobTimelineResponse extends ApiEnvelope {
  timelineVersion?: string;
  job?: JobDefinition;
  lineage?: JobTimelineLineage;
  summary?: ApiEnvelope;
  timeline: TimelineEntry[];
}

export interface JobTimelineOptions {
  limit?: number;
}

export interface SessionListResponse extends ApiEnvelope {
  sessions: SessionRecord[];
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
  scope?: "wallet" | "operator" | string;
}

export interface DisputeSummary extends ApiEnvelope {
  id: string;
  sessionId?: SessionId;
  status?: string;
  verdict?: string;
}

export interface DisputeListResponse extends ApiEnvelope {
  disputes?: DisputeSummary[];
  count?: number;
}

export interface DisputeVerdictInput {
  verdict: string;
  rationale?: string;
}

export interface SubJobCreateInput extends ApiEnvelope {
  parentSessionId: SessionId;
  id: JobId;
  category: string;
  tier?: string;
  rewardAmount: number | string;
  rewardAsset?: AssetSymbol;
  verifierMode: string;
  verifierTerms?: string[];
  verifierMinimumMatches?: number;
  claimTtlSeconds?: number;
  retryLimit?: number;
}

export interface SubJobListItem extends JobSummary {
  sessions?: SessionRecord[];
}

export type SubJobListResponse = SubJobListItem[];

export interface FireRecurringJobOptions {
  firedAt?: ISODateTime;
  idempotencyKey?: IdempotencyKey;
}

export interface AdminJobCreateInput extends ApiEnvelope {
  id: JobId;
  category: string;
  rewardAmount: number | string;
  rewardAsset?: AssetSymbol;
  verifierMode: string;
  tier?: string;
  retryLimit?: number;
  delegationPolicy?: DelegationPolicy;
  recurring?: boolean;
  recurringPolicy?: RecurringPolicy;
}

export interface AdminStatusResponse extends ApiEnvelope {
  jobLifecycle?: {
    total?: number;
    claimable?: number;
    open?: number;
    paused?: number;
    archived?: number;
    stale?: number;
    [key: string]: unknown;
  };
  recurringJobs?: ApiEnvelope;
  providerOperations?: ApiEnvelope;
}

export class AgentPlatformApiError extends Error {
  constructor(options: {
    message: string;
    status: number;
    method: string;
    path: string;
    payload?: unknown;
  });

  name: "AgentPlatformApiError";
  status: number;
  method: string;
  path: string;
  payload?: unknown;
  code?: string;
  details?: unknown;
}

export class AgentPlatformClient {
  constructor(options?: AgentPlatformClientOptions);

  baseUrl: string;
  token?: string;
  fetchImpl: typeof fetch;

  setToken(token?: string): void;

  getHealth(): Promise<HealthResponse>;
  getOnboarding(): Promise<OnboardingResponse>;
  getDiscoveryManifest(): Promise<DiscoveryManifest>;
  getJobTierLadder(): Promise<JobTierLadderResponse>;
  listStrategies(): Promise<StrategiesResponse>;
  getSessionStateMachine(): Promise<SessionStateMachineResponse>;
  listJobSchemas(): Promise<JobSchemasResponse>;
  getJobSchema(name: string): Promise<JsonObject>;
  getAgentProfile(wallet: WalletAddress): Promise<AgentProfile>;
  listAgents(options?: { limit?: number }): Promise<AgentListResponse>;
  getAgentBadge(sessionId: SessionId): Promise<BadgeResponse>;
  listBadges(options?: { limit?: number }): Promise<BadgeResponse[] | ApiEnvelope>;
  listAlerts(options?: { limit?: number }): Promise<AlertListResponse>;
  listAuditEvents(options?: { limit?: number }): Promise<AuditEventListResponse>;
  listPolicies(): Promise<PolicyListResponse>;
  getPolicy(tag: string): Promise<PolicySummary>;
  proposePolicy(payload: unknown): Promise<PolicySummary>;
  listVerifierHandlers(): Promise<VerifierHandlersResponse>;

  issueNonce(wallet: WalletAddress): Promise<NonceResponse>;
  verifySignature(message: string, signature: string): Promise<AuthSessionResponse>;
  getAuthSession(): Promise<AuthSessionResponse>;

  getAccountSummary(): Promise<AccountSummary>;
  getBorrowCapacity(asset?: AssetSymbol): Promise<BorrowCapacityResponse>;
  getStrategyPositions(): Promise<StrategyPositionsResponse>;
  fundAccount(input: FundAccountInput): Promise<AccountSummary>;
  allocateIdleFunds(input: StrategyMutationInput): Promise<AccountSummary>;
  deallocateIdleFunds(input: StrategyMutationInput): Promise<AccountSummary>;
  sendToAgent(input: SendToAgentInput): Promise<AccountSummary>;
  borrowFunds(input: BalanceMutationInput): Promise<AccountSummary>;
  repayFunds(input: BalanceMutationInput): Promise<AccountSummary>;

  listJobs(options?: ListJobsOptions): Promise<JobsListResponse>;
  listClaimableJobs(options?: ListJobsOptions): Promise<JobsListResponse>;
  getJobDefinition(jobId: JobId): Promise<JobDefinition>;
  getRecommendations(): Promise<RecommendationResponse>;
  preflightJob(jobId: JobId): Promise<PreflightResponse>;
  validateJobSubmission<TSubmission extends StructuredSubmission = StructuredSubmission>(
    jobId: JobId,
    submission: TSubmission
  ): Promise<ValidationResponse<TSubmission>>;
  claimJob(jobId: JobId, idempotencyKey?: IdempotencyKey): Promise<ClaimResponse>;
  submitWork<TSubmission extends StructuredSubmission = StructuredSubmission>(
    sessionId: SessionId,
    submission: string | TSubmission
  ): Promise<SubmitResponse>;
  getSession(sessionId: SessionId): Promise<SessionRecord>;
  getSessionTimeline(sessionId: SessionId): Promise<SessionTimelineResponse>;
  getJobTimeline(jobId: JobId, options?: JobTimelineOptions): Promise<JobTimelineResponse>;
  listSessions(options?: { limit?: number; jobId?: JobId }): Promise<SessionListResponse>;
  listAdminSessions(options?: {
    limit?: number;
    jobId?: JobId;
    wallet?: WalletAddress;
  }): Promise<SessionListResponse>;
  listSubJobs(parentSessionId: SessionId): Promise<SubJobListResponse>;
  createSubJob(payload: SubJobCreateInput): Promise<JobDefinition>;

  listDisputes(options?: { limit?: number }): Promise<DisputeListResponse>;
  getDispute(id: string): Promise<DisputeSummary>;
  submitDisputeVerdict(id: string, input: DisputeVerdictInput): Promise<DisputeSummary>;
  releaseDisputeStake(id: string, payload?: unknown): Promise<DisputeSummary>;

  runVerifier(sessionId: SessionId, evidence?: string, metadataURI?: string): Promise<ApiEnvelope>;
  replayVerifier(sessionId: SessionId): Promise<ApiEnvelope>;
  getVerifierResult(sessionId: SessionId): Promise<ApiEnvelope>;

  createJob(payload: AdminJobCreateInput): Promise<JobDefinition>;
  fireRecurringJob(templateId: JobId, options?: FireRecurringJobOptions): Promise<JobDefinition>;
  pauseRecurringJob(templateId: JobId, options?: { idempotencyKey?: IdempotencyKey }): Promise<ApiEnvelope>;
  resumeRecurringJob(templateId: JobId, options?: { idempotencyKey?: IdempotencyKey }): Promise<ApiEnvelope>;
  getAdminStatus(): Promise<AdminStatusResponse>;

  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
}
`;
