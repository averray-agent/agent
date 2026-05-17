/**
 * Small JS client for the Averray agent platform.
 *
 * This intentionally mirrors the current HTTP surface rather than hiding it
 * behind a large abstraction layer. The goal is to give operators and builders
 * one typed-ish place to call auth, jobs, sessions, verifier, and admin
 * routes without repeating raw fetch glue.
 */
export const DEFAULT_ESCROW_ASSET_SYMBOL = "USDC";

/**
 * Build a caller-side idempotency key suitable for the standard mutation contract.
 *
 * The returned key embeds the operation prefix, an ISO timestamp, and a random
 * suffix (WebCrypto when available) so it is unique across processes and easy
 * to recognize in audit logs. Callers that need strict deterministic replay
 * (e.g. a worker resuming from durable state) should persist their own key
 * instead of generating a fresh one on each retry; this helper exists for
 * the common "one-shot run, retry the same call on transient failure" case.
 *
 * See docs/IDEMPOTENCY.md for the full contract.
 *
 * @param {string} [prefix="run"] - Short operation tag, e.g. "claim", "borrow", "fire".
 * @returns {string}
 */
export function createIdempotencyKey(prefix = "run") {
  const safePrefix = String(prefix ?? "run").trim().replace(/[^a-zA-Z0-9_-]+/gu, "-") || "run";
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const suffix = generateRandomSuffix();
  return `${safePrefix}-${timestamp}-${suffix}`;
}

