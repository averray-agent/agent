import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MemoryStateStore } from "./state-store.js";
import { SelfIdentityRegistry } from "./self-identity-registry.js";
import { createHostedCanaryClaimantAttribution } from "./claimant-attribution.js";
import { githubReviewDisposition } from "./github-review-disposition.js";
import { readGithubAuthors } from "../services/github-author-visibility.js";
import { VerifierRegistry } from "../services/verifier-handlers.js";
import { VerifierService } from "../services/verifier-service.js";
import {
  decideGithubPrSelfMerge,
  loadGithubClaimGuardrailConfig,
  loadGithubPrSelfMergeConfig,
  readGithubPrSelfMergeStatus,
  verdictForStorage
} from "./github-claim-guardrails.js";

const wallet = (n) => "0x" + n.toString(16).padStart(40, "0");
const t0 = Date.parse("2026-10-14T03:00:00.000Z");
const config = loadGithubClaimGuardrailConfig({});
const registry = new SelfIdentityRegistry();
const PERSON = 424242;
const REPO = 1344638682;

function claimSession({
  id, n, repoId = REPO, at = t0, status = "claimed", sourceType = "github_issue",
  repoName = "example/project", canary = false, submitted = false
}) {
  return {
    sessionId: String(id),
    wallet: wallet(n),
    status,
    claimedAt: new Date(at).toISOString(),
    ...(submitted ? { submittedAt: new Date(at).toISOString(), submission: { author: "footer-handle" } } : {}),
    ...(canary ? { claimantAttribution: createHostedCanaryClaimantAttribution() } : {}),
    jobSnapshot: {
      definition: {
        verifierMode: "github_pr",
        source: sourceType ? {
          type: sourceType,
          repo: repoName,
          ...(repoId == null ? {} : { githubRepoId: repoId }),
          issueNumber: 1
        } : undefined
      }
    }
  };
}

function authorReceipt(id, personId, login = "api-author", extra = {}) {
  return {
    id: String(id),
    body: {
      githubLookup: {
        status: "verified",
        author: {
          ...(personId == null ? {} : { id: personId }),
          login,
          ...(extra.type ? { type: extra.type } : {})
        },
        claimantBinding: extra.binding ?? { status: "matched", walletMatches: true },
        merged: false
      }
    }
  };
}

async function read(sessions, { receipts = [], selfIdentityRegistry = registry, now = new Date(t0 + 86_400_000) } = {}) {
  const store = new MemoryStateStore();
  for (const session of sessions) await store.upsertSession(session);
  for (const receipt of receipts) {
    await store.upsertMutationReceipt("github_pr_author", receipt.id, receipt.body);
  }
  return readGithubAuthors(store, { now, selfIdentityRegistry, guardrails: config });
}

function codes(result) {
  return result.warnings.map((warning) => warning.code);
}

test("two wallets claiming one repository nine minutes apart warn, eleven minutes apart do not", async () => {
  const near = await read([
    claimSession({ id: "a", n: 1, at: t0 }),
    claimSession({ id: "b", n: 2, at: t0 + 9 * 60_000 })
  ]);
  const burst = near.warnings.find((warning) => warning.code === "github_repo_claim_burst");
  assert.ok(burst);
  assert.deepEqual(Object.keys(burst).sort(), ["code", "distinctWallets", "message", "repos", "severity", "windowMinutes"].sort());
  assert.match(burst.message, /2 wallets claiming within 10 minutes/);
  assert.equal(near.claimGuardrails.repoBursts[0].firstAt, new Date(t0).toISOString());
  assert.equal(near.claimGuardrails.repoBursts[0].lastAt, new Date(t0 + 9 * 60_000).toISOString());
  assert.equal(burst.distinctWallets, 2);
  assert.equal(burst.repos, 1);
  assert.equal(burst.windowMinutes, 10);
  assert.deepEqual(near.claimGuardrails.repoBursts[0].wallets, [wallet(1), wallet(2)]);
  assert.equal(near.claimGuardrails.repoBursts[0].repoId, REPO);
  assert.equal(JSON.stringify(near.warnings).includes(wallet(1)), false);
  assert.equal(JSON.stringify(near.warnings).includes(String(REPO)), false);

  const far = await read([
    claimSession({ id: "a", n: 1, at: t0 }),
    claimSession({ id: "b", n: 2, at: t0 + 11 * 60_000 })
  ]);
  assert.equal(codes(far).includes("github_repo_claim_burst"), false);

  const exact = await read([
    claimSession({ id: "a", n: 1, at: t0 }),
    claimSession({ id: "b", n: 2, at: t0 + 10 * 60_000 })
  ]);
  assert.equal(codes(exact).includes("github_repo_claim_burst"), true);
  const justOver = await read([
    claimSession({ id: "a", n: 1, at: t0 }),
    claimSession({ id: "b", n: 2, at: t0 + 10 * 60_000 + 1 })
  ]);
  assert.equal(codes(justOver).includes("github_repo_claim_burst"), false);
});

