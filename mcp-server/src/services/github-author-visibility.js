import { formatBaseUnits } from "../core/platform-service-helpers.js";
import { approvedSettlement } from "../core/retained-workers.js";

const DAY = 86_400_000;
const openStatuses = new Set(["claimed", "submitted", "rejected", "disputed"]);

// Only server-read GitHub authors with a matching public claimant footer count.
// Historical records without this evidence stay unattributed; wallets are not authors.
export function boundGithubAuthor(lookup) {
  const login = lookup?.author?.login;
  return lookup?.status === "verified" && lookup.claimantBinding?.status === "matched"
    && (lookup.claimantBinding.walletMatches === true || lookup.claimantBinding.sessionMatches === true)
    && typeof login === "string" && /^[a-z\d](?:[a-z\d-]{0,38})$/iu.test(login)
    ? { login: login.toLowerCase() } : null;
}

export async function readGithubAuthors(stateStore, { now = new Date(), sessions } = {}) {
  if (!sessions) {
    sessions = [];
    for (let offset = 0; ; offset += 100) {
      const page = await stateStore.listRecentSessions(100, offset);
      sessions.push(...page);
      if (page.length < 100) break;
    }
  }
  const authors = new Map(), wallets = new Set(), seen = new Set();
  let openClaims = 0, unattributedClaims = 0, unattributedSessions = 0, githubSessions = 0;
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    const job = session.jobSnapshot?.definition;
    if ((job?.verifierConfig?.handler ?? job?.verifierMode) !== "github_pr") continue;
    githubSessions++;
    const wallet = String(session.wallet ?? "").toLowerCase();
    if (/^0x[\da-f]{40}$/u.test(wallet)) wallets.add(wallet);
    const open = openStatuses.has(session.status);
    if (open) openClaims++;
    const [verification, observation] = await Promise.all([
      stateStore.getVerificationResult?.(session.sessionId),
      stateStore.getMutationReceipt?.("github_pr_author", session.sessionId)
    ]);
    const lookup = verification?.githubLookup ?? observation?.githubLookup;
    const author = boundGithubAuthor(lookup);
    if (!author) {
      unattributedSessions++;
      if (open) unattributedClaims++;
      continue;
    }
    const key = author.login;
    if (!authors.has(key)) authors.set(key, { author: key, openClaims: 0, submitted: 0,
      awaitingHumanReview: 0, settled7d: 0, settled30d: 0, paidRaw: 0n,
      missingPayoutEvidence: 0, wallets: new Set() });
    const row = authors.get(key);
    if (wallets.has(wallet)) row.wallets.add(wallet);
    if (open) row.openClaims++;
    if (session.status === "submitted") {
      row.submitted++;
      // Same strict merged + approved predicate as the automatic poller.
      if (!(lookup.merged === true && observation?.previewOutcome === "approved")) row.awaitingHumanReview++;
    }
    const resolvedAt = Date.parse(session.resolvedAt ?? "");
    if (session.status === "resolved" && resolvedAt <= +now) {
      if (resolvedAt > +now - 7 * DAY) row.settled7d++;
      if (resolvedAt > +now - 30 * DAY) row.settled30d++;
    }
    if (session.status === "resolved") {
      const payout = session.payoutTx?.settlement;
      if (approvedSettlement(session) && payout?.assetSymbol === "USDC"
        && /^(0|[1-9]\d*)$/u.test(String(payout.workerAmountRaw ?? ""))) row.paidRaw += BigInt(payout.workerAmountRaw);
      else row.missingPayoutEvidence++;
    }
  }
  const rows = [...authors.values()].map(({ wallets, paidRaw, missingPayoutEvidence, ...row }) => ({
    ...row, distinctWallets: wallets.size,
    usdcPaid: { raw: missingPayoutEvidence ? null : String(paidRaw),
      amount: missingPayoutEvidence ? null : formatBaseUnits(paidRaw, 6), missingPayoutEvidence }
  })).sort((a, b) => b.openClaims - a.openClaims || a.author.localeCompare(b.author));
  return {
    asOf: new Date(now).toISOString(), source: "retained sessions; verified GitHub PR author + claimant footer",
    openClaimStatuses: [...openStatuses], paidWindow: "retained history; confirmed worker USDC payout only",
    githubSessions, distinctAuthors: rows.length, distinctWallets: wallets.size,
    openClaims, unattributedClaims, unattributedSessions, authors: rows,
    warnings: rows.filter((row) => row.openClaims > openClaims / 2).map((row) => ({
      code: "github_author_concentration", severity: "warning", openClaims: row.openClaims,
      totalOpenClaims: openClaims, distinctWallets: row.distinctWallets
    }))
  };
}

export function createGithubAuthorsProvider(stateStore, { now = () => new Date(), ttlMs = 60_000 } = {}) {
  let cached, expires = 0, pending;
  return async () => {
    if (cached && +now() < expires) return cached;
    if (!pending) pending = readGithubAuthors(stateStore, { now: now() }).then((value) => {
      cached = value; expires = +now() + ttlMs; return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
