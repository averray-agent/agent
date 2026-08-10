/**
 * The fired-signal queue — one GitHub issue per signal worth saying out loud.
 *
 * A fired signal that only exists inside a workflow artifact has not reached
 * anybody. This turns it into something durable and readable: an issue the
 * operator can see, and that `slack-operator` can read to put a card in Buzz.
 *
 * ## Why an issue and not a direct Buzz publish
 *
 * Publishing to Buzz from GitHub Actions would mean a Nostr signing key in
 * Actions secrets and a **second Buzz publisher** outside `slack-operator`,
 * which owns the client, the schedule and the mute/rate discipline. The
 * deployment plan is explicit that two paths with different gates is how the
 * strict one becomes optional. One publisher; this is just the queue it reads.
 *
 * ## Idempotency is load-bearing here, not a nicety
 *
 * The sweep's state file is committed, but a workflow run writes state to its
 * ephemeral checkout — so a fired signal **re-fires every single day** until a
 * human commits the state bump. Without deduplication that is a new issue per
 * day, forever, for the same fact.
 *
 * So each issue carries a hidden marker and is matched on it, across **every**
 * state including closed. Closing an issue means "handled"; a handled signal
 * must never come back the next morning. This mirrors the hidden-marker pattern
 * the PR-handoff workflow already uses for edit-or-create comments.
 */

const GITHUB_API = "https://api.github.com";
export const QUEUE_LABEL = "social-draft";
const MAX_TITLE = 120;

/** The hidden marker that makes an issue findable and matching idempotent. */
export function markerFor(signalId) {
  return `<!-- social-signal:${signalId} -->`;
}

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json"
  };
}

/**
 * Every issue this queue has ever opened, open or closed.
 *
 * `state=all` is the important part. Filtering to open issues would re-create an
 * issue the operator had deliberately closed — the queue would argue with the
 * person using it.
 */
export async function fetchQueuedIssues({ fetchImpl = globalThis.fetch, token, repo } = {}) {
  const url = `${GITHUB_API}/repos/${repo}/issues?labels=${QUEUE_LABEL}&state=all&per_page=100`;
  const response = await fetchImpl(url, { headers: headers(token) });

  if (!response.ok) {
    throw new Error(`GitHub issue list responded ${response.status}`);
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("GitHub issue list returned no array — refusing to read it as 'nothing queued'");
  }

  // Pull requests come back on this endpoint too; they are never our queue.
  return body
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      state: issue.state,
      body: String(issue.body ?? ""),
      url: issue.html_url
    }));
}

export function issueTitleFor(signal) {
  const claim = String(signal.claim ?? "").trim() || signal.signalId;
  return claim.length > MAX_TITLE ? `${claim.slice(0, MAX_TITLE - 1)}…` : claim;
}

export function issueBodyFor(signal, { sweptAt } = {}) {
  const receipt = signal.receipt ?? {};
  const checked = signal.checkedAgainst ?? {};
  const lines = [
    markerFor(signal.signalId),
    "",
    `**${signal.claim}**`,
    "",
    `- Signal: \`${signal.signalId}\``,
    `- Source: \`${signal.source ?? "transparency"}\``,
    receipt.url ? `- Receipt: ${receipt.url}` : "- Receipt: none recorded",
    sweptAt ? `- First seen: ${sweptAt}` : null
  ].filter(Boolean);

  if (signal.deployVerified === false) {
    lines.push(
      "",
      "> **Merged is not deployed.** This claim says *merged* on purpose. Do not",
      "> promote it to \"shipped\" or \"live\" without checking the merge commit is",
      "> actually on production."
    );
  }

  if (Object.keys(checked).length > 0) {
    lines.push("", "<details><summary>What this was true against</summary>", "", "```json", JSON.stringify(checked, null, 2), "```", "", "</details>");
  }

  lines.push(
    "",
    "---",
    "",
    "Nothing is published by this issue. Close it when the post is written, or",
    "when the moment has passed — closing means handled, and a handled signal",
    "never comes back."
  );

  return lines.join("\n");
}

async function createIssue({ fetchImpl, token, repo, signal, sweptAt }) {
  const response = await fetchImpl(`${GITHUB_API}/repos/${repo}/issues`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      title: issueTitleFor(signal),
      body: issueBodyFor(signal, { sweptAt }),
      labels: [QUEUE_LABEL]
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub issue create responded ${response.status} for ${signal.signalId}`);
  }

  const created = await response.json();
  return { signalId: signal.signalId, number: created.number, url: created.html_url, action: "created" };
}

/**
 * Put every fired signal in the queue, exactly once, ever.
 *
 * Failures are loud. A signal that fired and then silently failed to queue has
 * reached nobody, while the run still reports success — the same
 * looks-wired-does-nothing shape this pipeline has already produced twice.
 */
export async function queueFiredSignals({
  fetchImpl = globalThis.fetch,
  env = process.env,
  signals = [],
  sweptAt,
  log = () => {}
} = {}) {
  if (signals.length === 0) return { queued: [], skipped: [], state: "idle" };

  // Switching the queue off must be a decision someone typed, never something
  // that happens because a variable is missing. Off is recorded and visible;
  // absent is an error.
  if (String(env.SOCIAL_SWEEP_QUEUE ?? "").toLowerCase() === "off") {
    log(`  queue: OFF by SOCIAL_SWEEP_QUEUE — ${signals.length} signal(s) not queued`);
    return { queued: [], skipped: [], state: "off" };
  }

  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    // Firing with nowhere to put it is not something to shrug at: the signal is
    // real and it is about to be dropped. If that is genuinely wanted, say so
    // with SOCIAL_SWEEP_QUEUE=off.
    throw new Error(
      `${signals.length} signal(s) fired but the queue is unconfigured (GITHUB_TOKEN / GITHUB_REPOSITORY). ` +
        `Set SOCIAL_SWEEP_QUEUE=off to run without queueing on purpose.`
    );
  }

  const existing = await fetchQueuedIssues({ fetchImpl, token, repo });
  const queued = [];
  const skipped = [];

  for (const signal of signals) {
    const marker = markerFor(signal.signalId);
    const already = existing.find((issue) => issue.body.includes(marker));

    if (already) {
      skipped.push({
        signalId: signal.signalId,
        number: already.number,
        url: already.url,
        state: already.state,
        action: "already-queued"
      });
      log(`  queue: ${signal.signalId} already #${already.number} (${already.state})`);
      continue;
    }

    const created = await createIssue({ fetchImpl, token, repo, signal, sweptAt });
    queued.push(created);
    log(`  queue: ${signal.signalId} → #${created.number}`);
  }

  return { queued, skipped, state: "live" };
}
