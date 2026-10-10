import { randomUUID } from "node:crypto";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { validateAgainstSchemaAll } from "../core/job-schema-validation.js";
import { buildVerifyReceipt } from "../core/work-receipt.js";
import { VerifierRegistry } from "./verifier-handlers.js";
import { MCP_FAILURE_SEMANTICS_PROFILE_REF, VERIFY_INCONCLUSIVE_REASONS } from "./verification-profile-registry.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const COMPLETE = "complete";
const VERIFY_REQUEST_ENVELOPE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["profile", "profileVersion", "target", "inputs"],
  properties: {
    profile: { type: "string", minLength: 1 },
    profileVersion: { type: "integer", minimum: 1 },
    target: { type: "object" },
    inputs: { type: "object" }
  }
});

export class VerificationRunService {
  constructor({
    stateStore,
    profileRegistry,
    paymentGate = new UnavailableVerificationPaymentGate(),
    badgeReceiptSigner,
    executionDispatcher = undefined,
    verifierRegistry = new VerifierRegistry(),
    now = () => new Date(),
    randomUUIDImpl = randomUUID,
    publicReceiptBaseUrl = undefined,
    selfIdentityRegistry = undefined,
    runnerTimeoutMarginMs = 30_000,
    logger = console,
    finalizerLockSeconds = 30,
    finalizerId = `verification-finalizer:${randomUUID()}`
  } = {}) {
    if (!stateStore || !profileRegistry) {
      throw new ValidationError("VerificationRunService requires state and profiles.");
    }
    this.stateStore = stateStore;
    this.profileRegistry = profileRegistry;
    this.paymentGate = paymentGate;
    this.badgeReceiptSigner = badgeReceiptSigner;
    this.executionDispatcher = executionDispatcher;
    this.verifierRegistry = verifierRegistry;
    this.now = now;
    this.randomUUIDImpl = randomUUIDImpl;
    this.publicReceiptBaseUrl = publicReceiptBaseUrl;
    this.selfIdentityRegistry = selfIdentityRegistry;
    this.runnerTimeoutMarginMs = positiveInteger(runnerTimeoutMarginMs, "runnerTimeoutMarginMs");
    this.finalizerLockSeconds = positiveInteger(finalizerLockSeconds, "finalizerLockSeconds");
    this.finalizerId = String(finalizerId);
    this.logger = logger;
  }

  listProfiles() {
    return this.profileRegistry.list();
  }

  async requireDiscoveryPayment() {
    // Discovery has no executable input. Quote the published URL-only example
    // through the same gate, without ever entering createRun/reservation.
    const [name, version] = MCP_FAILURE_SEMANTICS_PROFILE_REF.split("@");
    const profile = this.profileRegistry.requireAvailable(name, Number(version));
    const { target, inputs } = profile.workedExample.request;
    await this.paymentGate.authorize({
      price: profile.price,
      profile: profile.ref,
      profileLimits: profile.limits,
      requestHash: hashCanonicalContent({ profile: profile.ref, target, inputs })
    });
    // A demo/custom gate accepting an absent proof must not create a run either.
    throw new AppError("Verify discovery requires a payment challenge; no run was created.", {
      code: "verification_discovery_unavailable", statusCode: 503
    });
  }

  async getRun(runId) {
    const normalized = String(runId ?? "").trim();
    if (!normalized) throw new ValidationError("runId is required.");
    const run = await this.stateStore.getVerificationRun(normalized);
    if (!run) throw new NotFoundError(`Verification run ${normalized} was not found.`, "verification_run_not_found");
    return publicRun(run);
  }

