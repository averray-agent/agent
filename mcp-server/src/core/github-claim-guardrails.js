import { randomUUID } from "node:crypto";
import { isHostedCanaryClaimant } from "./claimant-attribution.js";
import {
  acquireMaintainerRepoClaimLock,
  positiveGithubRepoId,
  resolveJobRepoIdentity
} from "./maintainer-repo-claim-cap.js";
import { createSelfIdentityRegistry } from "./self-identity-registry.js";

export const DEFAULT_GITHUB_REPO_CLAIM_BURST_WALLETS = 2;
export const DEFAULT_GITHUB_REPO_CLAIM_BURST_MIN = 10;
export const DEFAULT_GITHUB_LANE_BURST_WALLETS = 3;
export const DEFAULT_GITHUB_LANE_BURST_MIN = 5;
export const DEFAULT_GITHUB_CLAIM_BURST_LOOKBACK_HOURS = 24;
export const DEFAULT_GITHUB_PR_SELF_MERGE_MODE = "log";
export const GITHUB_PR_SELF_MERGE_COUNTER_SCOPE = "github-pr-self-merge";
export const GITHUB_PR_SELF_MERGE_REASON = "github_pr_self_merge_review";

const PAGE_SIZE = 100;
const MAX_SESSIONS = 10_000;
const WALLET_RE = /^0x[0-9a-f]{40}$/u;

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function positiveGithubUserId(value) {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function normalizeClaimWallet(value) {
  const wallet = String(value ?? "").trim().toLowerCase();
  return WALLET_RE.test(wallet) ? wallet : null;
}

export function loadGithubClaimGuardrailConfig(env = process.env) {
  const repoWindowMinutes = positiveInt(env?.GITHUB_REPO_CLAIM_BURST_MIN, DEFAULT_GITHUB_REPO_CLAIM_BURST_MIN);
  const laneWindowMinutes = positiveInt(env?.GITHUB_LANE_BURST_MIN, DEFAULT_GITHUB_LANE_BURST_MIN);
  const lookbackHours = positiveInt(env?.GITHUB_CLAIM_BURST_LOOKBACK_HOURS, DEFAULT_GITHUB_CLAIM_BURST_LOOKBACK_HOURS);
  const lookbackMs = Math.max(lookbackHours * 3_600_000, repoWindowMinutes * 60_000, laneWindowMinutes * 60_000);
  return {
    repoWallets: positiveInt(env?.GITHUB_REPO_CLAIM_BURST_WALLETS, DEFAULT_GITHUB_REPO_CLAIM_BURST_WALLETS),
    repoWindowMinutes,
    laneWallets: positiveInt(env?.GITHUB_LANE_BURST_WALLETS, DEFAULT_GITHUB_LANE_BURST_WALLETS),
    laneWindowMinutes,
    lookbackHours,
    lookbackMs
  };
}

export function loadGithubPrSelfMergeConfig(env = process.env) {
  return {
    mode: env?.GITHUB_PR_SELF_MERGE_MODE === "enforce" ? "enforce" : DEFAULT_GITHUB_PR_SELF_MERGE_MODE
  };
}

export function isGithubBot(actor) {
  return String(actor?.type ?? "").toLowerCase() === "bot";
}

// A person is the pull author's numeric GitHub user id from the API read.
// A login, a renamed login, a footer handle, or a Bot account is not a person.
export function githubPersonId(lookup) {
  if (lookup?.status !== "verified") return null;
  const binding = lookup.claimantBinding;
  if (binding?.status !== "matched") return null;
  if (binding.walletMatches !== true && binding.sessionMatches !== true) return null;
  if (isGithubBot(lookup.author)) return null;
  return positiveGithubUserId(lookup.author?.id);
}

export function githubPersonFromLookups(verificationLookup, observationLookup) {
  const verificationId = githubPersonId(verificationLookup);
  const observationId = githubPersonId(observationLookup);
  if (verificationId != null && observationId != null && verificationId !== observationId) return null;
  return verificationId ?? observationId ?? null;
}

export function indexPersonLinks(pairs) {
  const byWallet = new Map();
  for (const pair of pairs ?? []) {
    const wallet = normalizeClaimWallet(pair?.wallet);
    const personId = positiveGithubUserId(pair?.personId);
    if (!wallet || personId == null) continue;
    const existing = byWallet.get(wallet);
    if (existing == null) byWallet.set(wallet, personId);
    else if (existing !== personId) byWallet.set(wallet, "ambiguous");
  }
  return byWallet;
}

export function publicGithubLookup(lookup) {
  if (!lookup || typeof lookup !== "object") return lookup;
  const login = typeof lookup.author?.login === "string" ? lookup.author.login : null;
  const author = login ? { login } : null;
  const copy = { ...lookup };
  delete copy.mergedBy;
  delete copy.repoOwner;
  if (author) copy.author = author;
  else delete copy.author;
  return copy;
}

export function verdictForStorage(verdict) {
  if (!verdict || typeof verdict !== "object" || !verdict.githubLookup) return verdict;
  return { ...verdict, githubLookup: publicGithubLookup(verdict.githubLookup) };
}

function bump(counts, key, delta) {
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

// Largest set of distinct keys whose timestamps fit in windowMs, inclusive.
export function distinctInWindow(events, windowMs, minimum) {
  const sorted = [...events].filter((event) => Number.isFinite(event?.at) && event.key != null)
    .sort((a, b) => a.at - b.at || String(a.key).localeCompare(String(b.key)));
  const counts = new Map();
  const firing = new Set();
  let left = 0;
  let max = 0;
  let firstAt = null;
  let lastAt = null;
  for (let right = 0; right < sorted.length; right += 1) {
    bump(counts, sorted[right].key, 1);
    while (sorted[right].at - sorted[left].at > windowMs) {
      bump(counts, sorted[left].key, -1);
      left += 1;
    }
    if (counts.size > max) max = counts.size;
    if (counts.size >= minimum) {
      for (const key of counts.keys()) firing.add(key);
      if (firstAt == null || sorted[left].at < firstAt) firstAt = sorted[left].at;
      if (lastAt == null || sorted[right].at > lastAt) lastAt = sorted[right].at;
    }
  }
  return { max, firing: [...firing], firstAt, lastAt };
}

function claimIsOurs(claim, registry) {
  if (isHostedCanaryClaimant(claim.session)) return true;
  return registry?.classify?.({ wallet: claim.wallet, session: claim.session })?.actor === "self";
}

function laneIdentity(wallet, links) {
  const person = links.get(wallet);
  return typeof person === "number" ? `person:${person}` : `wallet:${wallet}`;
}

function burstTimes(window) {
  return {
    firstAt: Number.isFinite(window.firstAt) ? new Date(window.firstAt).toISOString() : null,
    lastAt: Number.isFinite(window.lastAt) ? new Date(window.lastAt).toISOString() : null
  };
}

function scanClaimBursts(claims, { byWallet, registry, config }) {
  const repoWindowMs = config.repoWindowMinutes * 60_000;
  const laneWindowMs = config.laneWindowMinutes * 60_000;
  const byRepo = new Map();
  const laneEvents = [];
  const oursWallets = new Set();
  let repoAmbiguous = 0;
  for (const claim of claims) {
    if (claimIsOurs(claim, registry)) {
      oursWallets.add(claim.wallet);
      continue;
    }
    if (claim?.repoId == null) repoAmbiguous += 1;
    else {
      const row = byRepo.get(claim.repoId) ?? [];
      row.push({ key: claim.wallet, at: claim.claimedAt, wallet: claim.wallet });
      byRepo.set(claim.repoId, row);
    }
    laneEvents.push({ key: laneIdentity(claim.wallet, byWallet), at: claim.claimedAt, wallet: claim.wallet });
  }
  const repoBursts = [];
  for (const [repoId, events] of byRepo) {
    const window = distinctInWindow(events, repoWindowMs, config.repoWallets);
    if (window.max < config.repoWallets) continue;
    repoBursts.push({
      repoId,
      distinctWallets: window.max,
      windowMinutes: config.repoWindowMinutes,
      wallets: [...window.firing].sort(),
      ...burstTimes(window)
    });
  }
  repoBursts.sort((a, b) => a.repoId - b.repoId);
  const laneWindow = distinctInWindow(laneEvents, laneWindowMs, config.laneWallets);
  return {
    repoBursts,
    repoAmbiguous,
    oursWallets,
    laneWindow,
    laneWarning: laneWindow.max >= config.laneWallets
  };
}

export function summarizeGithubClaimGuardrails({
  claims = [],
  links = [],
  registry = createSelfIdentityRegistry(),
  config = loadGithubClaimGuardrailConfig(),
  ambiguousAuthors = 0,
  linkedAuthors = 0,
  now = new Date()
} = {}) {
  const byWallet = indexPersonLinks(links);
  const history = scanClaimBursts(claims, { byWallet, registry, config });
  const cutoff = +new Date(now) - config.lookbackMs;
  const live = scanClaimBursts(claims.filter((claim) => claim.claimedAt >= cutoff), { byWallet, registry, config });
  const persons = new Map();
  for (const [wallet, personId] of byWallet) {
    if (typeof personId !== "number") continue;
    const row = persons.get(personId) ?? new Set();
    row.add(wallet);
    persons.set(personId, row);
  }
  const sameAuthor = [...persons.entries()]
    .filter(([, wallets]) => wallets.size >= 2)
    .map(([personId, wallets]) => ({ personId, distinctWallets: wallets.size, wallets: [...wallets].sort() }))
    .sort((a, b) => a.personId - b.personId);

  const warnings = [];
  if (live.repoBursts.length > 0) {
    const distinctWallets = Math.max(...live.repoBursts.map((row) => row.distinctWallets));
    warnings.push({
      code: "github_repo_claim_burst",
      severity: "warning",
      repos: live.repoBursts.length,
      distinctWallets,
      windowMinutes: config.repoWindowMinutes,
      message: `${live.repoBursts.length} GitHub ${live.repoBursts.length === 1 ? "repository has" : "repositories have"} ${distinctWallets} wallets claiming within ${config.repoWindowMinutes} minutes.`
    });
  }
  if (live.laneWarning) {
    warnings.push({
      code: "github_lane_claim_burst",
      severity: "warning",
      distinctClaimants: live.laneWindow.max,
      windowMinutes: config.laneWindowMinutes,
      ours: live.oursWallets.size,
      message: `${live.laneWindow.max} claimants claimed GitHub issues within ${config.laneWindowMinutes} minutes.`
    });
  }
  const sameAuthorWarning = sameAuthor.length > 0 ? {
    code: "same_author_multi_wallet",
    severity: "warning",
    persons: sameAuthor.length,
    distinctWallets: sameAuthor.reduce((sum, row) => sum + row.distinctWallets, 0),
    message: `${sameAuthor.length} GitHub ${sameAuthor.length === 1 ? "author is" : "authors are"} linked to more than one wallet.`
  } : null;

  return {
    warnings,
    admin: {
      repoWallets: config.repoWallets,
      repoWindowMinutes: config.repoWindowMinutes,
      laneWallets: config.laneWallets,
      laneWindowMinutes: config.laneWindowMinutes,
      lookbackMs: config.lookbackMs,
      repoBursts: history.repoBursts,
      repoAmbiguous: history.repoAmbiguous,
      lane: {
        warning: history.laneWarning,
        distinctClaimants: history.laneWindow.max,
        ours: history.oursWallets.size,
        ...burstTimes(history.laneWindow)
      },
      sameAuthor,
      sameAuthorWarning,
      attribution: {
        linked: linkedAuthors,
        ambiguous: ambiguousAuthors,
        ours: history.oursWallets.size
      }
    }
  };
}

export function readGithubIssueClaim(session) {
  const job = session?.jobSnapshot?.definition;
  if (job?.source?.type !== "github_issue") return null;
  const claimedAt = Date.parse(session.claimedAt ?? "");
  if (!Number.isFinite(claimedAt)) return null;
  const wallet = normalizeClaimWallet(session.wallet);
  if (!wallet) return null;
  return {
    sessionId: session.sessionId,
    wallet,
    claimedAt,
    repoId: positiveGithubRepoId(job.source.githubRepoId),
    job,
    session
  };
}

export async function resolveClaimRepoIds(claims, stateStore) {
  for (const claim of claims) {
    if (claim.repoId != null) continue;
    try {
      const identity = await resolveJobRepoIdentity(claim.job, stateStore);
      if (identity.status === "known") claim.repoId = identity.repoId;
    } catch {
      claim.repoId = null;
    }
  }
  return claims;
}

export function decideGithubPrSelfMerge({ lookup, wallet, links = new Map(), linksMeasured = true } = {}) {
  // A workflow bot merging with the repository's GITHUB_TOKEN is not a maintainer
  // decision. Count it and do not auto-settle. Log mode still settles.
  if (isGithubBot(lookup?.mergedBy)) {
    return { action: "ambiguous", reason: "bot_merger", blocksAutoSettle: true };
  }
  const authorId = isGithubBot(lookup?.author) ? null : positiveGithubUserId(lookup?.author?.id);
  const mergedById = positiveGithubUserId(lookup?.mergedBy?.id);
  const ownerId = positiveGithubUserId(lookup?.repoOwner?.id);
  const normalized = normalizeClaimWallet(wallet);
  const linked = normalized ? links.get(normalized) : undefined;
  const linkedPerson = typeof linked === "number" ? linked : null;

  if (authorId != null && mergedById != null && authorId === mergedById) {
    return { action: "hold", reason: GITHUB_PR_SELF_MERGE_REASON, basis: "pr_author" };
  }
  // An unread link scan must not become an allow. Enforce mode holds; log mode settles.
  if (linksMeasured === false) {
    return { action: "ambiguous", reason: "links_unmeasured", blocksAutoSettle: true };
  }
  const mergerIsOwner = ownerId != null && mergedById != null && mergedById === ownerId;
  if (mergerIsOwner && linkedPerson != null && linkedPerson === mergedById) {
    return { action: "hold", reason: GITHUB_PR_SELF_MERGE_REASON, basis: "owner_linked_wallet" };
  }
  if (mergedById == null) return { action: "ambiguous", reason: "merger_unknown" };
  if (authorId == null) return { action: "ambiguous", reason: "author_unknown" };
  return { action: "allow" };
}

export async function loadGithubPersonLinks(stateStore) {
  const pairs = [];
  for (let offset = 0; offset < MAX_SESSIONS; offset += PAGE_SIZE) {
    const page = await stateStore.listRecentSessions(PAGE_SIZE, offset);
    if (!Array.isArray(page)) throw new Error("GitHub person link source returned a non-array page");
    for (const session of page) {
      const job = session?.jobSnapshot?.definition;
      if ((job?.verifierConfig?.handler ?? job?.verifierMode) !== "github_pr") continue;
      const wallet = normalizeClaimWallet(session.wallet);
      if (!wallet) continue;
      const [verification, observation] = await Promise.all([
        stateStore.getVerificationResult?.(session.sessionId),
        stateStore.getMutationReceipt?.("github_pr_author", session.sessionId)
      ]);
      const personId = githubPersonFromLookups(verification?.githubLookup, observation?.githubLookup);
      if (personId != null) pairs.push({ wallet, personId, sessionId: session.sessionId });
    }
    if (page.length < PAGE_SIZE) return { measured: true, pairs, links: indexPersonLinks(pairs) };
    if (offset + PAGE_SIZE >= MAX_SESSIONS) throw new Error(`GitHub person link source exceeded the ${MAX_SESSIONS} record bound`);
  }
  return { measured: true, pairs, links: indexPersonLinks(pairs) };
}

function measuredCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function readGithubPrSelfMergeStatus(stateStore, env = process.env) {
  const config = loadGithubPrSelfMergeConfig(env);
  const unmeasured = { mode: config.mode, wouldHold: "not reported", held: "not reported", ambiguous: "not reported" };
  if (typeof stateStore?.getServiceState !== "function") return unmeasured;
  try {
    const stored = await stateStore.getServiceState(GITHUB_PR_SELF_MERGE_COUNTER_SCOPE);
    if (!stored) return { mode: config.mode, wouldHold: 0, held: 0, ambiguous: 0 };
    return {
      mode: config.mode,
      wouldHold: measuredCount(stored.wouldHold),
      held: measuredCount(stored.held),
      ambiguous: measuredCount(stored.ambiguous)
    };
  } catch {
    return unmeasured;
  }
}

export async function incrementGithubPrSelfMergeCounter(stateStore, field) {
  if (field !== "wouldHold" && field !== "held" && field !== "ambiguous") return null;
  if (typeof stateStore?.getServiceState !== "function" || typeof stateStore?.upsertServiceState !== "function") return null;
  const owner = randomUUID();
  const acquired = await acquireMaintainerRepoClaimLock(stateStore, GITHUB_PR_SELF_MERGE_COUNTER_SCOPE, owner);
  if (!acquired) return null;
  try {
    const stored = await stateStore.getServiceState(GITHUB_PR_SELF_MERGE_COUNTER_SCOPE);
    const next = {
      wouldHold: measuredCount(stored?.wouldHold),
      held: measuredCount(stored?.held),
      ambiguous: measuredCount(stored?.ambiguous)
    };
    next[field] += 1;
    await stateStore.upsertServiceState(GITHUB_PR_SELF_MERGE_COUNTER_SCOPE, next);
    return next;
  } finally {
    await stateStore.releaseClaimLock?.(GITHUB_PR_SELF_MERGE_COUNTER_SCOPE, owner);
  }
}