test("one wallet, two repositories, and a name without an id do not raise a repo burst", async () => {
  const sameWallet = await read([
    claimSession({ id: "a", n: 1, at: t0 }),
    claimSession({ id: "b", n: 1, at: t0 + 60_000 })
  ]);
  assert.equal(codes(sameWallet).includes("github_repo_claim_burst"), false);
  const split = await read([
    claimSession({ id: "a", n: 1, repoId: 11, at: t0 }),
    claimSession({ id: "b", n: 2, repoId: 22, at: t0 + 60_000 })
  ]);
  assert.equal(codes(split).includes("github_repo_claim_burst"), false);
  const unnamed = await read([
    claimSession({ id: "a", n: 1, repoId: null, at: t0, repoName: "renamed/project" }),
    claimSession({ id: "b", n: 2, repoId: null, at: t0 + 60_000, repoName: "renamed/project" })
  ]);
  assert.equal(codes(unnamed).includes("github_repo_claim_burst"), false);
  assert.equal(unnamed.claimGuardrails.repoAmbiguous, 2);
  const renamed = await read([
    claimSession({ id: "a", n: 1, repoId: REPO, repoName: "old/name", at: t0 }),
    claimSession({ id: "b", n: 2, repoId: REPO, repoName: "new/name", at: t0 + 60_000 })
  ]);
  assert.equal(renamed.claimGuardrails.repoBursts.length, 1);
  assert.equal(renamed.claimGuardrails.repoBursts[0].repoId, REPO);
});

test("our own wallets are excluded from the repository burst and the lane burst", async () => {
  const result = await read([
    claimSession({ id: "a", n: 1, at: t0, canary: true }),
    claimSession({ id: "b", n: 2, at: t0 + 60_000, canary: true })
  ]);
  assert.equal(codes(result).includes("github_repo_claim_burst"), false);
  assert.equal(codes(result).includes("github_lane_claim_burst"), false);
  assert.equal(result.claimGuardrails.repoBursts.length, 0);
});

test("lane burst warns for three external wallets inside five minutes and not outside it", async () => {
  const span = 4 * 60_000 + 59_000;
  const inside = await read([1, 2, 3].map((n) => claimSession({
    id: `in-${n}`, n, repoId: n, at: t0 + (n - 1) * Math.floor(span / 2)
  })));
  const lane = inside.warnings.find((warning) => warning.code === "github_lane_claim_burst");
  assert.ok(lane);
  assert.equal(lane.distinctClaimants, 3);
  assert.equal(lane.windowMinutes, 5);
  assert.deepEqual(Object.keys(lane).sort(), ["code", "distinctClaimants", "message", "ours", "severity", "windowMinutes"].sort());
  assert.match(lane.message, /3 claimants claimed GitHub issues within 5 minutes/);
  assert.equal(JSON.stringify(inside.warnings).includes(wallet(1)), false);

  const outside = await read([1, 2, 3].map((n) => claimSession({
    id: `out-${n}`, n, repoId: n, at: t0 + (n - 1) * Math.floor((5 * 60_000 + 1_000) / 2)
  })));
  assert.equal(codes(outside).includes("github_lane_claim_burst"), false);

  const exact = await read([1, 2, 3].map((n) => claimSession({
    id: `ex-${n}`, n, repoId: n, at: t0 + (n - 1) * (5 * 60_000 / 2)
  })));
  assert.equal(codes(exact).includes("github_lane_claim_burst"), true);
  const pair = await read([
    claimSession({ id: "a", n: 1, at: t0 }),
    claimSession({ id: "b", n: 2, at: t0 + 1_000 })
  ]);
  assert.equal(codes(pair).includes("github_lane_claim_burst"), false);
});