  async createRun({
    profile: profileName,
    profileVersion,
    target,
    inputs,
    paymentProof,
    ephemeralCredential
  } = {}) {
    const profile = validateVerificationRunRequest({
      profile: profileName,
      profileVersion,
      target,
      inputs
    }, this.profileRegistry);
    assertMcpEndpointCredentialBoundary(profile.ref, target);
    assertEphemeralCredential({ target, ephemeralCredential });
    const requestHash = hashCanonicalContent({ profile: profile.ref, target, inputs });
    const paymentKey = paymentProof === undefined || paymentProof === null || paymentProof === ""
      ? undefined
      : hashCanonicalContent(paymentProof);
    if (paymentKey) {
      const existing = await this.stateStore.getVerificationRunByPaymentId(paymentKey);
      if (existing) return publicRun(requireMatchingVerificationReplay(existing, requestHash));
    }

    const authorization = await this.paymentGate.authorize({
      paymentProof,
      price: profile.price,
      profile: profile.ref,
      profileLimits: profile.limits,
      requestHash,
      findExistingRun: (authorizationId) => this.stateStore.getVerificationRunByAuthorizationId(authorizationId)
    });
    assertPaymentAuthorization(authorization, profile);
    if (authorization.existingRun) return publicRun(requireMatchingVerificationReplay(authorization.existingRun, requestHash));
    const runId = `verify-${this.randomUUIDImpl()}`;
    const submittedAt = this.now().toISOString();
    const queued = {
      runId,
      profile: profile.name,
      profileVersion: profile.version,
      profileRef: profile.ref,
      requestHash,
      customer: authorization.customer.toLowerCase(),
      target: structuredClone(target),
      inputs: structuredClone(inputs),
      submittedAt,
      status: "queued",
      billing: { status: "authorized", amountRaw: profile.price.amountRaw, asset: profile.price.asset }
    };
    const reservation = await this.stateStore.reserveVerificationRun(queued, {
      paymentId: paymentKey ?? hashCanonicalContent(authorization.id),
      authorization: persistableAuthorization(authorization),
      reservationTtlSeconds: authorization.authorization?.validBefore === undefined ? 86400
        : Number(BigInt(authorization.authorization.validBefore) - BigInt(Math.floor(this.now().getTime() / 1000))) + 86400
    });
    if (reservation.created && this.executionDispatcher?.supports?.(profile.ref)) {
      await this.executionDispatcher.start({
        run: reservation.run,
        profile,
        ephemeralCredential
      });
      return publicRun(await this.stateStore.getVerificationRun(reservation.run.runId) ?? reservation.run);
    }
    return publicRun(reservation.run);
  }

