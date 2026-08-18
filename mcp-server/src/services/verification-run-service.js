import { hashCanonicalContent } from "../core/canonical-content.js";
import { ConfigError, NotFoundError, ValidationError } from "../core/errors.js";
import { buildVerifyReceipt } from "../core/work-receipt.js";
import { FilesystemVerificationRunnerClient } from "./filesystem-verification-runner-client.js";
import { VerifierRegistry } from "./verifier-handlers.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;

export class VerificationRunService {
  constructor({
    stateStore,
    profileRegistry = new VerificationProfileRegistry(),
    verifierRegistry = new VerifierRegistry(),
    runners = { "git-patch-tests-v1@1": new FilesystemVerificationRunnerClient() },
    receiptSigner = undefined,
    now = () => new Date(),
    publicReceiptBaseUrl = "https://averray.com"
  } = {}) {
    if (!stateStore?.upsertVerificationRun || !stateStore?.getVerificationRun) {
      throw new ConfigError("VerificationRunService requires durable verification-run storage.");
    }
    this.stateStore = stateStore;
    this.profileRegistry = profileRegistry;
    this.verifierRegistry = verifierRegistry;
    this.runners = runners;
    this.receiptSigner = receiptSigner;
    this.now = now;
    this.publicReceiptBaseUrl = publicReceiptBaseUrl;
  }

  listProfiles() {
    return this.profileRegistry.list();
  }

  async initialize() {
    for (const profile of this.profileRegistry.list()) {
      const runner = this.runners[`${profile.name}@${profile.version}`];
      if (!runner?.initialize) {
        throw new ConfigError(`Verification runner ${profile.name}@${profile.version} has no runtime preflight.`);
      }
      await runner.initialize();
    }
    return { profiles: this.profileRegistry.list().map((profile) => `${profile.name}@${profile.version}`) };
  }

  async getRun(runId) {
    const run = await this.stateStore.getVerificationRun(normalizeRunId(runId));
    if (!run) throw new NotFoundError(`Verification run ${runId} was not found.`);
    return publicRun(run);
  }

  async execute({ profile: profileName, profileVersion, customer, target, inputs }) {
    const wallet = normalizeCustomer(customer);
    const profile = this.profileRegistry.get(profileName, profileVersion);
    if (!profile || profile.status !== "published") {
      throw new ValidationError(
        `Unknown published verification profile ${profileName ?? "missing"}@${profileVersion ?? "latest"}.`
      );
    }
    const requestHash = hashCanonicalContent({
      customer: wallet,
      profile: `${profile.name}@${profile.version}`,
      target,
      inputs
    });
    const existing = await this.stateStore.findVerificationRunByRequestHash(requestHash);
    if (existing) return existing;

    const runId = `verify_${requestHash.slice(2)}`;
    const submittedAt = this.currentTime().toISOString();
    let run = await this.stateStore.upsertVerificationRun({
      runId,
      requestHash,
      profile: profile.name,
      profileVersion: profile.version,
      customer: wallet,
      target: structuredClone(target),
      inputs: structuredClone(inputs),
      submittedAt,
      status: "queued",
      verdict: null,
      receiptId: null
    });
    run = await this.stateStore.upsertVerificationRun({
      ...run,
      status: "running",
      startedAt: this.currentTime().toISOString()
    });

    const runner = this.runners[`${profile.name}@${profile.version}`];
    let runnerResult;
    if (!runner?.run) {
      runnerResult = runnerFault("No runner is installed for the pinned verification profile.");
    } else {
      try {
        runnerResult = await withTimeout(
          runner.run({ runId, profile, target, inputs }),
          profile.limits.timeout * 1_000
        );
      } catch (error) {
        runnerResult = runnerFault(error?.message ?? "The verification runner failed.");
      }
    }

    let verdict;
    if (runnerResult.status === "inconclusive") {
      verdict = {
        outcome: "inconclusive",
        reason: runnerResult.reason,
        reasonCode: runnerResult.reasonCode ?? String(runnerResult.reason).toUpperCase(),
        detail: runnerResult.detail,
        evidenceHash: runnerResult.evidenceHash,
        evidence: runnerResult.report,
        customerArtifactStatus: "undetermined",
        billing: "not_billed"
      };
    } else {
      const handlerVerdict = await this.verifierRegistry.evaluate({
        id: runId,
        verifierMode: profile.handler,
        verifierConfig: {
          handler: profile.handler,
          expectedOutputs: ["pass"],
          matchMode: "exact"
        }
      }, runnerResult.evidence);
      verdict = {
        ...handlerVerdict,
        reasonCode: runnerResult.reasonCode ?? handlerVerdict.reasonCode,
        evidenceHash: runnerResult.evidenceHash,
        evidence: runnerResult.report,
        billing: "payment_required"
      };
    }
    return this.stateStore.upsertVerificationRun({
      ...run,
      verdict,
      execution: runnerResult.execution,
      evaluatedAt: this.currentTime().toISOString()
    });
  }

