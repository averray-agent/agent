#!/usr/bin/env node
/**
 * The drafter — turns a queued signal into sentences you can copy and post.
 *
 * The queue issue already carries the claim, the receipt, the author's own
 * summary and the do-not-claim rails. What it does not carry is a post. This
 * asks Hermes for a few variants and comments them on the issue, so the last
 * step is copy, paste, send.
 *
 * ## Two halves, because only one of them can be tested
 *
 * Hermes lives on the VPS and is reached over SSH from the workflow — the same
 * lane the operator report uses. That hop cannot run in a unit test, so it is
 * kept out of this file entirely:
 *
 *   `prompt`  reads the issue and writes the prompt          (deterministic)
 *   [workflow SSHes to Hermes with that prompt]              (plumbing only)
 *   `publish` screens Hermes's output and comments           (deterministic)
 *
 * Everything that decides anything is on one side of that line or the other,
 * and both sides are ordinary functions with tests.
 *
 * ## Nothing here trusts the model
 *
 * Every variant is screened by social-draft-check.mjs before it is posted, and
 * a variant that fails is dropped with its reason rather than quietly cleaned
 * up. The screen re-reads `/transparency` at publish time rather than trusting
 * whatever the issue recorded when it was opened, because the point of the
 * check is what is true now.
 *
 * And it still publishes nothing to X. This writes a GitHub comment.
 */
import { readFile } from "node:fs/promises";

import { screenVariants } from "./social-draft-check.mjs";

const GITHUB_API = "https://api.github.com";
const DEFAULT_TRANSPARENCY_URL = "https://api.averray.com/transparency";
export const QUEUE_LABEL = "social-draft";

/** Anchors the drafter's comment so it is written exactly once per issue. */
export const DRAFT_MARKER = "<!-- social-draft-variants -->";

/** Hermes separates variants with this; anything before the first is preamble. */
export const VARIANT_DELIMITER = "---VARIANT---";

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json"
  };
}

/**
 * Open queue issues that have no draft yet.
 *
 * A failed read throws: silently drafting for zero issues, on a day when the
 * API was down, is indistinguishable from a day with nothing to draft.
 */
export async function findIssuesNeedingDrafts({ fetchImpl = globalThis.fetch, token, repo } = {}) {
  const url = `${GITHUB_API}/repos/${repo}/issues?labels=${QUEUE_LABEL}&state=open&per_page=20`;
  const response = await fetchImpl(url, { headers: headers(token) });
  if (!response.ok) throw new Error(`GitHub issue list responded ${response.status}`);

  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("GitHub issue list returned no array — refusing to read it as 'nothing to draft'");
  }

  const issues = body
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ number: issue.number, title: issue.title, body: String(issue.body ?? "") }));

  const needing = [];
  for (const issue of issues) {
    const comments = await fetchComments({ fetchImpl, token, repo, number: issue.number });
    if (!comments.some((c) => c.includes(DRAFT_MARKER))) needing.push(issue);
  }
  return needing;
}

