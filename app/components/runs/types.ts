/**
 * Shared types for the Runs surface.
 *
 * `JobSource` is emitted by the backend for every job. For native platform
 * jobs the shape is minimal; for jobs ingested from a third-party system
 * (currently GitHub or Wikipedia) the source block carries the upstream
 * handle and whatever context the row/card/panel needs to render without
 * an extra fetch.
 */

export interface GitHubJobSource {
  type: "github_issue";
  repo: string; // "owner/repo"
  issueNumber: number;
  issueUrl: string;
  labels?: string[];
  score?: number;
}

/**
 * Provenance for runs ingested from Wikipedia. The platform never edits
 * Wikipedia directly — agents submit evidence + a structured proposal
 * back to Averray, and any later public Wikipedia activity is performed
 * by Averray (or an approved Averray editor/bot account). The source
 * block carries everything the UI needs to render the page reference
 * without fetching from the Wikipedia API.
 */
export interface WikipediaJobSource {
  type: "wikipedia_article";
  pageTitle: string; // "Polkadot (cryptocurrency)"
  language: string; // "en", "de", "fr", …
  pageUrl: string; // "https://en.wikipedia.org/wiki/Polkadot_(cryptocurrency)"
  revisionId: number; // exact revision the agent should diff against
  /**
   * One of the platform's built-in Wikipedia task types — e.g.
   * "citation_repair", "freshness_check", "infobox_consistency". Drives
   * the verifier path and the receipt's proposal shape. Kept as a free
   * string here so the frontend doesn't have to follow every backend
   * task-type addition.
   */
  taskType: string;
  score?: number;
}

/**
 * Provenance for runs ingested from the OSV (Open Source Vulnerabilities)
 * advisory database — currently the npm ecosystem subset, with NVD/CVE
 * cross-references when present. These are dependency-remediation jobs:
 * the worker opens a focused PR that bumps a vulnerable package to its
 * fixed version and updates lockfiles + tests. The platform itself
 * publishes nothing back to OSV/NVD; this is purely an ingest channel.
 */
export interface OsvJobSource {
  type: "osv_advisory";
  /** Always "osv" today; field reserved for future advisory feeds. */
  provider: string;
  ecosystem: string; // "npm" today; future: "PyPI", "RubyGems", "crates.io"
  packageName: string;
  vulnerableVersion: string;
  fixedVersion: string;
  repo: string; // "owner/repo" of the consumer that depends on the vuln package
  manifestPath: string; // e.g. "package.json" or "frontend/package.json"
  advisoryId: string; // "GHSA-vh95-rmgr-6w4m"
  /** Cross-DB IDs (e.g. CVE-2021-44906). May be empty. */
  aliases?: string[];
  /** Subset of aliases that look like CVEs. Primary input for the NVD chip. */
  cves?: string[];
  /** Direct nvd.nist.gov links per CVE, in the same order as `cves`. */
  nvdUrls?: string[];
  summary?: string;
  details?: string;
  references?: string[];
  /** Free string from OSV — "LOW" | "MODERATE" | "HIGH" | "CRITICAL" or numeric. */
  severity?: string;
  published?: string;
  modified?: string;
  score?: number;
  /** OSV API endpoint the ingestor used; surfaced in the receipt for audit. */
  discoveryApi?: string;
}

/**
 * Provenance for runs ingested from open-data catalogs (Data.gov today,
 * with other portals reserved for the future). These are dataset/
 * resource quality AUDIT jobs — the worker reports reachability, format
 * clarity, schema, and stale-metadata findings on a public dataset and
 * its resource. The platform never edits source data and never contacts
 * the publishing agency from this workflow.
 *
 * Field set mirrors what `mcp-server/src/jobs/ingest-open-data-datasets.js`
 * emits today: dataset + resource identity, optional agency/license/
 * modified-at, and the discovery-API endpoint that found the record.
 */
export interface OpenDataJobSource {
  type: "open_data_dataset";
  /** "data.gov" today; reserved for future portals. */
  provider: string;
  /** Mirror of `provider` from the backend payload. */
  portal?: string;
  datasetId?: string;
  datasetTitle: string;
  datasetUrl: string;
  resourceId?: string;
  resourceTitle?: string;
  resourceUrl: string;
  /** "CSV", "JSON", "ZIP", "GeoJSON", … — free string from the catalog. */
  resourceFormat?: string;
  /** Publishing agency / organisation. Optional. */
  agency?: string;
  license?: string;
  modified?: string;
  metadataModified?: string;
  score?: number;
  /** Catalog API endpoint that discovered the dataset; surfaced in the receipt for audit. */
  discoveryApi?: string;
}