function generateRandomSuffix() {
  const cryptoImpl = globalThis.crypto;
  if (cryptoImpl?.randomUUID) {
    return cryptoImpl.randomUUID().split("-")[0];
  }
  if (cryptoImpl?.getRandomValues) {
    const bytes = new Uint8Array(6);
    cryptoImpl.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Last-resort fallback for environments without WebCrypto. Not collision-proof
  // across processes, so callers in such environments should supply their own keys.
  return `${Date.now().toString(16)}-${Math.floor(Math.random() * 1e9).toString(16)}`;
}

export class AgentPlatformClient {
  constructor({ baseUrl, token = undefined, fetchImpl = fetch } = {}) {
    if (!baseUrl) {
      throw new Error("baseUrl is required");
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/u, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  setToken(token) {
    this.token = token;
  }

  async getHealth() {
    return this.request("/health");
  }

  async getOnboarding() {
    return this.request("/onboarding");
  }

  async getDiscoveryManifest() {
    return this.request("/agent-tools.json");
  }

  async getJobTierLadder() {
    return this.request("/jobs/tiers");
  }

  async listStrategies() {
    return this.request("/strategies");
  }

  async getSessionStateMachine() {
    return this.request("/session/state-machine");
  }

  async listJobSchemas() {
    return this.request("/schemas/jobs");
  }

  async getJobSchema(name) {
    return this.request(`/schemas/jobs/${encodeURIComponent(name)}`);
  }

  async getAgentProfile(wallet) {
    return this.request(`/agents/${encodeURIComponent(wallet)}`);
  }

  async listAgents({ limit = undefined } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    return this.request(`/agents${params.size ? `?${params.toString()}` : ""}`);
  }

  async getAgentBadge(sessionId) {
    return this.request(`/badges/${encodeURIComponent(sessionId)}`);
  }

  async listBadges({ limit = undefined } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    return this.request(`/badges${params.size ? `?${params.toString()}` : ""}`);
  }

  async listAlerts({ limit = undefined } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    return this.request(`/alerts${params.size ? `?${params.toString()}` : ""}`);
  }

  async listAuditEvents({ limit = undefined } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    return this.request(`/audit${params.size ? `?${params.toString()}` : ""}`);
  }

  async listPolicies() {
    return this.request("/policies");
  }

  async getPolicy(tag) {
    return this.request(`/policies/${encodeURIComponent(tag)}`);
  }

  async proposePolicy(payload) {
    return this.request("/policies", {
      method: "POST",
      body: payload
    });
  }

  async listVerifierHandlers() {
    return this.request("/verifier/handlers");
  }

  async issueNonce(wallet) {
    return this.request("/auth/nonce", {
      method: "POST",
      body: { wallet }
    });
  }

  async verifySignature(message, signature) {
    return this.request("/auth/verify", {
      method: "POST",
      body: { message, signature }
    });
  }

  async getAuthSession() {
    return this.request("/auth/session");
  }

  async getAccountSummary() {
    return this.request("/account");
  }

  async getBorrowCapacity(asset = DEFAULT_ESCROW_ASSET_SYMBOL) {
    return this.request(`/account/borrow-capacity?asset=${encodeURIComponent(asset)}`);
  }

  async getStrategyPositions() {
    return this.request("/account/strategies");
  }

  /** Use a stable `idempotencyKey` per intended fund operation so retries collapse. See docs/IDEMPOTENCY.md. */
  async fundAccount({ asset = DEFAULT_ESCROW_ASSET_SYMBOL, amount, idempotencyKey = undefined } = {}) {
    return this.request("/account/fund", {
      method: "POST",
      body: compact({ asset, amount, idempotencyKey })
    });
  }

  /** Use a stable `idempotencyKey` per intended allocation; sync and async strategy retries replay safely. See docs/IDEMPOTENCY.md. */
  async allocateIdleFunds({ asset = DEFAULT_ESCROW_ASSET_SYMBOL, amount, strategyId = "default-low-risk", ...options } = {}) {
    return this.request("/account/allocate", {
      method: "POST",
      body: compact({ asset, amount, strategyId, ...options })
    });
  }

  /** Use a stable `idempotencyKey` per intended deallocation; sync and async strategy retries replay safely. See docs/IDEMPOTENCY.md. */
  async deallocateIdleFunds({ asset = DEFAULT_ESCROW_ASSET_SYMBOL, amount, strategyId = "default-low-risk", ...options } = {}) {
    return this.request("/account/deallocate", {
      method: "POST",
      body: compact({ asset, amount, strategyId, ...options })
    });
  }

  /** Use a stable `idempotencyKey` per intended transfer so retries do not double-send. See docs/IDEMPOTENCY.md. */
  async sendToAgent({ recipient, asset = DEFAULT_ESCROW_ASSET_SYMBOL, amount, idempotencyKey = undefined } = {}) {
    return this.request("/payments/send", {
      method: "POST",
      body: compact({ recipient, asset, amount, idempotencyKey })
    });
  }

  /** Use a stable `idempotencyKey` per intended borrow so retries collapse. See docs/IDEMPOTENCY.md. */
  async borrowFunds({ asset = DEFAULT_ESCROW_ASSET_SYMBOL, amount, idempotencyKey = undefined } = {}) {
    return this.request("/account/borrow", {
      method: "POST",
      body: compact({ asset, amount, idempotencyKey })
    });
  }

  /** Use a stable `idempotencyKey` per intended repay so retries collapse. See docs/IDEMPOTENCY.md. */
  async repayFunds({ asset = DEFAULT_ESCROW_ASSET_SYMBOL, amount, idempotencyKey = undefined } = {}) {
    return this.request("/account/repay", {
      method: "POST",
      body: compact({ asset, amount, idempotencyKey })
    });
  }

  async listJobs({
    wallet = undefined,
    source = undefined,
    category = undefined,
    state = undefined,
    format = undefined,
    limit = undefined,
    offset = undefined
  } = {}) {
    const params = new URLSearchParams();
    if (wallet) params.set("wallet", wallet);
    if (source) params.set("source", source);
    if (category) params.set("category", category);
    if (state) params.set("state", state);
    if (format) params.set("format", format);
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    return this.request(`/jobs${params.size ? `?${params.toString()}` : ""}`);
  }

  async listClaimableJobs(options = {}) {
    return this.listJobs({
      format: "compact",
      ...options,
      state: options.state ?? "claimable"
    });
  }

  async getJobDefinition(jobId) {
    return this.request(`/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
  }

  async getRecommendations() {
    return this.request("/jobs/recommendations");
  }

  async preflightJob(jobId) {
    return this.request(`/jobs/preflight?jobId=${encodeURIComponent(jobId)}`);
  }

  async validateJobSubmission(jobId, submission) {
    return this.request("/jobs/validate-submission", {
      method: "POST",
      body: {
        jobId,
        submission
      }
    });
  }

  async assertValidJobSubmission(jobId, submission) {
    const validation = await this.validateJobSubmission(jobId, submission);
    if (!isSubmitSafeValidation(validation)) {
      throw new AgentPlatformValidationError({
        message: validation?.message ?? "Submission validation failed; refusing to mutate.",
        validation
      });
    }
    return validation;
  }

  /**
   * Non-mutating schema-native guard for helper workflows.
   *
   * This validates the exact direct submission object and, for structured
   * drafts, checks that an intentionally bad `submission.output` wrapper is
   * rejected before any claim/submit mutation is attempted.
   */
  async assertSchemaNativeSubmissionReady(jobId, submission, {
    expectedSchemaRef = undefined,
    requireInvalidWrapperRejection = isStructuredObject(submission),
    invalidWrappedOutputProbe = {
      output: {
        wrapped_under_submission_output: true
      }
    }
  } = {}) {
    const validation = await this.assertValidJobSubmission(jobId, submission);
    const schemaRef = validation?.schemaRef ?? expectedSchemaRef ?? null;
    if (expectedSchemaRef && schemaRef && schemaRef !== expectedSchemaRef) {
      throw new AgentPlatformValidationError({
        message: `Submission validation schema mismatch: expected ${expectedSchemaRef}, got ${schemaRef}.`,
        validation
      });
    }

    const readiness = {
      jobId,
      valid: true,
      submitSafe: true,
      schemaRef,
      schemaValidates: validation?.schemaValidates ?? "payload.submission",
      submissionKind: validation?.submissionKind ?? (isStructuredObject(submission) ? "structured" : "raw"),
      validatedBeforeClaim: true,
      directValidation: validation,
      invalidWrappedOutput: null
    };

    if (!requireInvalidWrapperRejection) {
      return readiness;
    }

    const invalidValidation = await this.validateJobSubmission(jobId, invalidWrappedOutputProbe);
    if (invalidValidation?.jobId && invalidValidation.jobId !== jobId) {
      throw new AgentPlatformValidationError({
        message: `Invalid-wrapper validation job id mismatch: expected ${jobId}, got ${invalidValidation.jobId}.`,
        validation: invalidValidation
      });
    }
    if (invalidValidation?.valid !== false || invalidValidation?.submitSafe !== false) {
      throw new AgentPlatformValidationError({
        message: "Invalid submission.output wrapper unexpectedly passed validation; refusing to mutate.",
        validation: invalidValidation
      });
    }
    const invalidSchemaRef = invalidValidation?.schemaRef ?? schemaRef ?? expectedSchemaRef ?? null;
    if (expectedSchemaRef && invalidSchemaRef && invalidSchemaRef !== expectedSchemaRef) {
      throw new AgentPlatformValidationError({
        message: `Invalid-wrapper validation schema mismatch: expected ${expectedSchemaRef}, got ${invalidSchemaRef}.`,
        validation: invalidValidation
      });
    }

    readiness.invalidWrappedOutput = {
      jobId,
      valid: false,
      submitSafe: false,
      schemaRef: invalidSchemaRef,
      schemaValidates: invalidValidation?.schemaValidates ?? "payload.submission",
      code: invalidValidation?.code ?? null,
      message: invalidValidation?.message ?? null,
      path: invalidValidation?.path ?? invalidValidation?.errorPaths?.[0] ?? null,
      received: invalidValidation?.details?.received ?? null,
      hint: invalidValidation?.details?.hint ?? null,
      checkedBeforeClaim: true,
      submitAttempted: false,
      validation: invalidValidation
    };

    return readiness;
  }

  /** Validate the exact draft first; only then consume a claim attempt. */
  async claimJobAfterValidation(jobId, submission, idempotencyKey = undefined) {
    await this.assertValidJobSubmission(jobId, submission);
    return this.claimJob(jobId, idempotencyKey);
  }

  /** Omit `idempotencyKey` to inherit the server default of `<wallet>:<jobId>`; pass one to scope per run. See docs/IDEMPOTENCY.md. */
  async claimJob(jobId, idempotencyKey = undefined) {
    return this.request("/jobs/claim", {
      method: "POST",
      body: {
        jobId,
        ...(idempotencyKey ? { idempotencyKey } : {})
      }
    });
  }

  async submitWork(sessionId, submission) {
    return this.request("/jobs/submit", {
      method: "POST",
      body: {
        sessionId,
        ...(typeof submission === "string" ? { evidence: submission } : { submission })
      }
    });
  }

  /** Validate the exact draft first; only then send the submit mutation. */
  async submitValidatedWork(jobId, sessionId, submission) {
    await this.assertValidJobSubmission(jobId, submission);
    return this.submitWork(sessionId, submission);
  }

  async getSession(sessionId) {
    return this.request(`/session?sessionId=${encodeURIComponent(sessionId)}`);
  }

  async getSessionTimeline(sessionId) {
    return this.request(`/session/timeline?sessionId=${encodeURIComponent(sessionId)}`);
  }

  async getJobTimeline(jobId, { limit = undefined } = {}) {
    const params = new URLSearchParams({ jobId });
    if (limit !== undefined) params.set("limit", String(limit));
    return this.request(`/admin/jobs/timeline?${params.toString()}`);
  }

  async listSessions({ limit = undefined, jobId = undefined } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (jobId) params.set("jobId", jobId);
    return this.request(`/sessions${params.size ? `?${params.toString()}` : ""}`);
  }

  async listAdminSessions({ limit = undefined, jobId = undefined, wallet = undefined } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (jobId) params.set("jobId", jobId);
    if (wallet) params.set("wallet", wallet);
    return this.request(`/admin/sessions${params.size ? `?${params.toString()}` : ""}`);
  }

  async listDisputes({ limit = undefined } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    return this.request(`/disputes${params.size ? `?${params.toString()}` : ""}`);
  }

  async getDispute(id) {
    return this.request(`/disputes/${encodeURIComponent(id)}`);
  }

  async submitDisputeVerdict(id, { verdict, rationale = undefined } = {}) {
    return this.request(`/disputes/${encodeURIComponent(id)}/verdict`, {
      method: "POST",
      body: compact({ verdict, rationale })
    });
  }

  async releaseDisputeStake(id, payload = {}) {
    return this.request(`/disputes/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: payload
    });
  }

  async listSubJobs(parentSessionId) {
    return this.request(`/jobs/sub?parentSessionId=${encodeURIComponent(parentSessionId)}`);
  }

  async createSubJob(payload) {
    return this.request("/jobs/sub", {
      method: "POST",
      body: payload
    });
  }

  async runVerifier(sessionId, evidence = undefined, metadataURI = undefined) {
    return this.request("/verifier/run", {
      method: "POST",
      body: compact({
        sessionId,
        evidence,
        metadataURI
      })
    });
  }

  async replayVerifier(sessionId) {
    return this.request("/verifier/replay", {
      method: "POST",
      body: { sessionId }
    });
  }

  async getVerifierResult(sessionId) {
    return this.request(`/verifier/result?sessionId=${encodeURIComponent(sessionId)}`);
  }

  async createJob(payload) {
    return this.request("/admin/jobs", {
      method: "POST",
      body: payload
    });
  }

  /** Pass a unique `idempotencyKey` per intended fire; replays with the same key and payload return the stored receipt. See docs/IDEMPOTENCY.md. */
  async fireRecurringJob(templateId, { firedAt = undefined, idempotencyKey = undefined } = {}) {
    return this.request("/admin/jobs/fire", {
      method: "POST",
      body: compact({ templateId, firedAt, idempotencyKey })
    });
  }

  /** Use a stable `idempotencyKey` (e.g. `pause-${templateId}-${reasonTag}`) so retries collapse. See docs/IDEMPOTENCY.md. */
  async pauseRecurringJob(templateId, { idempotencyKey = undefined } = {}) {
    return this.request("/admin/jobs/pause", {
      method: "POST",
      body: compact({ templateId, idempotencyKey })
    });
  }

  /** Use a stable `idempotencyKey` (e.g. `resume-${templateId}-${reasonTag}`) so retries collapse. See docs/IDEMPOTENCY.md. */
  async resumeRecurringJob(templateId, { idempotencyKey = undefined } = {}) {
    return this.request("/admin/jobs/resume", {
      method: "POST",
      body: compact({ templateId, idempotencyKey })
    });
  }

  async getAdminStatus() {
    return this.request("/admin/status");
  }

  async listServiceTokens({ subject = undefined, status = undefined, limit = undefined, offset = undefined } = {}) {
    const params = new URLSearchParams();
    if (subject) params.set("subject", subject);
    if (status) params.set("status", status);
    if (limit !== undefined) params.set("limit", String(limit));
    if (offset !== undefined) params.set("offset", String(offset));
    return this.request(`/admin/service-tokens${params.size ? `?${params.toString()}` : ""}`);
  }

  async issueServiceToken({
    subject,
    capabilities,
    scope = undefined,
    note = undefined,
    expiresAt = undefined,
    tokenTtlSeconds = undefined,
    idempotencyKey = undefined
  } = {}) {
    if (typeof subject !== "string" || !subject) {
      throw new TypeError("issueServiceToken requires a non-empty `subject` wallet.");
    }
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new TypeError("issueServiceToken requires a non-empty `capabilities` array.");
    }
    return this.request("/admin/service-tokens", {
      method: "POST",
      body: compact({ subject, capabilities, scope, note, expiresAt, tokenTtlSeconds, idempotencyKey })
    });
  }

  async rotateServiceToken(grantId, {
    capabilities = undefined,
    scope = undefined,
    note = undefined,
    expiresAt = undefined,
    tokenTtlSeconds = undefined,
    revokeNote = undefined,
    idempotencyKey = undefined
  } = {}) {
    if (typeof grantId !== "string" || !grantId) {
      throw new TypeError("rotateServiceToken requires a non-empty `grantId`.");
    }
    return this.request(`/admin/service-tokens/${encodeURIComponent(grantId)}/rotate`, {
      method: "POST",
      body: compact({ capabilities, scope, note, expiresAt, tokenTtlSeconds, revokeNote, idempotencyKey })
    });
  }

  /** Use a stable `idempotencyKey` per revoke decision so duplicate requests collapse to one receipt. See docs/IDEMPOTENCY.md. */
  async revokeServiceToken(grantId, { note = undefined, idempotencyKey = undefined } = {}) {
    if (typeof grantId !== "string" || !grantId) {
      throw new TypeError("revokeServiceToken requires a non-empty `grantId`.");
    }
    return this.request(`/admin/service-tokens/${encodeURIComponent(grantId)}/revoke`, {
      method: "POST",
      body: compact({ note, idempotencyKey })
    });
  }

  async request(path, { method = "GET", body = undefined, headers = {} } = {}) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("accept", "application/json");
    if (body !== undefined) {
      requestHeaders.set("content-type", "application/json");
    }
    if (this.token) {
      requestHeaders.set("authorization", `Bearer ${this.token}`);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const payload = text ? safeJsonParse(text) : undefined;
    if (!response.ok) {
      throw new AgentPlatformApiError({
        message: payload?.message ?? payload?.error ?? `${method} ${path} failed with ${response.status}`,
        status: response.status,
        method,
        path,
        payload
      });
    }
    return payload;
  }
}

export class AgentPlatformApiError extends Error {
  constructor({ message, status, method, path, payload }) {
    super(message);
    this.name = "AgentPlatformApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.payload = payload;
    this.code = payload?.code ?? payload?.error ?? undefined;
    this.details = payload?.details ?? undefined;
  }
}

export class AgentPlatformValidationError extends Error {
  constructor({ message, validation }) {
    super(message);
    this.name = "AgentPlatformValidationError";
    this.code = validation?.code ?? "submission_validation_failed";
    this.validation = validation;
    this.details = validation?.details ?? undefined;
  }
}

function isSubmitSafeValidation(validation) {
  return validation?.valid === true && validation?.submitSafe !== false;
}

function isStructuredObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