  async finalizeAvailableRuns({ limit = 100 } = {}) {
    const active = [];
    // Select before mutating the active index: completing a row must not shift
    // paging offsets. Not-due captures do not consume the batch or issue RPC.
    for (let offset = 0; active.length < limit;) {
      const pageSize = Math.min(100, limit - active.length);
      const page = await this.stateStore.listActiveVerificationRuns(pageSize, { offset, dueBefore: this.now().getTime() });
      for (const run of page) {
        try {
          if (this.executionReadyForFinalization(run)) active.push(run);
        } catch (error) {
          this.logger.warn?.({ runId: run.runId, errorName: error?.name, errorCode: error?.code }, "verification_run.finalization_retry");
        }
        if (active.length >= limit) break;
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    const finalized = [];
    for (const candidate of active) {
      try {
        if (!this.executionReadyForFinalization(candidate)) continue;
        const lockId = verificationRunLockId(candidate.runId);
        const acquired = await this.stateStore.acquireClaimLock(
          lockId, this.finalizerId, this.finalizerLockSeconds
        );
        if (!acquired) continue;
        try {
          const current = await this.stateStore.getVerificationRun(candidate.runId);
          if (!this.executionReadyForFinalization(current)) continue;
          const profile = this.profileRegistry.get(current.profile, current.profileVersion);
          const authorization = await this.stateStore.getVerificationRunAuthorization(current.runId);
          const execution = current.status === "executed"
            ? current.execution
            : runnerTimeoutExecution(current.status);
          const completed = await this.finalizeExecution({ authorization, profile, run: current, execution });
          if (completed.status === COMPLETE) finalized.push(completed);
        } finally {
          await this.stateStore.releaseClaimLock(lockId, this.finalizerId);
        }
      } catch (error) {
        // Retain unfinished state for the next tick; never log payment proofs.
        this.logger.warn?.({ runId: candidate.runId, errorName: error?.name, errorCode: error?.code }, "verification_run.finalization_retry");
        await this.stateStore.getVerificationRun(candidate.runId).then((pending) =>
          pending?.billing?.status === "capturing" ? this.deferCapture(pending) : undefined
        ).catch(() => undefined);
      }
    }
    return finalized;
  }

  executionReadyForFinalization(run) {
    if (!run || run.status === COMPLETE) return false;
    if (Date.parse(run.billing?.nextCaptureAttemptAt) > this.now().getTime()) return false;
    if (run.status === "executed") return true;
    if (!new Set(["queued", "running"]).has(run.status)) return false;
    const profile = this.profileRegistry.get(run.profile, run.profileVersion);
    const startedAt = run.status === "running" ? run.startedAt : run.submittedAt;
    const startedMs = Date.parse(startedAt ?? "");
    return Number.isFinite(startedMs)
      && this.now().getTime() >= startedMs + profile.limits.timeoutMs + this.runnerTimeoutMarginMs;
  }

  async finalizeExecution({ authorization, profile, run, execution }) {
    if (Date.parse(run.billing?.nextCaptureAttemptAt) > this.now().getTime()) return publicRun(run);
    const alreadyCaptured = run.billing?.status === "captured";
    const capturing = run.billing?.status === "capturing";
    if ((alreadyCaptured || capturing) && !["approved", "rejected"].includes(run.verdict?.outcome)) {
      throw Object.assign(new Error("Capture is missing its original decisive verdict."), { code: "capture_checkpoint_unavailable" });
    }
    let verdict;
    try {
      if (alreadyCaptured || capturing) {
        verdict = run.verdict;
        execution = run.execution;
      } else if (!authorization) {
        execution = {
          status: "inconclusive",
          reason: "runner_fault",
          detail: "The backend could not recover the private payment authorization for this queued run. No payment was captured."
        };
        verdict = inconclusiveVerdict("runner_fault", execution.detail);
      } else if (execution?.status === "platform_fault") {
        verdict = platformFaultVerdict(execution.reason, execution.detail);
      } else if (execution?.status === "inconclusive") {
        verdict = inconclusiveVerdict(execution.reason, execution.detail);
      } else {
        verdict = await this.evaluatePinnedProfile({ execution, profile, run });
      }
    } catch (error) {
      execution = {
        status: "inconclusive",
        reason: "runner_fault",
        detail: error?.message ?? String(error)
      };
      verdict = inconclusiveVerdict("runner_fault", execution.detail);
    }

    let billing;
    if (alreadyCaptured) {
      if (!["approved", "rejected"].includes(verdict?.outcome)) {
        throw new Error("Captured Verify run is missing its decisive verdict checkpoint.");
      }
      billing = run.billing;
    } else if (verdict.outcome === "approved" || verdict.outcome === "rejected") {
      if (!capturing) {
        run = { ...run, status: "executed", verdict, execution,
          billing: { ...run.billing, status: "capturing", captureStartedAt: this.now().toISOString() } };
        await this.stateStore.updateVerificationRun(run.runId, run);
      }
      // Persist the scan boundary before any broadcast. A failed boundary read
      // leaves the original verdict checkpoint intact for the next tick.
      if (!run.billing.capturePrepared) {
        const checkpoint = await this.paymentGate.prepareCapture?.() ?? {};
        run = { ...run, billing: { ...run.billing, ...checkpoint, capturePrepared: true } };
        await this.stateStore.updateVerificationRun(run.runId, run);
      }
      const owner = authorization?.id
        ? await this.stateStore.getVerificationRunByAuthorizationId(authorization.id) : undefined;
      let capture = owner && owner.runId !== run.runId ? { status: "used_elsewhere" } : capturing || !owner
        ? await this.reconcileCapture(run, authorization)
        : { status: "open" };
      if (!owner && ["open", "captured"].includes(capture.status)) {
        throw Object.assign(new Error("Payment authorization ownership is unavailable."), { code: "payment_authorization_owner_unavailable" });
      }
      if (capture.status === "open") {
        try {
          capture = { ...await this.paymentGate.capture({
            authorization, runId: run.runId, verdict,
            onBroadcast: async (transactionHash) => {
              run = { ...run, billing: { ...run.billing, pendingTransactionHash: transactionHash } };
              await this.stateStore.updateVerificationRun(run.runId, run);
            }
          }), status: "captured" };
        } catch (error) {
          this.logger.warn?.({ runId: run.runId, errorName: error?.name, errorCode: error?.code }, "verification_run.capture_error");
          capture = await this.reconcileCapture(run, authorization);
        }
      }
      if (!["captured", "cancelled", "expired", "used_elsewhere"].includes(capture.status)) {
        if (capture.status !== "unavailable") this.logger.warn?.({ runId: run.runId, status: capture.status }, "verification_run.capture_pending");
        await this.deferCapture(run);
        return publicRun(run);
      }
      if (capture.status !== "captured") {
        const reason = capture.status === "cancelled" ? "payment_cancelled_by_payer"
          : capture.status === "used_elsewhere" ? "payment_authorization_used_elsewhere" : "payment_authorization_expired";
        await safeRelease(this.paymentGate, { authorization, runId: run.runId, reason });
        execution = { status: "inconclusive", reason,
          detail: capture.status === "cancelled" ? "Payment cancelled by payer."
            : capture.status === "used_elsewhere" ? "Payment authorization was used for another payee or purchase; this run is not billed."
              : "Payment authorization expired unused; no fee was recorded." };
        verdict = inconclusiveVerdict(reason, execution.detail);
        billing = notBilled(profile);
      } else {
        if (!/^0x[0-9a-f]{64}$/iu.test(capture.transactionHash ?? "")) {
          throw Object.assign(new Error("Capture is missing transaction proof."), { code: "capture_hash_unavailable" });
        }
        billing = {
          status: "captured",
          amount: profile.price.amount,
          amountRaw: profile.price.amountRaw,
          asset: profile.price.asset,
          network: profile.price.network,
          transactionHash: capture.transactionHash,
          ...(capture.proof ? { proof: capture.proof } : {})
        };
      }
    } else {
      await safeRelease(this.paymentGate, { authorization, runId: run.runId, reason: verdict.reason });
      billing = notBilled(profile);
    }

    if (billing.status === "captured" && !alreadyCaptured) {
      // A receipt-signing/storage retry must neither capture again nor re-evaluate
      // a verdict whose payment has already succeeded. Keep it finalizable.
      // Persist outside the capture catch: a store error is not a capture failure.
      await this.stateStore.updateVerificationRun(run.runId, {
        ...run, status: "executed", billing, verdict, execution
      });
    }

    const completedAt = this.now().toISOString();
    const completed = {
      ...run,
      status: COMPLETE,
      completedAt,
      verdict,
      execution,
      billing
    };
    const receipt = buildVerifyReceipt({
      run: completed,
      profile,
      execution,
      verdict,
      context: {
        publicReceiptBaseUrl: this.publicReceiptBaseUrl,
        selfIdentityRegistry: this.selfIdentityRegistry
      }
    });
    const document = this.badgeReceiptSigner
      ? { ...receipt, signature: await this.badgeReceiptSigner.signDocument(receipt) } : receipt;
    await this.stateStore.putWorkReceiptDocument(run.runId, document);
    const persisted = {
      ...completed,
      receiptId: receipt.receiptId,
      receiptUrl: receipt.canonicalUrl
    };
    return this.stateStore.updateVerificationRun(run.runId, persisted);
  }

  async reconcileCapture(run, authorization) {
    if (authorization?.authorization && !Number.isSafeInteger(authorization.authorizedAtBlock)
      && !run.billing.legacyCaptureUnresolved) {
      run.billing.legacyCaptureUnresolved = true;
      await this.stateStore.updateVerificationRun(run.runId, run);
    }
    const result = await this.paymentGate.reconcileCapture({ authorization, ...run.billing });
    if (result.captureScanNextBlock !== undefined) run.billing.captureScanNextBlock = result.captureScanNextBlock;
    if (result.legacy) run.billing.legacyCaptureUnresolved = true;
    if (result.status === "unavailable" && !run.billing.reconciliationUnavailableLogged) {
      this.logger.warn?.({ runId: run.runId, errorCode: "capture_reconciliation_unavailable" }, "verification_run.capture_reconciliation_unavailable");
      run.billing.reconciliationUnavailableLogged = true;
      await this.stateStore.updateVerificationRun(run.runId, run);
    }
    return result;
  }

  async deferCapture(run) {
    const attempts = (run.billing.captureAttempts ?? 0) + 1;
    const delayMs = Math.min(300_000, 5_000 * 2 ** Math.min(attempts - 1, 6));
    run.billing = { ...run.billing, captureAttempts: attempts,
      nextCaptureAttemptAt: new Date(this.now().getTime() + delayMs).toISOString() };
    await this.stateStore.updateVerificationRun(run.runId, run);
  }

  async getCaptureWarnings() {
    if (this.captureWarningsCache?.expiresAt > this.now().getTime()) return this.captureWarningsCache.warnings;
    let count = 0;
    let openCount = 0;
    for (let offset = 0; ; offset += 100) {
      const page = await this.stateStore.listActiveVerificationRuns(100, { offset });
      count += page.filter((run) => run.billing?.legacyCaptureUnresolved).length;
      openCount += page.filter((run) => run.billing?.status === "capturing" && !run.billing.legacyCaptureUnresolved
        && Date.parse(run.billing.captureStartedAt ?? run.submittedAt) < this.now().getTime() - 15 * 60_000).length;
      if (page.length < 100) break;
    }
    const warnings = count ? [{ code: "verify_capture_legacy_unresolved", severity: "warning", count }] : [];
    if (openCount) warnings.push({ code: "verify_capture_open", severity: "warning", count: openCount });
    this.captureWarningsCache = { warnings, expiresAt: this.now().getTime() + 30_000 };
    return warnings;
  }

  async evaluatePinnedProfile({ execution, profile, run }) {
    const metadata = this.verifierRegistry.listHandlerMetadata()
      .find((handler) => handler.id === profile.handler);
    if (Number(metadata?.version) !== Number(profile.handlerVersion)) {
      throw new Error(
        `Pinned handler ${profile.handler}/v${profile.handlerVersion} is not available; observed ${metadata?.version ?? "missing"}.`
      );
    }
    const verdict = await this.verifierRegistry.evaluate({
      id: hashCanonicalContent({ profile: profile.ref, target: run.target, inputs: run.inputs }),
      verifierMode: profile.handler,
      verifierConfig: structuredClone(profile.verifierConfig)
    }, execution.evidence, { customer: run.customer, verificationRunId: run.runId });
    return {
      ...verdict,
      profile: profile.name,
      profileVersion: profile.version,
      profileRef: profile.ref,
      evidenceHash: hashCanonicalContent(execution.report ?? execution.evidence ?? null),
      workerConsequence: "none"
    };
  }
}

export function validateVerificationRunRequest(request, profileRegistry) {
  validateAgainstSchemaAll(request, VERIFY_REQUEST_ENVELOPE_SCHEMA, "verifyRequest");
  const profile = profileRegistry.requireAvailable(request.profile, request.profileVersion);
  validateAgainstSchemaAll(
    { target: request.target, inputs: request.inputs },
    profile.inputSchema,
    "verifyRequest"
  );
  return profile;
}

export class UnavailableVerificationPaymentGate {
  async prepareCapture() { return {}; }

  async reconcileCapture() { return { status: "unavailable" }; }

  async authorize({ price, profile }) {
    throw new AppError(
      "Standalone Verify payment intake is not enabled yet. No verification work ran and no payment moved.",
      {
        name: "VerificationPaymentRequiredError",
        code: "verification_payment_required",
        statusCode: 402,
        details: {
          profile,
          price,
          action: "retry_when_verify_payment_intake_is_enabled",
          customerFunds: "unchanged"
        }
      }
    );
  }

  async capture() {
    throw new Error("Verification payment intake is unavailable.");
  }

  async release() {}
}

function publicRun(run) {
  if (!run) return run;
  const { requestHash, ...result } = run;
  if (run.billing) {
    result.billing = Object.fromEntries(["status", "amount", "amountRaw", "asset", "network", "transactionHash", "proof", "reason"]
      .filter((key) => run.billing[key] !== undefined).map((key) => [key, run.billing[key]]));
  }
  if (run.billing?.status === "capturing") {
    delete result.verdict;
    delete result.execution;
  }
  return result;
}

function assertPaymentAuthorization(authorization, profile) {
  if (!authorization || typeof authorization !== "object") {
    throw new AppError("Verification payment was not authorized.", {
      code: "verification_payment_required",
      statusCode: 402
    });
  }
  if (!String(authorization.id ?? "").trim() || !ADDRESS_RE.test(String(authorization.customer ?? ""))) {
    throw new ValidationError("Verification payment authorization is missing its id or customer address.");
  }
  if (String(authorization.amountRaw) !== String(profile.price.amountRaw)
    || String(authorization.asset) !== String(profile.price.asset)
    || String(authorization.network) !== String(profile.price.network)) {
    throw new ValidationError("Verification payment authorization does not match the pinned profile price.");
  }
}

function requireMatchingVerificationReplay(run, requestHash) {
  const originalHash = run.requestHash ?? hashCanonicalContent({
    profile: run.profileRef, target: run.target, inputs: run.inputs
  });
  if (originalHash !== requestHash) {
    throw new ConflictError("Payment authorization is already reserved. For a new purchase, sign a fresh authorization with a new nonce.", "payment_authorization_in_use", { action: "sign_fresh_authorization" });
  }
  return run;
}

function inconclusiveVerdict(reason, detail) {
  const normalized = ["payment_cancelled_by_payer", "payment_authorization_expired", "payment_authorization_used_elsewhere"].includes(reason) || VERIFY_INCONCLUSIVE_REASONS.includes(reason) ? reason : "runner_fault";
  return {
    handler: "deterministic",
    handlerVersion: 1,
    outcome: "inconclusive",
    reason: normalized,
    reasonCode: normalized,
    detail: detail ?? "The runner could not reach a decisive result.",
    workerConsequence: "none"
  };
}

function platformFaultVerdict(reason, detail) {
  const normalized = VERIFY_INCONCLUSIVE_REASONS.includes(reason) ? reason : "runner_fault";
  return {
    handler: "deterministic",
    handlerVersion: 1,
    outcome: "platform_fault",
    reason: normalized,
    reasonCode: normalized,
    detail: detail ?? "The verification platform refused an unsafe runner action.",
    workerConsequence: "none"
  };
}

function notBilled(profile) {
  return {
    status: "not_captured",
    reason: "inconclusive",
    amount: "0",
    amountRaw: "0",
    asset: profile.price.asset,
    network: profile.price.network
  };
}

async function safeRelease(paymentGate, input) {
  try {
    await paymentGate.release?.(input);
  } catch {
    // A release is best-effort and must not turn an inconclusive run into a
    // customer artifact failure. V4 owns durable payment-rail reconciliation.
  }
}

function persistableAuthorization(authorization) {
  return JSON.parse(JSON.stringify(authorization, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  ));
}

function assertEphemeralCredential({ target, ephemeralCredential }) {
  const supplied = ephemeralCredential !== undefined && ephemeralCredential !== null && String(ephemeralCredential) !== "";
  if (target?.auth && !supplied) {
    throw new ValidationError("target.auth requires the scoped credential in the verification-target-authorization header.");
  }
  if (!target?.auth && supplied) {
    throw new ValidationError("verification-target-authorization is accepted only with target.auth.");
  }
}

function assertMcpEndpointCredentialBoundary(profileRef, target) {
  if (profileRef !== MCP_FAILURE_SEMANTICS_PROFILE_REF) return;
  let endpoint;
  try { endpoint = new URL(String(target?.endpoint ?? "")); }
  catch { throw new ValidationError("MCP target endpoint must be an absolute https or wss URL."); }
  if (!new Set(["https:", "wss:"]).has(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ValidationError("MCP target endpoint must use https or wss and must not embed credentials, query values, or fragments.");
  }
  if ((target.transport === "streamable_http" && endpoint.protocol !== "https:")
      || (target.transport === "websocket" && endpoint.protocol !== "wss:")) {
    throw new ValidationError("MCP target transport must pair streamable_http with https or websocket with wss.");
  }
}

function verificationRunLockId(runId) {
  return `verification-run-finalizer:${String(runId)}`;
}

function runnerTimeoutExecution(status) {
  return {
    status: "inconclusive",
    reason: "runner_fault",
    detail: status === "running"
      ? "The isolated verification runner did not complete before its execution deadline."
      : "No isolated verification runner claimed this request before its execution deadline."
  };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return parsed;
}
