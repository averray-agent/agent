import { GitPatchTestsRunner } from "./git-patch-tests-runner.js";
import {
  GIT_PATCH_TESTS_PROFILE_REF,
  VerificationProfileRegistry
} from "./verification-profile-registry.js";
import { VerificationRunService } from "./verification-run-service.js";

export async function createVerificationShelf({
  stateStore,
  runner = new GitPatchTestsRunner(),
  paymentGate,
  publicReceiptBaseUrl = process.env.PUBLIC_BASE_URL,
  logger = console
} = {}) {
  const availability = await runner.inspectAvailability();
  const verificationProfileRegistry = new VerificationProfileRegistry({
    availabilityByProfile: { [GIT_PATCH_TESTS_PROFILE_REF]: availability }
  });
  if (availability.status !== "available") {
    logger.warn?.(
      {
        profile: GIT_PATCH_TESTS_PROFILE_REF,
        reasonCode: availability.reasonCode,
        err: availability.error
      },
      "verification_profile.unavailable"
    );
  }
  const verificationRunService = new VerificationRunService({
    stateStore,
    profileRegistry: verificationProfileRegistry,
    runner,
    paymentGate,
    publicReceiptBaseUrl
  });
  return { verificationProfileRegistry, verificationRunService };
}
