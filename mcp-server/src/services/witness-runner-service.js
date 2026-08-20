import { randomUUID } from "node:crypto";

import { ConfigError, ValidationError } from "../core/errors.js";
import { GitPatchTestsRunner } from "./git-patch-tests-runner.js";
import {
  GIT_PATCH_TESTS_PROFILE_REF,
  VerificationProfileRegistry
} from "./verification-profile-registry.js";

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_CLAIM_LEASE_SECONDS = 180;

export class WitnessRunnerService {
  constructor({
    stateStore,
    runner = new GitPatchTestsRunner(),
    profileRegistry = new VerificationProfileRegistry(),
    intervalMs = DEFAULT_INTERVAL_MS,
    claimLeaseSeconds = DEFAULT_CLAIM_LEASE_SECONDS,
    acceptedProfileRefs = [GIT_PATCH_TESTS_PROFILE_REF],
    owner = `witness-runner:${randomUUID()}`,
    now = () => new Date(),
    logger = console
  } = {}) {
    if (!stateStore) throw new ValidationError("WitnessRunnerService requires the shared state store.");
    this.stateStore = stateStore;
    this.runner = runner;
    this.profileRegistry = profileRegistry;
    this.intervalMs = positiveInteger(intervalMs, "Witness runner interval");
    this.claimLeaseSeconds = positiveInteger(claimLeaseSeconds, "Witness runner claim lease");
    this.acceptedProfileRefs = Object.freeze(acceptedProfileRefs.map(String));
    this.owner = String(owner);
    this.now = now;
    this.logger = logger;
    this.timer = undefined;
    this.inFlight = undefined;
    this.availability = undefined;
  }

  async inspectAvailability() {
    this.availability ??= await this.runner.inspectAvailability();
    return this.availability;
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error) => {
          this.logger.error?.(
            { err: error instanceof Error ? error : new Error(String(error)) },
            "witness_runner.tick_failed"
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce() {
    const availability = await this.inspectAvailability();
    if (availability.status !== "available") {
      this.logger.warn?.(
        { reasonCode: availability.reasonCode },
        "witness_runner.unavailable"
      );
      return undefined;
    }
    const claimedAt = this.now().toISOString();
    const run = await this.stateStore.claimNextVerificationRun({
      owner: this.owner,
      claimedAt,
      leaseSeconds: this.claimLeaseSeconds,
      profileRefs: this.acceptedProfileRefs
    });
    if (!run) return undefined;

    let execution;
    try {
      const profile = this.profileRegistry.get(run.profile, run.profileVersion);
      await this.runner.validate?.({ profile, target: run.target, inputs: run.inputs });
      execution = await runWithTimeout(
        () => this.runner.run({
          profile,
          runId: run.runId,
          target: run.target,
          inputs: run.inputs
        }),
        profile.limits.timeoutMs
      );
    } catch (error) {
      execution = {
        status: "inconclusive",
        reason: "runner_fault",
        detail: error?.message ?? String(error)
      };
    }

    const stored = await this.stateStore.storeVerificationRunExecution(run.runId, {
      owner: this.owner,
      execution,
      executedAt: this.now().toISOString()
    });
    if (!stored) {
      this.logger.warn?.(
        { runId: run.runId },
        "witness_runner.stale_result_discarded"
      );
    }
    return stored;
  }
}

export function loadWitnessRunnerConfig(env = process.env) {
  assertWitnessRunnerEnvironment(env);
  return {
    intervalMs: optionalPositiveInteger(
      env.WITNESS_RUNNER_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      "WITNESS_RUNNER_INTERVAL_MS"
    ),
    claimLeaseSeconds: optionalPositiveInteger(
      env.WITNESS_RUNNER_CLAIM_LEASE_SECONDS,
      DEFAULT_CLAIM_LEASE_SECONDS,
      "WITNESS_RUNNER_CLAIM_LEASE_SECONDS"
    )
  };
}

export function assertWitnessRunnerEnvironment(env = process.env) {
  const forbidden = Object.keys(env).filter((name) =>
    /^(?:AUTH_ADMIN|AUTH_VERIFIER|AWS_|KMS_|OP_|SIGNER_|X402_|.*PRIVATE_KEY|.*PAYMENT)/u.test(name)
    && String(env[name] ?? "").trim() !== ""
  );
  if (forbidden.length > 0) {
    throw new ConfigError(
      `Witness runner received forbidden credential or payment environment: ${forbidden.sort().join(", ")}.`
    );
  }
  if (!String(env.REDIS_URL ?? "").trim()) {
    throw new ConfigError("REDIS_URL is required by the Witness runner.");
  }
  if (!/^tcp:\/\/[^/]+:\d+$/u.test(String(env.DOCKER_HOST ?? ""))) {
    throw new ConfigError("DOCKER_HOST must point to the internal Witness Docker proxy over TCP.");
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

function optionalPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return parsed;
}