test("a linked pair counts as one claimant and an unknown author is never linked", async () => {
  const linked = await read([
    claimSession({ id: "a", n: 1, at: t0, status: "submitted", submitted: true }),
    claimSession({ id: "b", n: 2, at: t0 + 60_000, status: "submitted", submitted: true }),
    claimSession({ id: "c", n: 3, at: t0 + 120_000 })
  ], { receipts: [authorReceipt("a", PERSON, "old-login"), authorReceipt("b", PERSON, "new-login")] });
  assert.equal(codes(linked).includes("github_lane_claim_burst"), false);
  assert.equal(codes(linked).includes("same_author_multi_wallet"), false);
  const sameAuthor = linked.claimGuardrails.sameAuthorWarning;
  assert.equal(sameAuthor.code, "same_author_multi_wallet");
  assert.match(sameAuthor.message, /linked to more than one wallet/);
  assert.equal(JSON.stringify(linked.warnings).includes(String(PERSON)), false);
  assert.equal(JSON.stringify(linked.warnings).includes("old-login"), false);
  assert.equal(JSON.stringify(linked.warnings).includes("footer-handle"), false);
  assert.equal(linked.claimGuardrails.sameAuthor[0].personId, PERSON);
  assert.deepEqual(linked.claimGuardrails.sameAuthor[0].wallets, [wallet(1), wallet(2)]);

  const guessed = await read([
    claimSession({ id: "a", n: 1, at: t0, status: "submitted", submitted: true }),
    claimSession({ id: "b", n: 2, at: t0 + 60_000, status: "submitted", submitted: true }),
    claimSession({ id: "c", n: 3, at: t0 + 120_000 })
  ], { receipts: [authorReceipt("a", null, "shared-login"), authorReceipt("b", null, "shared-login")] });
  assert.equal(codes(guessed).includes("same_author_multi_wallet"), false);
  assert.equal(codes(guessed).includes("github_lane_claim_burst"), true);
  assert.ok(guessed.claimGuardrails.attribution.ambiguous >= 2);
});

test("ours wallets and canary claims are ignored by the lane burst", async () => {
  const ours = new SelfIdentityRegistry({
    operatorWallets: [wallet(1)],
    acceptanceWallets: [wallet(2)],
    canaryWallets: [wallet(3)]
  });
  const onlyOurs = await read([1, 2, 3].map((n) => claimSession({
    id: `ours-${n}`, n, at: t0 + n * 1_000
  })), { selfIdentityRegistry: ours });
  assert.equal(codes(onlyOurs).includes("github_lane_claim_burst"), false);
  assert.equal(onlyOurs.claimGuardrails.lane.ours, 3);

  const mixed = await read([
    claimSession({ id: "ext-1", n: 4, at: t0 }),
    claimSession({ id: "ext-2", n: 5, at: t0 + 1_000 }),
    claimSession({ id: "ours", n: 1, at: t0 + 2_000 })
  ], { selfIdentityRegistry: ours });
  assert.equal(codes(mixed).includes("github_lane_claim_burst"), false);

  const canaries = await read([1, 2, 3].map((n) => claimSession({
    id: `canary-${n}`, n, at: t0 + n * 1_000, canary: true
  })));
  assert.equal(codes(canaries).includes("github_lane_claim_burst"), false);
  assert.equal(canaries.claimGuardrails.lane.ours, 3);
});

