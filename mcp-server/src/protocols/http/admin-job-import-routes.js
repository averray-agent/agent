import { normalizeError } from "../../core/errors.js";
import { ingestGithubIssues } from "../../jobs/ingest-github-issues.js";
import { ingestOpenDataDatasets, parseDatasets as parseOpenDataDatasets } from "../../jobs/ingest-open-data-datasets.js";
import { ingestOpenApiSpecs, parseOpenApiSpecs } from "../../jobs/ingest-openapi-specs.js";
import {
  ingestOsvAdvisories,
  parseManifests as parseOsvManifests,
  parsePackages as parseOsvPackages
} from "../../jobs/ingest-osv-advisories.js";
import { ingestStandardsSpecs, parseSpecs as parseStandardsSpecs } from "../../jobs/ingest-standards-specs.js";
import { ingestWikipediaMaintenance, parseCategories } from "../../jobs/ingest-wikipedia-maintenance.js";

export function createJobImportSummary(result, { dryRun, created, skipped = [], errors = [], extra = {} }) {
  return {
    ...extra,
    minScore: result.minScore,
    dryRun,
    candidateCount: result.count,
    created,
    skipped,
    errors
  };
}

export function normalizeSkippedWithNumericCount(result, skipped = []) {
  return [
    ...skipped,
    ...(Number.isFinite(result.skipped) ? [{ reason: "below_min_score_or_over_limit", count: result.skipped }] : [])
  ];
}

export function createJobsFromImportResult(service, jobs) {
  const created = [];
  const skipped = [];
  const errors = [];

  for (const job of jobs) {
    try {
      created.push(service.createJob(job));
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === "job_exists") {
        skipped.push({ id: job.id, reason: "already_exists" });
        continue;
      }
      errors.push({
        id: job.id,
        code: normalized.code,
        message: normalized.message
      });
    }
  }

  return { created, skipped, errors };
}

