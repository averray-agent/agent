/**
 * "We shipped something" signals — merged pull requests carrying a label.
 *
 * The second source in the social signal sweep, and the only one that will fire
 * regularly for the foreseeable future: the transparency thresholds sit at 500
 * settled jobs and the first external agent, both a long way off, while pull
 * requests merge every day.
 *
 * **The human is the trigger, deliberately.** A model asked "which of today's
 * merges is interesting?" is confidently wrong in a way that produces filler,
 * and filler is what kills an account that trades on receipts. A label is a
 * one-second decision that removes the entire failure mode. This module's job
 * is noticing the label, not judging the change.
 *
 * ## The truth boundary here is different from transparency's
 *
 * A transparency claim can be falsified by re-reading the endpoint. A merge
 * claim cannot be falsified that way, and it carries its own trap:
 *
 *   **merged ≠ deployed.**
 *
 * "We shipped X" about a change that is merged but not yet on production is
 * precisely the "more live than it is" failure this codebase exists to avoid.
 * So the claim this module emits says **merged**, never "shipped", "live", or
 * "launched", and it carries `mergedAt` plus the PR URL so the statement is
 * checkable.
 *
 * Promoting "merged" to "live" is a DRAFTING decision, and it must not be taken
 * without verifying the merge commit is actually deployed. That rule belongs to
 * step 2 and is recorded in the packet; nothing here may pre-authorise it.
 */

export const DEFAULT_SHIPPED_LABEL = "social";
const GITHUB_API = "https://api.github.com";
const MAX_PULLS = 20;
const MAX_CONTEXT_CHARS = 1200;

/**
 * The author's own summary, trimmed to something readable in an issue.
 *
 * Markdown headings, HTML comments and the Claude Code trailer are dropped —
 * they are the PR's furniture, not its content. Everything kept is the author's
 * words, never paraphrased: a paraphrase here would be an unreviewed claim
 * entering the pipeline through the back door.
 */
export function summariseBody(body = "") {
  // `?? ""` rather than relying on the default: a default parameter does not
  // apply to an explicit null, and String(null) is the word "null" — which would
  // have been rendered into an issue as if the author had written it.
  const cleaned = String(body ?? "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/^🤖 Generated with .*$/gmu, "")
    .replace(/^Co-Authored-By: .*$/gmu, "")
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block && !/^#{1,6}\s/u.test(block) && !/^-{3,}$/u.test(block))
    .join("\n\n")
    .trim();

  if (cleaned.length <= MAX_CONTEXT_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_CONTEXT_CHARS).trimEnd()}…`;
}

/**
 * Is this source configured at all?
 *
 * `skipped` means the feature is off — no token, no repo. That is a different
 * state from `degraded`, which means we were meant to look and could not, and
 * the two must never collapse into "nothing shipped today".
 */
export function assessGitHub({ env = process.env } = {}) {
  if (!env.GITHUB_TOKEN) return { state: "skipped", reason: "GITHUB_TOKEN not set" };
  if (!env.GITHUB_REPOSITORY) return { state: "skipped", reason: "GITHUB_REPOSITORY not set" };
  return { state: "live", reason: null };
}

/**
 * Merged pull requests carrying the label, newest first.
 *
 * Throws on any non-200. An empty list must only ever mean "nothing is
 * labelled" — never "the search failed", which is the same conflation the
 * transparency reader guards against.
 */
export async function fetchShippedPullRequests({
  fetchImpl = globalThis.fetch,
  token,
  repo,
  label = DEFAULT_SHIPPED_LABEL
} = {}) {
  const query = `repo:${repo} is:pr is:merged label:${label}`;
  const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=${MAX_PULLS}&sort=updated&order=desc`;

  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub search responded ${response.status} for label "${label}"`);
  }

  const body = await response.json();
  if (!Array.isArray(body?.items)) {
    throw new Error("GitHub search returned no items array — refusing to read it as 'nothing shipped'");
  }

  return body.items.map((item) => ({
    number: item.number,
    title: String(item.title ?? "").trim(),
    url: item.html_url,
    // `closed_at` on a merged PR is the merge time; the search API does not
    // expose `merged_at` on issue results.
    mergedAt: item.closed_at ?? null,
    // The author's own account of what they did. Carried so the queue issue
    // holds the material to write from, instead of a link to go read.
    body: String(item.body ?? "")
  }));
}

/**
 * Turn merged pull requests into candidate signals.
 *
 * `shippedSeededAt` marks whether this source has ever been read. On the first
 * encounter every already-labelled PR looks new, and announcing them would open
 * with a backlog presented as today's news — so the first pass records them all
 * as seeded and announces nothing, exactly as the transparency side seeds
 * already-crossed thresholds.
 *
 * **After that, merge time is deliberately NOT a filter.** An earlier draft
 * watermarked on the newest merge, which meant labelling a pull request from
 * last week did nothing at all — the label is the operator's decision that
 * something is worth saying, and a decision that silently does nothing is worse
 * than one that fires late. Repeats are prevented by `firedSignals` alone, so a
 * PR fires exactly once whenever it acquires the label.
 */
export function buildShippedCandidates({ pulls = [], state = {}, nowIso }) {
  const seeding = !state.shippedSeededAt;

  const eligible = pulls
    .filter((pull) => pull.mergedAt)
    .filter((pull) => !state.firedSignals?.[`shipped-pr-${pull.number}`])
    .sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));

  const candidates = eligible.map((pull) => ({
    signalId: `shipped-pr-${pull.number}`,
    source: "github",
    // "Merged", never "shipped" or "live" — see the header. The PR title is the
    // author's own words; this module does not paraphrase it.
    claim: `Merged: ${pull.title}`,
    claimsExternalActivity: false,
    restsOn: [],
    receipt: { kind: "pull-request", url: pull.url, mergedAt: pull.mergedAt },
    context: summariseBody(pull.body),
    // Recorded so a drafter cannot silently promote "merged" to "live".
    deployVerified: false,
    seedOnly: seeding
  }));

  return {
    candidates,
    // Set once, then never moved. Its only job is telling a first encounter
    // from every later one.
    nextShippedSeededAt: state.shippedSeededAt ?? nowIso,
    seeding
  };
}
