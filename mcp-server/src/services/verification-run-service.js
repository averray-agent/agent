import { randomUUID } from "node:crypto";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { AppError, NotFoundError, ValidationError } from "../core/errors.js";
import { validateAgainstSchema } from "../core/job-schema-validation.js";
import { buildVerifyReceipt } from "../core/work-receipt.js";
import { VerifierRegistry } from "./verifier-handlers.js";
import { VERIFY_INCONCLUSIVE_REASONS } from "./verification-profile-registry.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const COMPLETE = "complete";

export class VerificationRunService {
  constructor({
    stateStore,
    profileRegistry,
    runner,
    paymentGate = new UnavailableVerificationPaymentGate(),
    verifierRegistry = new VerifierRegistry(),
    now = () => new Date(),
    randomUUIDImpl = randomUUID,
    publicReceiptBaseUrl = undefined
  } = {}) {
    if (!stateStore || !profileRegistry || !runner) {
      throw new ValidationError("VerificationRunService requires state, profiles, and a runner.");
    }
    this.stateStore = stateStore;
    this.profileRegistry = profileRegistry;
    this.runner = runner;
    this.paymentGate = paymentGate;
    this.verifierRegistry = verifierRegistry;
    this.now = now;
    this.randomUUIDImpl = randomUUIDImpl;
    this.publicReceiptBaseUrl = publicReceiptBaseUrl;
  }

  listProfiles() {
    return this.profileRegistry.list();
  }

  async getRun(runId) {
    const normalized = String(runId ?? "").trim();
    if (!normalized) throw new ValidationError("runId is required.");
    const run = await this.stateStore.getVerificationRun(normalized);
    if (!run) throw new NotFoundError(`Verification run ${normalized} was not found.`, "verification_run_not_found");
    return run;
  }

  async createRun({
    profile: profileName,
    profileVersion,
    target,
    inputs,
    paymentProof
  } = {}) {
    const profile = this.profileRegistry.requireAvailable(profileName, profileVersion);
    validateAgainstSchema({ target, inputs }, profile.inputSchema, "verifyRequest");
    await this.runner.validate?.({ profile, target, inputs });
    const requestHash = hashCanonicalContent({ profile: profile.ref, target, inputs });
    const paymentKey = paymentProof === undefined || paymentProof === null || paymentProof === ""
      ? undefined
      : hashCanonicalContent(paymentProof);
    if (paymentKey) {
      const existing = await this.stateStore.getVerificationRunByPaymentId(paymentKey);
      if (existing) return existing;
    }

    const authorization = await this.paymentGate.authorize({
      paymentProof,
      price: profile.price,
      profile: profile.ref,
      profileLimits: profile.limits,
      requestHash
    });
    assertPaymentAuthorization(authorization, profile);
    const runId = `verify-${this.randomUUIDImpl()}`;
    const submittedAt = this.now().toISOString();
    const queued = {
      runId,
      profile: profile.name,
      profileVersion: profile.version,
      profileRef: profile.ref,
      customer: authorization.customer.toLowerCase(),
      target: structuredClone(target),
      inputs: structuredClone(inputs),
      submittedAt,
      status: "queued",
      billing: { status: "authorized", amountRaw: profile.price.amountRaw, asset: profile.price.asset }
    };
    const reservation = await this.stateStore.reserveVerificationRun(queued, {
      paymentId: paymentKey ?? hashCanonicalContent(authorization.id)
    });
    if (!reservation.created) return reservation.run;

    await this.stateStore.updateVerificationRun(runId, {
      ...queued,
      status: "running",
      startedAt: this.now().toISOString()
    });
    return this.executeRun({ authorization, profile, run: queued });
  }

  async executeRun({ authorization, profile, run }) {
    let execution;
    let verdict;
    try {
      execution = await runWithTimeout(
        () => this.runner.run({
          profile,
          runId: run.runId,
          target: run.target,
          inputs: run.inputs
        }),
        profile.limits.timeoutMs
      );
      if (execution?.status === "inconclusive") {
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
    if (verdict.outcome === "approved" || verdict.outcome === "rejected") {
      try {
        const captured = await this.paymentGate.capture({ authorization, runId: run.runId, verdict });
        billing = {
          status: "captured",
          amount: profile.price.amount,
          amountRaw: profile.price.amountRaw,
          asset: profile.price.asset,
          network: profile.price.network,
          ...(captured?.transactionHash ? { transactionHash: captured.transactionHash } : {})
        };
      } catch (error) {
        await safeRelease(this.paymentGate, { authorization, runId: run.runId, reason: "runner_fault" });
        execution = {
          ...execution,
          status: "inconclusive",
          reason: "runner_fault",
          detail: `Payment capture failed; no fee was recorded: ${error?.message ?? String(error)}`
        };
        verdict = inconclusiveVerdict("runner_fault", execution.detail);
        billing = notBilled(profile);
      }
    } else {
      await safeRelease(this.paymentGate, { authorization, runId: run.runId, reason: verdict.reason });
      billing = notBilled(profile);
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
      context: { publicReceiptBaseUrl: this.publicReceiptBaseUrl }
    });
    await this.stateStore.putWorkReceiptDocument(run.runId, receipt);
    const persisted = {
      ...completed,
      receiptId: receipt.receiptId,
      receiptUrl: receipt.canonicalUrl
    };
    return this.stateStore.updateVerificationRun(run.runId, persisted);
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

export class UnavailableVerificationPaymentGate {
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

function inconclusiveVerdict(reason, detail) {
  const normalized = VERIFY_INCONCLUSIVE_REASONS.includes(reason) ? reason : "runner_fault";
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

function notBilled(profile) {
  return {
    status: "not_billed",
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

async function runWithTimeout(run, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Verification runner exceeded ${timeoutMs}ms.`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
