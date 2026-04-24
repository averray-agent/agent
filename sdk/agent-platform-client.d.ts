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

export interface FundAccountInput {
  asset?: string;
  amount: number | string;
}

export interface StrategyMutationInput {
  asset?: string;
  amount: number | string;
  strategyId?: string;
  idempotencyKey?: string;
  destination?: string;
  message?: string;
  maxWeight?: unknown;
  nonce?: number | string;
  recipient?: string;
}

export interface SendToAgentInput {
  recipient: string;
  asset?: string;
  amount: number | string;
}

export interface FireRecurringJobOptions {
  firedAt?: string;
  idempotencyKey?: string;
}

export class AgentPlatformClient {
  constructor(options?: AgentPlatformClientOptions);

  baseUrl: string;
  token?: string;
  fetchImpl: typeof fetch;

  setToken(token?: string): void;

  getHealth(): Promise<unknown>;
  getOnboarding(): Promise<unknown>;
  getDiscoveryManifest(): Promise<unknown>;
  getJobTierLadder(): Promise<unknown>;
  listStrategies(): Promise<unknown>;
  getSessionStateMachine(): Promise<unknown>;
  listJobSchemas(): Promise<unknown>;
  getJobSchema(name: string): Promise<unknown>;
  getAgentProfile(wallet: string): Promise<unknown>;
  listAgents(options?: { limit?: number }): Promise<unknown>;
  getAgentBadge(sessionId: string): Promise<unknown>;
  listBadges(options?: { limit?: number }): Promise<unknown>;
  listAlerts(options?: { limit?: number }): Promise<unknown>;
  listAuditEvents(options?: { limit?: number }): Promise<unknown>;
  listPolicies(): Promise<unknown>;
  getPolicy(tag: string): Promise<unknown>;
  proposePolicy(payload: unknown): Promise<unknown>;
  listVerifierHandlers(): Promise<unknown>;

  issueNonce(wallet: string): Promise<unknown>;
  verifySignature(message: string, signature: string): Promise<unknown>;
  getAuthSession(): Promise<unknown>;

  getAccountSummary(): Promise<unknown>;
  getBorrowCapacity(asset?: string): Promise<unknown>;
  getStrategyPositions(): Promise<unknown>;
  fundAccount(input: FundAccountInput): Promise<unknown>;
  allocateIdleFunds(input: StrategyMutationInput): Promise<unknown>;
  deallocateIdleFunds(input: StrategyMutationInput): Promise<unknown>;
  sendToAgent(input: SendToAgentInput): Promise<unknown>;

  listJobs(): Promise<unknown>;
  getJobDefinition(jobId: string): Promise<unknown>;
  getRecommendations(): Promise<unknown>;
  preflightJob(jobId: string): Promise<unknown>;
  claimJob(jobId: string, idempotencyKey?: string): Promise<unknown>;
  submitWork(sessionId: string, submission: string | unknown): Promise<unknown>;
  getSession(sessionId: string): Promise<unknown>;
  getSessionTimeline(sessionId: string): Promise<unknown>;
  listSessions(options?: { limit?: number; jobId?: string }): Promise<unknown>;
  listSubJobs(parentSessionId: string): Promise<unknown>;
  createSubJob(payload: unknown): Promise<unknown>;

  runVerifier(sessionId: string, evidence?: string, metadataURI?: string): Promise<unknown>;
  replayVerifier(sessionId: string): Promise<unknown>;
  getVerifierResult(sessionId: string): Promise<unknown>;

  createJob(payload: unknown): Promise<unknown>;
  fireRecurringJob(templateId: string, options?: FireRecurringJobOptions): Promise<unknown>;
  pauseRecurringJob(templateId: string): Promise<unknown>;
  resumeRecurringJob(templateId: string): Promise<unknown>;
  getAdminStatus(): Promise<unknown>;

  request(path: string, options?: RequestOptions): Promise<unknown>;
}
