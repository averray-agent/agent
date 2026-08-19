import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import {
  loadVerificationRunFinalizerConfig,
  VerificationRunFinalizerService
} from "./verification-run-finalizer.js";
import { VerificationRunService } from "./verification-run-service.js";

export async function createVerificationShelf({
  stateStore,
  paymentGate,
  publicReceiptBaseUrl = process.env.PUBLIC_BASE_URL,
  env = process.env,
  logger = console
} = {}) {
  const config = loadVerificationRunFinalizerConfig(env);
  const verificationProfileRegistry = new VerificationProfileRegistry();
  const verificationRunService = new VerificationRunService({
    stateStore,
    profileRegistry: verificationProfileRegistry,
    paymentGate,
    publicReceiptBaseUrl,
    runnerTimeoutMarginMs: config.runnerTimeoutMarginMs
  });
  const verificationRunFinalizer = new VerificationRunFinalizerService({
    verificationRunService,
    intervalMs: config.intervalMs,
    batchSize: config.batchSize,
    logger
  });
  return { verificationProfileRegistry, verificationRunService, verificationRunFinalizer };
}