test("an old burst stays on the admin history and does not fire a live warning", async () => {
  const now = new Date(t0 + 48 * 3_600_000);
  const old = await read([
    claimSession({ id: "a", n: 1, at: t0 }),
    claimSession({ id: "b", n: 2, at: t0 + 9 * 60_000 })
  ], { now });
  assert.equal(codes(old).includes("github_repo_claim_burst"), false);
  assert.equal(old.claimGuardrails.repoBursts.length, 1);
  assert.equal(old.claimGuardrails.repoBursts[0].firstAt, new Date(t0).toISOString());
  assert.equal(old.claimGuardrails.repoBursts[0].lastAt, new Date(t0 + 9 * 60_000).toISOString());
  const recent = await read([
    claimSession({ id: "a", n: 1, at: +now - 60 * 60_000 }),
    claimSession({ id: "b", n: 2, at: +now - 50 * 60_000 })
  ], { now });
  assert.equal(codes(recent).includes("github_repo_claim_burst"), true);
});

test("repository id resolution runs only for claims inside the lookback", async () => {
  const now = new Date(t0 + 48 * 3_600_000);
  const store = new MemoryStateStore();
  let pins = 0;
  store.getGithubRepositoryPin = async () => { pins += 1; return null; };
  await store.upsertSession(claimSession({ id: "old", n: 1, repoId: null, at: t0 }));
  await store.upsertSession(claimSession({ id: "recent", n: 2, repoId: null, at: +now - 60_000 }));
  await readGithubAuthors(store, { now, selfIdentityRegistry: registry, guardrails: config });
  assert.equal(pins, 1);
  const clamped = loadGithubClaimGuardrailConfig({
    GITHUB_CLAIM_BURST_LOOKBACK_HOURS: "1",
    GITHUB_REPO_CLAIM_BURST_MIN: "180"
  });
  assert.equal(clamped.lookbackMs, 180 * 60_000);
});

test("a link requires claimant binding, a conflicting person stays ambiguous, and one wallet is not a multi-wallet author", async () => {
  const unbound = await read([
    claimSession({ id: "a", n: 1, at: t0, status: "submitted", submitted: true }),
    claimSession({ id: "b", n: 2, at: t0 + 60_000, status: "submitted", submitted: true }),
    claimSession({ id: "c", n: 3, at: t0 + 120_000 })
  ], { receipts: [
    authorReceipt("a", PERSON, "one", { binding: { status: "missing", walletMatches: true } }),
    authorReceipt("b", PERSON, "one", { binding: { status: "missing", walletMatches: true } })
  ] });
  assert.equal(unbound.claimGuardrails.sameAuthor.length, 0);
  assert.equal(codes(unbound).includes("github_lane_claim_burst"), true);

  const conflicted = await read([
    claimSession({ id: "a1", n: 1, at: t0, status: "submitted", submitted: true }),
    claimSession({ id: "a2", n: 1, at: t0 + 30_000, status: "submitted", submitted: true }),
    claimSession({ id: "b", n: 2, at: t0 + 60_000, status: "submitted", submitted: true }),
    claimSession({ id: "c", n: 3, at: t0 + 90_000, status: "submitted", submitted: true })
  ], { receipts: [
    authorReceipt("a1", 10, "first"),
    authorReceipt("a2", 20, "second"),
    authorReceipt("b", 10, "first"),
    authorReceipt("c", 20, "second")
  ] });
  assert.equal(codes(conflicted).includes("github_lane_claim_burst"), true);
  assert.equal(conflicted.claimGuardrails.sameAuthor.some((row) => row.personId === 10 && row.wallets.includes(wallet(1))), false);

  const single = await read([
    claimSession({ id: "only", n: 4, at: t0, status: "submitted", submitted: true })
  ], { receipts: [authorReceipt("only", PERSON, "solo")] });
  assert.equal(single.claimGuardrails.sameAuthor.length, 0);
  assert.equal(single.claimGuardrails.sameAuthorWarning, null);
});

