/**
 * Shared types for the Runs surface.
 *
 * `JobSource` is emitted by the backend for every job. For native platform
 * jobs the shape is minimal; for jobs ingested from a third-party system
 * (currently GitHub) the source block carries the upstream handle and
 * whatever context the row/card/panel needs to render without an extra
 * fetch.
 */

export interface GitHubJobSource {
  type: "github_issue";
  repo: string; // "owner/repo"
  issueNumber: number;
  issueUrl: string;
  labels?: string[];
  score?: number;
}

export type JobSource = GitHubJobSource | { type: "native" };

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
