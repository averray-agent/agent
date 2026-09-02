export const DEFAULT_OPEN_PR_CAP_PER_REPO = 3;

export const DEFAULT_SECURITY_STANDARDS_DENYLIST = Object.freeze([
  "bitcoin/bitcoin",
  "ethereum/go-ethereum",
  "openssl/openssl",
  "python/cpython",
  "rust-lang/rust",
  "nodejs/node",
  "golang/go",
  "paritytech/polkadot-sdk",
  "w3c/*",
  "tc39/*"
]);

export const DEFAULT_POLICY_FILE_PATHS = Object.freeze([
  "CONTRIBUTING.md",
  "CONTRIBUTING",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  ".github/CODE_OF_CONDUCT.md"
]);

const DENY_AI_PATTERNS = [
  /\b(no|not|never)\s+(ai|llm|chatgpt|copilot|bot|automated|autonomous)\b/u,
  /\b(ai|llm|chatgpt|copilot|bot|automated|autonomous)[-\s]*(generated|assisted)?\s*(contributions?|pull requests?|prs?|patches?)\s+(are\s+)?(not\s+)?(allowed|accepted|permitted)/u,
  /\b(do\s+not|don't)\s+(submit|send|open)\s+(ai|llm|chatgpt|copilot|bot|automated|autonomous)/u,
  /\b(ai|llm|chatgpt|copilot|bot|automated|autonomous)\s+(contributions?|pull requests?|prs?|patches?)\s+(will\s+be\s+)?(rejected|closed)/u
];

const STOP_SIGNAL_PATTERNS = [
  /\b(stop|cease)\s+(submitting|opening|sending)\b/u,
  /\b(do\s+not|don't)\s+(submit|open|send)\s+(more|any)\b/u,
  /\b(no\s+more)\s+(averray|agent|ai|bot|automated)\b/u,
  /\b(averray|agent|ai|bot|automated)\s+(prs?|pull requests?|contributions?)\s+(are\s+)?(not\s+welcome|banned|prohibited)/u
];

const FOOTER_HEADER = "This contribution was prepared by an autonomous agent operating on the";

export function normalizeRepo(repo) {
  const value = String(repo ?? "").trim().replace(/^https:\/\/github\.com\//u, "");
  const [owner, name] = value.split("/").filter(Boolean);
  if (!owner || !name) return "";
  return `${owner.toLowerCase()}/${name.toLowerCase().replace(/\.git$/u, "")}`;
}

export function parseRepoList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizeRepoPattern).filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(normalizeRepoPattern).filter(Boolean);
  } catch {
    // Fall through to comma/newline parsing.
  }
  return String(raw)
    .split(/\n|,/u)
    .map(normalizeRepoPattern)
    .filter(Boolean);
}

export function isRepoDenied(repo, denylist = DEFAULT_SECURITY_STANDARDS_DENYLIST) {
  const normalized = normalizeRepo(repo);
  if (!normalized) return false;
  return denylist.some((entry) => repoMatchesPattern(normalized, entry));
}

export function scanPolicyText(text) {
  const normalized = String(text ?? "").toLowerCase();
  const aiPolicyMatch = DENY_AI_PATTERNS.find((pattern) => pattern.test(normalized));
  if (aiPolicyMatch) {
    return { allowed: false, reason: "repo_ai_policy_denies_agent_contributions" };
  }
  const stopSignalMatch = STOP_SIGNAL_PATTERNS.find((pattern) => pattern.test(normalized));
  if (stopSignalMatch) {
    return { allowed: false, reason: "maintainer_stop_signal" };
  }
  return { allowed: true };
}