test("bot authors do not link wallets", async () => {
  const result = await read([
    claimSession({ id: "a", n: 1, at: t0, status: "submitted", submitted: true }),
    claimSession({ id: "b", n: 2, at: t0 + 60_000, status: "submitted", submitted: true }),
    claimSession({ id: "c", n: 3, at: t0 + 120_000 })
  ], { receipts: [
    authorReceipt("a", 999, "Copilot", { type: "Bot" }),
    authorReceipt("b", 999, "Copilot", { type: "Bot" })
  ] });
  assert.equal(result.claimGuardrails.sameAuthor.length, 0);
  assert.equal(result.claimGuardrails.attribution.linked, 0);
  assert.equal(codes(result).includes("github_lane_claim_burst"), true);
});

test("non-github jobs do not feed either burst", async () => {
  const result = await read([1, 2, 3].map((n) => claimSession({
    id: `other-${n}`, n, at: t0 + n * 1_000, sourceType: "wikipedia_article"
  })));
  assert.deepEqual(result.warnings.filter((warning) => warning.code.startsWith("github_")), []);
});

test("public health copies warnings only, and stored verdicts drop GitHub user ids", async () => {
  const healthSource = readFileSync(new URL("../protocols/http/operational-routes.js", import.meta.url), "utf8");
  assert.match(healthSource, /githubAuthors\?\.warnings/);
  assert.equal(healthSource.includes("claimGuardrails"), false);
  const lookup = {
    status: "verified",
    author: { id: PERSON, login: "api-author" },
    mergedBy: { id: 7, login: "merger" },
    repoOwner: { id: 7, login: "merger" }
  };
  const stored = verdictForStorage({ outcome: "approved", githubLookup: lookup });
  assert.deepEqual(stored.githubLookup.author, { login: "api-author" });
  assert.equal(stored.githubLookup.mergedBy, undefined);
  assert.equal(stored.githubLookup.repoOwner, undefined);
  assert.equal(lookup.author.id, PERSON);
  const store = new MemoryStateStore();
  await store.upsertVerificationResult("session", { githubLookup: lookup });
  const service = new VerifierService({}, store, undefined, new VerifierRegistry());
  const result = await service.getResult("session");
  assert.equal(result.githubLookup.author.id, undefined);
  assert.equal(result.githubLookup.mergedBy, undefined);
  assert.equal(JSON.stringify(result).includes(String(PERSON)), false);
});

test("the verifier keeps the API user id and ignores a footer handle", async () => {
  const registry = new VerifierRegistry({
    githubToken: "github_pat_test",
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
      if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (path.endsWith("/reviews")) return Response.json([]);
      if (path.endsWith("/pulls/7")) {
        return Response.json({
          html_url: "https://github.com/example/project/pull/7",
          title: "Fix #7",
          body: "Closes #7\nPrepared by footer-handle\n",
          state: "closed",
          merged: true,
          merged_at: "2026-10-14T03:10:00Z",
          user: { id: PERSON, login: "api-author" },
          merged_by: { id: 77, login: "repo-owner" },
          head: { sha: "abc" },
          base: { repo: { id: 100, full_name: "example/project", owner: { id: 77, login: "repo-owner" } } }
        });
      }
      return new Response("{}", { status: 404 });
    }
  });
  const verdict = await registry.evaluate({
    id: "job-1",
    title: "Fix",
    rewardAmount: 1,
    rewardAsset: "USDC",
    category: "engineering",
    verifierMode: "github_pr",
    lifecycle: { createdAt: "2026-10-01T00:00:00.000Z", status: "open" },
    source: { type: "github_issue", repo: "example/project", issueNumber: 7, githubRepoId: 100 },
    verifierConfig: {
      handler: "github_pr", version: 1, minimumScore: 80,
      requireIssueReference: false, requireTestEvidence: false, requireClaimantBinding: false
    }
  }, {
    prUrl: "https://github.com/example/project/pull/7",
    summary: "Closes #7",
    tests: "npm test",
    author: "footer-handle"
  });
  assert.equal(verdict.githubLookup.author.id, PERSON);
  assert.equal(verdict.githubLookup.author.login, "api-author");
  assert.equal(verdict.githubLookup.mergedBy.id, 77);
  assert.equal(verdict.githubLookup.repoOwner.id, 77);
  assert.equal(JSON.stringify(verdict.githubLookup.author).includes("footer-handle"), false);
});

