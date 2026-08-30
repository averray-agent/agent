import { AppError } from "./errors.js";

export const NON_FAILABLE_VERIFIER_CODE = "catalog_verifier_cannot_reject_bad_work";

const INGESTED_CATALOG_SOURCES = new Set([
  "github_issue",
  "open_data_dataset",
  "openapi_spec",
  "osv_advisory",
  "standards_spec",
  "wikipedia_article"
]);

export class NonFailableCatalogVerifierError extends AppError {
  constructor(job) {
    super(
      `Catalog job ${job?.id ?? "unknown"} uses a keyword-only benchmark verifier that cannot prove the work was done.`,
      {
        name: "NonFailableCatalogVerifierError",
        code: NON_FAILABLE_VERIFIER_CODE,
        statusCode: 400,
        details: {
          jobId: job?.id ?? null,
          sourceType: job?.source?.type ?? null,
          verifierMode: job?.verifierMode ?? job?.verifierConfig?.handler ?? null
        }
      }
    );
  }
}

export function isKeywordOnlyBenchmarkJob(job) {
  const verifierMode = String(job?.verifierMode ?? job?.verifierConfig?.handler ?? "")
    .trim()
    .toLowerCase();
  if (verifierMode !== "benchmark" || job?.disposableProof === true) return false;
  return !(
    job?.verifierAnchorEvidence
    || job?.verifierConfig?.anchorEvidence
  );
}

export function isIngestedCatalogJob(job) {
  return INGESTED_CATALOG_SOURCES.has(job?.source?.type);
}

export function assertIngestedCatalogVerifierCanReject(job) {
  if (isIngestedCatalogJob(job) && isKeywordOnlyBenchmarkJob(job)) {
    throw new NonFailableCatalogVerifierError(job);
  }
  return job;
}