export function createAdminJobImportRouteDefinitions({
  env = process.env,
  parsePositiveInteger
}) {
  return [
    {
      pathname: "/admin/jobs/ingest/github",
      route: "/admin/jobs/ingest/github",
      bucket: "admin_jobs_ingest_github",
      normalize: (payload) => {
        const query = typeof payload?.query === "string" && payload.query.trim()
          ? payload.query.trim()
          : undefined;
        const limit = parsePositiveInteger(payload?.limit, 10, 50);
        const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
        const dryRun = payload?.dryRun !== false;
        return {
          query,
          limit,
          minScore,
          dryRun,
          idempotencyPayload: { query, limit, minScore, dryRun }
        };
      },
      ingest: ({ query, limit, minScore }) => ingestGithubIssues({
        query,
        limit,
        minScore,
        githubToken: env.GITHUB_TOKEN?.trim() || undefined
      }),
      dryRunBody: (result) => ({
        ...result,
        dryRun: true,
        created: [],
        skipped: [
          ...(Array.isArray(result.skipped) ? result.skipped : []),
          ...normalizeSkippedWithNumericCount(result)
        ]
      }),
      resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
        dryRun: false,
        created,
        skipped: [
          ...skipped,
          ...normalizeSkippedWithNumericCount(result)
        ],
        errors,
        extra: {
          query: result.query
        }
      })
    },
    {
      pathname: "/admin/jobs/ingest/wikipedia",
      route: "/admin/jobs/ingest/wikipedia",
      bucket: "admin_jobs_ingest_wikipedia",
      normalize: (payload) => {
        const language = typeof payload?.language === "string" && payload.language.trim()
          ? payload.language.trim()
          : undefined;
        const categories = Array.isArray(payload?.categories) || typeof payload?.categories === "string"
          ? parseCategories(payload.categories)
          : undefined;
        const limit = parsePositiveInteger(payload?.limit, 10, 50);
        const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
        const dryRun = payload?.dryRun !== false;
        return {
          language,
          categories,
          limit,
          minScore,
          dryRun,
          idempotencyPayload: { language, categories, limit, minScore, dryRun }
        };
      },
      ingest: ({ language, categories, limit, minScore }) => ingestWikipediaMaintenance({
        language,
        categories,
        limit,
        minScore
      }),
      dryRunBody: (result) => ({
        ...result,
        dryRun: true,
        created: [],
        skipped: [
          ...(Array.isArray(result.skipped) ? result.skipped : []),
          ...normalizeSkippedWithNumericCount(result)
        ]
      }),
      resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
        dryRun: false,
        created,
        skipped: [
          ...skipped,
          ...normalizeSkippedWithNumericCount(result)
        ],
        errors,
        extra: {
          language: result.language,
          categories: result.categories
        }
      })
    },
    {
      pathname: "/admin/jobs/ingest/osv",
      route: "/admin/jobs/ingest/osv",
      bucket: "admin_jobs_ingest_osv",
      normalize: (payload) => {
        const packages = Array.isArray(payload?.packages) || typeof payload?.packages === "string"
          ? parseOsvPackages(payload.packages)
          : parseOsvPackages(env.OSV_INGEST_PACKAGES_JSON ?? env.OSV_INGEST_PACKAGES);
        const manifests = Array.isArray(payload?.manifests) || typeof payload?.manifests === "string"
          ? parseOsvManifests(payload.manifests)
          : parseOsvManifests(env.OSV_INGEST_MANIFESTS_JSON ?? env.OSV_INGEST_MANIFESTS);
        const limit = parsePositiveInteger(payload?.limit, 10, 50);
        const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
        const maxPackageTargets = parsePositiveInteger(payload?.maxPackageTargets, 100, 500);
        const dryRun = payload?.dryRun !== false;
        return {
          packages,
          manifests,
          limit,
          minScore,
          maxPackageTargets,
          dryRun,
          idempotencyPayload: { packages, manifests, limit, minScore, maxPackageTargets, dryRun }
        };
      },
      ingest: ({ packages, manifests, limit, minScore, maxPackageTargets }) =>
        ingestOsvAdvisories({ packages, manifests, limit, minScore, maxPackageTargets }),
      dryRunBody: (result) => ({
        ...result,
        dryRun: true,
        created: []
      }),
      resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
        dryRun: false,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors,
        extra: {
          ecosystem: result.ecosystem
        }
      })
    },
    {
      pathname: "/admin/jobs/ingest/open-data",
      route: "/admin/jobs/ingest/open-data",
      bucket: "admin_jobs_ingest_open_data",
      normalize: (payload) => {
        const datasets = Array.isArray(payload?.datasets) || typeof payload?.datasets === "string"
          ? parseOpenDataDatasets(payload.datasets)
          : parseOpenDataDatasets(env.OPEN_DATA_INGEST_DATASETS_JSON ?? env.OPEN_DATA_INGEST_DATASETS);
        const query = typeof payload?.query === "string" && payload.query.trim()
          ? payload.query.trim()
          : env.OPEN_DATA_INGEST_QUERY;
        const limit = parsePositiveInteger(payload?.limit, 10, 50);
        const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
        const dryRun = payload?.dryRun !== false;
        return {
          datasets,
          query,
          limit,
          minScore,
          dryRun,
          idempotencyPayload: { datasets, query, limit, minScore, dryRun }
        };
      },
      ingest: ({ datasets, query, limit, minScore }) => ingestOpenDataDatasets({ datasets, query, limit, minScore }),
      dryRunBody: (result) => ({
        ...result,
        dryRun: true,
        created: []
      }),
      resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
        dryRun: false,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors,
        extra: {
          provider: result.provider,
          query: result.query
        }
      })
    },
    {
      pathname: "/admin/jobs/ingest/openapi",
      route: "/admin/jobs/ingest/openapi",
      bucket: "admin_jobs_ingest_openapi",
      normalize: (payload) => {
        const specs = Array.isArray(payload?.specs) || typeof payload?.specs === "string"
          ? parseOpenApiSpecs(payload.specs)
          : parseOpenApiSpecs(env.OPENAPI_INGEST_SPECS_JSON ?? env.OPENAPI_INGEST_SPECS);
        const limit = parsePositiveInteger(payload?.limit, 10, 50);
        const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
        const dryRun = payload?.dryRun !== false;
        return {
          specs,
          limit,
          minScore,
          dryRun,
          idempotencyPayload: { specs, limit, minScore, dryRun }
        };
      },
      ingest: ({ specs, limit, minScore }) => ingestOpenApiSpecs({ specs, limit, minScore }),
      dryRunBody: (result) => ({
        ...result,
        dryRun: true,
        created: []
      }),
      resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
        dryRun: false,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors,
        extra: {
          provider: result.provider,
          specCount: result.specCount
        }
      })
    },
    {
      pathname: "/admin/jobs/ingest/standards",
      route: "/admin/jobs/ingest/standards",
      bucket: "admin_jobs_ingest_standards",
      normalize: (payload) => {
        const specs = Array.isArray(payload?.specs) || typeof payload?.specs === "string"
          ? parseStandardsSpecs(payload.specs)
          : parseStandardsSpecs(env.STANDARDS_INGEST_SPECS_JSON ?? env.STANDARDS_INGEST_SPECS);
        const limit = parsePositiveInteger(payload?.limit, 10, 50);
        const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
        const dryRun = payload?.dryRun !== false;
        return {
          specs,
          limit,
          minScore,
          dryRun,
          idempotencyPayload: { specs, limit, minScore, dryRun }
        };
      },
      ingest: ({ specs, limit, minScore }) => ingestStandardsSpecs({ specs, limit, minScore }),
      dryRunBody: (result) => ({
        ...result,
        dryRun: true,
        created: []
      }),
      resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
        dryRun: false,
        created,
        skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
        errors,
        extra: {
          provider: result.provider,
          specCount: result.specCount
        }
      })
    }
  ];
}