/**
 * Provenance for runs ingested from a published OpenAPI spec — used by
 * the platform to audit the OpenAPI quality of its own and partner
 * APIs. The audit doesn't edit the spec; the worker submits a structured
 * findings + recommendations report.
 */
export interface OpenApiJobSource {
  type: "openapi_spec";
  /** Stable identifier for the spec, e.g. "averray-http-api". */
  specId: string;
  /** Human title from the OpenAPI document (`info.title`). */
  apiTitle: string;
  /** Provider/owner of the API (e.g. "averray", "stripe"). */
  provider: string;
  /** Canonical URL of the OpenAPI document. */
  specUrl: string;
  /** Final URL after any redirects (the resolved spec). */
  finalUrl?: string;
  /** Version reported in `info.version` of the spec. */
  documentVersion?: string;
  /** "3.0.0", "3.1.0", … */
  openapiVersion?: string;
  /** GitHub-style "owner/repo" hosting the spec, when known. */
  repo?: string;
  pathCount?: number;
  operationCount?: number;
  schemaCount?: number;
  score?: number;
}

/**
 * Provenance for runs ingested from a published technical standard — W3C
 * Recommendations, IETF RFCs, etc. The audit checks freshness and
 * correctness of how Averray references the standard; no edits to the
 * standard itself.
 */
export interface StandardsJobSource {
  type: "standards_spec";
  /** Stable identifier for the standard (e.g. "vc-data-model-2.0"). */
  specId: string;
  /** Human title (e.g. "Verifiable Credentials Data Model v2.0"). */
  specTitle: string;
  /** Standards body / publisher — "w3c", "ietf", "iso", … */
  provider: string;
  /** Canonical URL where the spec lives. */
  specUrl: string;
  /** Final URL after any redirects. */
  finalUrl?: string;
  /** "W3C Recommendation", "Proposed Standard", … */
  expectedStatus?: string;
  /** Version reported on the published spec page. */
  currentVersion?: string;
  /** GitHub-style "owner/repo" hosting Averray's reference, when known. */
  repo?: string;
  score?: number;
}

export type JobSource =
  | GitHubJobSource
  | WikipediaJobSource
  | OsvJobSource
  | OpenDataJobSource
  | OpenApiJobSource
  | StandardsJobSource
  | { type: "native" };

/**
 * Rich context surfaced in the Loaded-run panel when the selected run was
 * ingested from GitHub. This is the "full task context" a worker needs to
 * decide whether to claim (and, once claimed, to execute).
 */
export interface GitHubJobContext extends GitHubJobSource {
  title: string;
  body: string; // markdown/plain text of the issue body
  category: string; // docs | coding | testing | bugfix | ...
  acceptanceCriteria: string[];
  agentInstructions: string;
  verification: {
    method: string; // e.g. "github_pr"
    signals: string[];
  };
}

/**
 * Rich context surfaced in the Loaded-run panel when the selected run is
 * a Wikipedia maintenance proposal. Mirrors GitHubJobContext but carries
 * the Wikipedia handle + a hard non-editing policy: workers submit
 * proposals to Averray, never directly to Wikipedia.
 */
export interface WikipediaJobContext extends WikipediaJobSource {
  title: string;
  body: string; // human-written summary of what the maintenance run is for
  category: string; // always "wikipedia" today; reserved for future sub-types
  acceptanceCriteria: string[];
  agentInstructions: string;
  verification: {
    method: string; // e.g. "wikipedia_proposal_review"
    signals: string[];
  };
}

/**
 * Rich context for OSV dependency-remediation runs. Mirrors the shape of
 * GitHub/Wikipedia contexts so the Loaded-run panel can render a third
 * source-specific evidence block without growing a new code path.
 */
export interface OsvJobContext extends OsvJobSource {
  title: string;
  body: string; // human-readable advisory summary, used as the panel intro
  category: string; // always "security" today; kept free for future sub-types
  acceptanceCriteria: string[];
  agentInstructions: string;
  verification: {
    method: string; // e.g. "osv_dependency_pr"
    signals: string[];
  };
}

/**
 * Rich context for open-data dataset quality-audit runs. Same shape as
 * the other source contexts so the Loaded-run panel can render a fourth
 * source-specific evidence block without a new code path.
 */
export interface OpenDataJobContext extends OpenDataJobSource {
  title: string;
  body: string; // human-readable description of the audit scope
  category: string; // always "data" today; reserved for future sub-types
  acceptanceCriteria: string[];
  agentInstructions: string;
  verification: {
    method: string; // e.g. "open_data_quality_audit"
    signals: string[];
  };
}