test("self-merge holds only on API ids, and log mode is the default", () => {
  assert.equal(loadGithubPrSelfMergeConfig({}).mode, "log");
  assert.equal(loadGithubPrSelfMergeConfig({ GITHUB_PR_SELF_MERGE_MODE: "sometimes" }).mode, "log");
  assert.equal(loadGithubPrSelfMergeConfig({ GITHUB_PR_SELF_MERGE_MODE: "enforce" }).mode, "enforce");
  const hold = decideGithubPrSelfMerge({
    lookup: { author: { id: 5, login: "now" }, mergedBy: { id: 5, login: "then" }, repoOwner: { id: 9 } },
    wallet: wallet(1)
  });
  assert.equal(hold.action, "hold");
  assert.equal(hold.reason, "github_pr_self_merge_review");
  assert.equal(decideGithubPrSelfMerge({
    lookup: { author: { id: 1 }, mergedBy: { id: 2 }, repoOwner: { id: 3 } },
    wallet: wallet(1)
  }).action, "allow");
  assert.equal(decideGithubPrSelfMerge({
    lookup: { author: { login: "same-person" }, mergedBy: { login: "same-person" } },
    wallet: wallet(1)
  }).action, "ambiguous");
  const links = new Map([[wallet(1), 50]]);
  assert.equal(decideGithubPrSelfMerge({
    lookup: { author: { id: 99 }, mergedBy: { id: 50 }, repoOwner: { id: 50 } },
    wallet: wallet(1),
    links
  }).basis, "owner_linked_wallet");
  assert.equal(decideGithubPrSelfMerge({
    lookup: { author: { id: 99 }, mergedBy: { id: 50 }, repoOwner: { id: 50 } },
    wallet: wallet(1),
    links: new Map()
  }).action, "allow");
  assert.equal(decideGithubPrSelfMerge({
    lookup: { author: { id: 1 }, mergedBy: { id: 2, type: "Bot" }, repoOwner: { id: 1 } },
    wallet: wallet(1)
  }).blocksAutoSettle, true);
  assert.equal(decideGithubPrSelfMerge({
    lookup: { author: { id: 1, type: "Bot" }, mergedBy: { id: 2 }, repoOwner: { id: 3 } },
    wallet: wallet(1),
    linksMeasured: true
  }).action, "ambiguous");
  assert.equal(decideGithubPrSelfMerge({
    lookup: { author: { id: 1 }, mergedBy: { id: 2 }, repoOwner: { id: 3 } },
    wallet: wallet(1),
    linksMeasured: false
  }).blocksAutoSettle, true);
  assert.equal(githubReviewDisposition({
    merged: true, previewOutcome: "approved", holdReason: "github_pr_self_merge_review"
  }), "human_review");
  assert.equal(githubReviewDisposition({
    merged: true, previewOutcome: "approved", upstreamState: "closed"
  }), "operator_review");
});

test("self-merge counters start at zero and an unreadable store is not reported as zero", async () => {
  const store = new MemoryStateStore();
  assert.deepEqual(await readGithubPrSelfMergeStatus(store, {}), {
    mode: "log", wouldHold: 0, held: 0, ambiguous: 0
  });
  const broken = { getServiceState: async () => { throw new Error("down"); } };
  assert.equal((await readGithubPrSelfMergeStatus(broken, {})).wouldHold, "not reported");
});
