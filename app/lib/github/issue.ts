/**
 * Issue anchoring for the posting wizard. Every bounty starts from a real,
 * public GitHub issue: the URL is parsed strictly, then verified against
 * GitHub's public API (CORS-enabled, unauthenticated) so the form can only
 * proceed from something that exists. Failure modes are named, never
 * papered over.
 */

export interface ParsedIssueUrl {
  owner: string;
  repo: string;
  number: number;
  canonicalUrl: string;
}

const ISSUE_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)\/issues\/(\d+)\/?(?:[#?].*)?$/u;

export function parseIssueUrl(input: string): ParsedIssueUrl | null {
  const match = ISSUE_URL_RE.exec(input.trim());
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    owner: match[1],
    repo: match[2],
    number,
    canonicalUrl: `https://github.com/${match[1]}/${match[2]}/issues/${number}`,
  };
}

export type IssueLookup =
  | { ok: true; title: string; state: "open" | "closed"; htmlUrl: string; isPullRequest: boolean }
  | { ok: false; reason: "not_found" | "rate_limited" | "network" };

export async function fetchIssue(parsed: ParsedIssueUrl): Promise<IssueLookup> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`,
      { headers: { accept: "application/vnd.github+json" } }
    );
    if (response.status === 404) return { ok: false, reason: "not_found" };
    if (response.status === 403 || response.status === 429) return { ok: false, reason: "rate_limited" };
    if (!response.ok) return { ok: false, reason: "network" };
    const body = (await response.json()) as Record<string, unknown>;
    return {
      ok: true,
      title: typeof body.title === "string" ? body.title : "(untitled issue)",
      state: body.state === "closed" ? "closed" : "open",
      htmlUrl: typeof body.html_url === "string" ? body.html_url : parsed.canonicalUrl,
      isPullRequest: Boolean(body.pull_request),
    };
  } catch {
    return { ok: false, reason: "network" };
  }
}

export type DeliverableKind = "report" | "pr";

export interface SeededTemplate {
  task: string;
  criteria: string[];
  title: string;
}

/**
 * Seed task + acceptance criteria from the verified issue. The poster edits
 * from here — a filled starting point instead of a blank box, mirroring the
 * shape the platform has actually verified end-to-end (the report template
 * is the settled kana-dojo dogfood's).
 */
export function seedTemplate(
  kind: DeliverableKind,
  issue: { owner: string; repo: string; number: number; title: string }
): SeededTemplate {
  const repoFull = `${issue.owner}/${issue.repo}`;
  const ref = `${repoFull} issue #${issue.number}`;
  if (kind === "report") {
    return {
      title: `${repoFull}#${issue.number}: ${issue.title}`.slice(0, 120),
      task: `Audit ${ref} ("${issue.title}") and produce an implementation report — affected files, the relevant existing patterns, and a step-by-step plan.`,
      criteria: [
        `Identify the repository files affected by issue #${issue.number}.`,
        `Explain the relevant existing pattern with concrete file and symbol references.`,
        `Provide a step-by-step implementation and validation plan tied to issue #${issue.number}.`,
      ],
    };
  }
  return {
    title: `${repoFull}#${issue.number}: ${issue.title}`.slice(0, 120),
    task: `Resolve ${ref} ("${issue.title}") with a pull request that references the issue.`,
    criteria: [
      `The pull request references issue #${issue.number} and addresses what it asks for.`,
      `Changes follow the repository's existing patterns and conventions.`,
      `The PR description explains the change and how it was validated.`,
    ],
  };
}
