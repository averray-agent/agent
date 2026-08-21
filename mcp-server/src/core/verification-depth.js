export const STARTER_BENCHMARK_CHECK_DEPTH =
  "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit.";

export function verificationDepthForJob(job) {
  const mode = job?.verifierConfig?.handler ?? job?.verifierMode;
  return mode === "benchmark" ? STARTER_BENCHMARK_CHECK_DEPTH : undefined;
}
