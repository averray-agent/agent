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

export type JobSource =
  | GitHubJobSource
  | WikipediaJobSource
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