export async function scanGithubRepoPolicyFiles({
  repo,
  githubToken = undefined,
  fetchImpl = fetch,
  paths = DEFAULT_POLICY_FILE_PATHS
} = {}) {
  const normalizedRepo = normalizeRepo(repo);
  if (!normalizedRepo) {
    return { allowed: true, scannedPaths: [], matches: [] };
  }

  const headers = {
    accept: "application/vnd.github.raw",
    "user-agent": "averray-maintainer-policy-scanner"
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;

  const scannedPaths = [];
  const matches = [];
  for (const path of paths) {
    const url = `https://api.github.com/repos/${encodeURIComponent(normalizedRepo.split("/")[0])}/${encodeURIComponent(normalizedRepo.split("/")[1])}/contents/${encodeURIComponent(path).replace(/%2F/gu, "/")}`;
    const response = await fetchImpl(url, { headers });
    if (response.status === 404) continue;
    if (!response.ok) continue;
    const text = await response.text();
    scannedPaths.push(path);
    const result = scanPolicyText(text);
    if (!result.allowed) {
      matches.push({ path, reason: result.reason });
    }
  }

  return {
    allowed: matches.length === 0,
    reason: matches[0]?.reason,
    scannedPaths,
    matches
  };
}

export async function evaluateMaintainerSurfaceForIssue(issue, {
  denylistRepos = DEFAULT_SECURITY_STANDARDS_DENYLIST,
  scanRepoPolicies = false,
  githubToken = undefined,
  fetchImpl = fetch
} = {}) {
  const repo = repoFromIssue(issue);
  if (isRepoDenied(repo, denylistRepos)) {
    return { allowed: false, repo, reason: "repo_denylisted", denylistHit: true };
  }

  const issuePolicy = scanPolicyText(`${issue?.title ?? ""}\n${issue?.body ?? ""}`);
  if (!issuePolicy.allowed) {
    return { allowed: false, repo, reason: issuePolicy.reason, issueBodyHit: true };
  }

  if (scanRepoPolicies) {
    const scan = await scanGithubRepoPolicyFiles({ repo, githubToken, fetchImpl });
    if (!scan.allowed) {
      return { allowed: false, repo, reason: scan.reason, policyScan: scan };
    }
    return { allowed: true, repo, policyScan: scan };
  }

  return { allowed: true, repo };
}

export function buildAverrayDisclosureFooter({
  agentWallet = "0x...",
  jobSpecUrl = "https://api.averray.com/jobs/{id}",
  submissionHash = "0x{hash}"
} = {}) {
  return [
    "This contribution was prepared by an autonomous agent operating on the",
    "Averray platform.",
    "",
    `Agent identity: ${agentWallet}`,
    `Job spec:       ${jobSpecUrl}`,
    `Submission:     ${submissionHash}`,
    "",
    "Maintainer review of the substance is requested before merge.",
    "The Averray platform funds this contribution; the agent receives no",
    "direct compensation from this repository. Decline at will."
  ].join("\n");
}

export function hasAverrayDisclosureFooter(text) {
  return String(text ?? "").includes(FOOTER_HEADER) && String(text ?? "").includes("Averray platform.");
}

export function appendAverrayDisclosureFooter(body, footerOptions = {}) {
  const value = String(body ?? "").trimEnd();
  if (hasAverrayDisclosureFooter(value)) return value;
  return `${value}${value ? "\n\n" : ""}${buildAverrayDisclosureFooter(footerOptions)}`;
}

export async function countOpenGithubPullRequestsForRepo(stateStore, repo, { limit = 10_000 } = {}) {
  if (!stateStore?.listFundedJobs) return 0;
  const normalizedRepo = normalizeRepo(repo);
  if (!normalizedRepo) return 0;
  const records = await stateStore.listFundedJobs({ limit });
  return records.filter((record) =>
    normalizeRepo(record?.upstream?.repo) === normalizedRepo
    && record?.upstream?.kind === "github_pull_request"
    && !["merged", "closed_unmerged", "open_stale", "reverted"].includes(record?.finalStatus)
  ).length;
}

export function repoFromIssue(issue) {
  const fromApiUrl = String(issue?.repository_url ?? "").split("/repos/").at(-1);
  if (fromApiUrl) return normalizeRepo(fromApiUrl);
  const match = String(issue?.html_url ?? "").match(/github\.com\/([^/]+\/[^/]+)\/issues\//u);
  return normalizeRepo(match?.[1]);
}

function normalizeRepoPattern(value) {
  const pattern = String(value ?? "").trim().toLowerCase();
  if (!pattern) return "";
  if (pattern.endsWith("/*")) {
    const owner = pattern.slice(0, -2).replace(/^https:\/\/github\.com\//u, "");
    return owner ? `${owner}/*` : "";
  }
  return normalizeRepo(pattern);
}

function repoMatchesPattern(repo, pattern) {
  const normalizedPattern = normalizeRepoPattern(pattern);
  if (!normalizedPattern) return false;
  if (normalizedPattern.endsWith("/*")) {
    return repo.startsWith(`${normalizedPattern.slice(0, -2)}/`);
  }
  return repo === normalizedPattern;
}
