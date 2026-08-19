import { ConfigError, ValidationError } from "../core/errors.js";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;

export class VerificationRunFinalizerService {
  constructor({
    verificationRunService,
    intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    logger = console
  } = {}) {
    if (!verificationRunService) {
      throw new ValidationError("VerificationRunFinalizerService requires the backend run service.");
    }
    this.verificationRunService = verificationRunService;
    this.intervalMs = positiveInteger(intervalMs, "verification finalizer interval");
    this.batchSize = positiveInteger(batchSize, "verification finalizer batch size");
    this.logger = logger;
    this.timer = undefined;
    this.inFlight = undefined;
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error) => {
          this.logger.error?.(
            { err: error instanceof Error ? error : new Error(String(error)) },
            "verification_run_finalizer.tick_failed"
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce() {
    return this.verificationRunService.finalizeAvailableRuns({ limit: this.batchSize });
  }
}

export function loadVerificationRunFinalizerConfig(env = process.env) {
  return {
    intervalMs: optionalPositiveInteger(
      env.VERIFY_FINALIZER_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      "VERIFY_FINALIZER_INTERVAL_MS"
    ),
    batchSize: optionalPositiveInteger(
      env.VERIFY_FINALIZER_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      "VERIFY_FINALIZER_BATCH_SIZE"
    ),
    runnerTimeoutMarginMs: optionalPositiveInteger(
      env.VERIFY_RUNNER_TIMEOUT_MARGIN_MS,
      30_000,
      "VERIFY_RUNNER_TIMEOUT_MARGIN_MS"
    )
  };
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