async function fetchComments({ fetchImpl, token, repo, number }) {
  const response = await fetchImpl(`${GITHUB_API}/repos/${repo}/issues/${number}/comments?per_page=100`, {
    headers: headers(token)
  });
  if (!response.ok) throw new Error(`GitHub comment list responded ${response.status} for #${number}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error(`GitHub comment list for #${number} returned no array`);
  return body.map((c) => String(c.body ?? ""));
}

/** Did the queue issue record that the merge was never verified as deployed? */
export function deployVerifiedFrom(issueBody = "") {
  return /Merged is not deployed/u.test(issueBody) ? false : null;
}

/**
 * The prompt. Deliberately narrow: Hermes is asked to phrase material it has
 * been handed, never to research, and never to assert anything the issue does
 * not already contain.
 */
export function buildPrompt(issue) {
  return [
    "You are drafting short posts for the Averray X account. Averray is an agent",
    "job marketplace on Polkadot. The account trades on receipts, not hype.",
    "",
    "Below is a queue issue describing something that happened. Write 2 or 3",
    "alternative posts from it.",
    "",
    "RULES, all of them hard:",
    "- Use ONLY facts present in the issue below. Do not add context you happen",
    "  to know. Do not research anything.",
    "- Every number you write must appear in the issue. Inventing a figure is the",
    "  worst thing you can do here.",
    "- Do not claim anything about outside or external agents using the platform.",
    "- Do not say shipped, launched, released, live, or in production about a",
    "  change the issue describes as merged.",
    "- Lead with the number or the surprise. Specific beats impressive.",
    "- Write like one engineer telling another what they measured. No marketing",
    "  voice, no 'excited to announce', no emoji, no hashtags.",
    "- Under 700 characters each. Prefer no link.",
    "",
    `Separate each post with a line containing exactly ${VARIANT_DELIMITER}`,
    "Output nothing else — no preamble, no numbering, no commentary.",
    "",
    "--- ISSUE ---",
    issue.body
  ].join("\n");
}

/**
 * The answer, extracted from the Hermes CLI's terminal output.
 *
 * `hermes chat -q` is a TUI. It echoes the prompt, prints its reasoning aloud,
 * then draws the actual answer inside a box, then prints a session footer. Only
 * the box is the answer.
 *
 * This is not cosmetic. Measured against the real agent, the reasoning block
 * began "Let me write 2-3 posts following all the rules" — and a parser that
 * merely split on the delimiter would have published that as variant one. The
 * draft check would not have saved us either: the model narrating its
 * instructions contains no false claim, just no post.
 */
export function extractAnswer(raw = "") {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  const open = lines.findIndex((l) => l.trimStart().startsWith("╭") && /Hermes/u.test(l));
  if (open === -1) return text;

  const rest = lines.slice(open + 1);
  const close = rest.findIndex((l) => l.trimStart().startsWith("╰"));
  return (close === -1 ? rest : rest.slice(0, close)).join("\n");
}

/** Split Hermes's answer into variants, discarding chrome and preamble. */
export function parseVariants(raw = "") {
  const answer = extractAnswer(raw);
  const clean = (part) =>
    part
      // Box borders survive on the sides of wrapped lines in some widths.
      .replace(/^[│|]\s?/gmu, "")
      .replace(/\s*[│|]$/gmu, "")
      // Trim BEFORE the fence strip: the fence anchors at string start, and
      // splitting on the delimiter leaves a leading newline in front of it.
      .trim()
      .replace(/^```[a-z]*\n?/iu, "")
      .replace(/\n?```$/u, "")
      .trim();

  if (!answer.includes(VARIANT_DELIMITER)) {
    const single = clean(answer);
    return single ? [single] : [];
  }

  return answer.split(VARIANT_DELIMITER).map(clean).filter(Boolean);
}

/** Read the live payload the screen judges against. */
export async function readObserved({ fetchImpl = globalThis.fetch, url = DEFAULT_TRANSPARENCY_URL } = {}) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} responded ${response.status}`);
  const snapshot = await response.json();
  const pick = (path) =>
    path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), snapshot) ?? {
      value: null,
      status: "unknown"
    };
  return {
    "flow.jobsSettled.allTime": pick("flow.jobsSettled.allTime"),
    "flow.composition24h.external": pick("flow.composition24h.external")
  };
}

export function commentBodyFor({ passed, rejected }) {
  const lines = [DRAFT_MARKER, "", "### Drafts", ""];

  if (passed.length === 0) {
    lines.push(
      "Nothing survived the check. The rejected attempts are below — that is a",
      "finding about the drafting, not about the signal, and the issue stays open."
    );
  } else {
    lines.push("Copy one, edit freely, post it by hand. Then close this issue.", "");
    passed.forEach((text, i) => {
      lines.push(`**${i + 1}.**`, "", "```text", text, "```", "");
    });
  }

  if (rejected.length > 0) {
    lines.push(
      "",
      "<details><summary>Rejected by the draft check</summary>",
      "",
      "Kept deliberately: a silent filter is one nobody audits.",
      ""
    );
    for (const item of rejected) {
      lines.push(`- ${item.violations.map((v) => `\`${v.reason}\` — ${v.detail}`).join("; ")}`);
      lines.push("", "  > " + item.text.split("\n").join("\n  > "), "");
    }
    lines.push("</details>");
  }

  return lines.join("\n");
}

export async function postDraftComment({ fetchImpl = globalThis.fetch, token, repo, number, body } = {}) {
  const response = await fetchImpl(`${GITHUB_API}/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ body })
  });
  if (!response.ok) throw new Error(`GitHub comment create responded ${response.status} for #${number}`);
  return response.json();
}

/** `publish` — screen Hermes's output for one issue and comment the result. */
export async function publishDraft({
  fetchImpl = globalThis.fetch,
  env = process.env,
  issue,
  raw,
  log = () => {}
} = {}) {
  const observed = await readObserved({
    fetchImpl,
    url: env.TRANSPARENCY_URL || DEFAULT_TRANSPARENCY_URL
  });

  const { passed, rejected } = screenVariants(parseVariants(raw), {
    observed,
    sources: [issue.body],
    deployVerified: deployVerifiedFrom(issue.body)
  });

  log(`  #${issue.number}: ${passed.length} passed, ${rejected.length} rejected`);
  for (const item of rejected) log(`    rejected — ${item.violations.map((v) => v.reason).join(", ")}`);

  const body = commentBodyFor({ passed, rejected });
  await postDraftComment({
    fetchImpl,
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    number: issue.number,
    body
  });

  return { number: issue.number, passed: passed.length, rejected: rejected.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const env = process.env;

  const run = async () => {
    if (mode === "prompt") {
      const issues = await findIssuesNeedingDrafts({
        token: env.GITHUB_TOKEN,
        repo: env.GITHUB_REPOSITORY
      });
      if (issues.length === 0) {
        process.stdout.write("");
        console.error("social-draft-writer: no issues need a draft");
        return;
      }
      // One at a time. A batch prompt invites the model to blur two signals
      // into one post, and the whole point is that each post has one receipt.
      const issue = issues[0];
      console.error(`social-draft-writer: drafting for #${issue.number}`);
      process.stdout.write(JSON.stringify({ number: issue.number, prompt: buildPrompt(issue) }));
      return;
    }

    if (mode === "publish") {
      const issueJson = JSON.parse(await readFile(env.SOCIAL_DRAFT_ISSUE_FILE, "utf8"));
      const raw = await readFile(env.SOCIAL_DRAFT_RAW_FILE, "utf8");
      const issues = await findIssuesNeedingDrafts({
        token: env.GITHUB_TOKEN,
        repo: env.GITHUB_REPOSITORY
      });
      const issue = issues.find((i) => i.number === issueJson.number);
      if (!issue) {
        console.error(`social-draft-writer: #${issueJson.number} already has a draft — nothing posted`);
        return;
      }
      const result = await publishDraft({ env, issue, raw, log: console.error });
      console.error(`social-draft-writer: commented on #${result.number}`);
      return;
    }

    throw new Error(`unknown mode "${mode}" — expected "prompt" or "publish"`);
  };

  run().catch((error) => {
    console.error(error?.stack ?? error?.message ?? error);
    process.exitCode = 1;
  });
}