  async finalize(runId, { payment = undefined } = {}) {
    const existing = await this.stateStore.getVerificationRun(normalizeRunId(runId));
    if (!existing) throw new NotFoundError(`Verification run ${runId} was not found.`);
    if (existing.status === "complete") return existing;
    if (!existing.verdict) throw new ValidationError("Verification run has no verdict to finalize.");
    const profile = this.profileRegistry.get(existing.profile, existing.profileVersion);
    const inconclusive = existing.verdict.outcome === "inconclusive"
      || existing.verdict.outcome === "platform_fault";
    if (inconclusive && payment?.status === "settled") {
      throw new ValidationError("An inconclusive verification run must never be billed.");
    }
    if (!inconclusive) assertPaidProfilePrice(payment, profile, existing.customer);
    const completedAt = this.currentTime().toISOString();
    const receipt = buildVerifyReceipt({
      run: { ...existing, completedAt },
      profile,
      execution: existing.execution,
      payment: inconclusive ? { status: "not_billed", amountRaw: "0" } : payment,
      context: { publicReceiptBaseUrl: this.publicReceiptBaseUrl }
    });
    const document = this.receiptSigner
      ? { ...receipt, signature: await this.receiptSigner.signDocument(receipt) }
      : receipt;
    await this.stateStore.putWorkReceiptDocument(existing.runId, document);
    return this.stateStore.upsertVerificationRun({
      ...existing,
      status: "complete",
      verdict: {
        ...existing.verdict,
        billing: inconclusive ? "not_billed" : "billed"
      },
      payment: inconclusive ? { status: "not_billed", amountRaw: "0" } : payment,
      completedAt,
      receiptId: receipt.receiptId
    });
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new ConfigError("Verification run clock is invalid.");
    return date;
  }
}

function assertPaidProfilePrice(payment, profile, customer) {
  if (payment?.status !== "settled") {
    throw new ValidationError("A conclusive verification run requires confirmed Base payment.");
  }
  if (payment.network !== profile.price.network
      || String(payment.amountRaw) !== profile.price.amountRaw) {
    throw new ValidationError("Verification payment does not match the pinned profile price.");
  }
  if (String(payment.payer ?? "").toLowerCase() !== customer) {
    throw new ValidationError("Verification payment payer does not match the run customer.");
  }
}

function runnerFault(detail) {
  return {
    status: "inconclusive",
    reason: "runner_fault",
    reasonCode: "RUNNER_FAULT",
    detail,
    evidenceHash: hashCanonicalContent({ reason: "runner_fault", detail })
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Verification profile timeout exceeded.")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCustomer(value) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new ValidationError("Verification customer must be an EVM wallet address.");
  }
  return value.toLowerCase();
}

function normalizeRunId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^verify_[a-f0-9]{64}$/u.test(normalized)) {
    throw new ValidationError("Verification run id is invalid.");
  }
  return normalized;
}

function publicRun(run) {
  const { inputs, requestHash, payment, ...view } = run;
  return {
    ...view,
    requestHash,
    target: run.target,
    payment: payment && {
      status: payment.status,
      network: payment.network,
      amountRaw: payment.amountRaw,
      receiptId: payment.receiptId
    }
  };
}
