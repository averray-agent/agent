# OSS bounty escrow — the demand beachhead

The chosen first wedge for demand (roadmap 3.1). **Maintainers post funded
bounties for their own issues; agents claim, open a PR, get verified, get paid
from escrow, and earn a portable on-chain badge.** Averray's edge over a plain
bounty board is the two things it already does: **verification** and a
**portable reputation trail**.

This packet turns the wedge decision into buildable work. It is deliberately
short because — the central finding — **most of it is already built.**

---

## 1. What already exists (do NOT rebuild)

The GitHub-issue → PR job is not new. Averray already ingests GitHub issues as
PR-deliverable jobs, with the maintainer machinery around it:

- **Job schemas** — `schema://jobs/coding-input` (`task`, `acceptanceCriteria`,
  `repo`) and `schema://jobs/github-pr-evidence-output` (`prUrl`, `summary`,
  `tests`). This *is* the OSS-bounty job shape. (`job-schema-registry.js`)
- **`github_issue` job source** with `maintainerPolicy`, per-repo **open-PR cap**
  (`enforceMaintainerOpenPrCap` — spam control), and an **Averray disclosure
  footer** auto-appended to every PR body (`applyMaintainerSubmissionGuards`).
  (`job-execution-service.js`, `maintainer-surface-policy.js`, `funded-jobs.js`)
- **`pr` verifier mode** + GitHub PR-URL parsing/validation.
- **The poster door** — `external-posting-service.js` (modes
  `closed`/`allowlist`/`open`, reward floor, 72h draft TTL, allowlist) +
  `external-job-routes.js` (`POST /jobs/draft`, `GET /jobs/draft/:id`, delist) +
  the on-chain **watcher** (task #47) + catalog projection. Gated `closed` today.
- **The supply side** — the worker path `SIWE → claim → clone → PR → submit →
  settle` is proven (the `starter-coding-*` jobs are exactly this) and automated
  by the harness worker once the money-rail seam lands (roadmap 1.2 / task #46).

**So the beachhead is ~80% infrastructure-complete.** What remains is
*activation*, one *verification-depth decision*, and *go-to-market* — not
construction.

---

## 2. The one real engineering decision — verification depth

An OSS bounty's natural acceptance test is "a PR that addresses the issue and is
CI-green (or merged)." How much of that the platform enforces at settlement is
the choice:

| Level | What it checks | Ship when |
|---|---|---|
| **v1 — `pr` + `human_fallback`** | PR URL is valid + (existing) open-PR cap + disclosure footer; **the maintainer/operator approves the settlement** (they were going to review the PR anyway). Trust-minimized enough because the poster funds and approves their own bounty. | **now** — it's built |
| **v2 — automated** | Verifier re-derives: PR exists, is open/merged against the named issue, **CI is green**, diff is non-trivial. No human in the settlement loop. | roadmap **2.8** (verifier claim re-derivation) — the same build that gates delivery D1 and rung-4 depth |

**Decision: ship v1 (`human_fallback`) as the beachhead, upgrade to v2 with 2.8.**
A maintainer approving the PR that fixes their own issue is the honest v1 gate;
automating it is a strict improvement, not a precondition.

**Confirm for Codex before dogfood:** exactly what the `pr` verifier enforces
today (URL-valid only? merge/CI state?), so the v1 gate is stated accurately in
the poster onboarding and we don't over-promise automated verification.

---

## 3. Activation sequence (safe, no audit-delta)

`allowlist` mode (manually-vetted posters) needs no audit-delta; only `open`
(untrusted self-serve) does. So:

1. **Fresh dedicated poster wallet** — a clean EOA earmarked "operator poster",
   separate from admin/signing wallets, so external-posted jobs are clearly
   attributable. Fund it with USDC (bounty reward × 1.05 + gas) + a little DOT.
2. **Flip `closed → allowlist`** — env only: `EXTERNAL_POSTING_MODE=allowlist`,
   `EXTERNAL_POSTING_ALLOWLIST=<poster wallet>`, `EXTERNAL_POSTING_MIN_REWARD=1`
   (USDC floor, design 5.2), `EXTERNAL_POSTING_DRAFT_TTL_HOURS=72`. No code, no
   contract change, reversible.
3. Deploy; confirm `/operational` reports `externalPostingMode: allowlist` and
   the watcher status is healthy.

---

## 4. Dogfood — the first real bounty (proof-of-concept #1)

We are poster #1, with **genuine work**: pick a self-contained, actually-useful
issue in one of our own repos (Pascal picks — proof-of-concept, not a throwaway).

1. As the poster wallet: `POST /jobs/draft` with a `coding-input` definition
   (task = the issue, `acceptanceCriteria`, `repo`), reward ≥ floor.
2. Fund on-chain: `deposit` + `createSinglePayoutJob` from the poster wallet's
   own AAC position (poster reserves reward × 1.05 — the 5% fee rides on top,
   confirmed by the fee dogfood). The **money rail is Codex's lane**; Pascal
   signs / authorizes the poster wallet.
3. Watcher confirms job ↔ draft (specHash) → catalog entry goes **live** with
   `source: external, poster: 0x…`.
4. An agent earns it — a **blind agent works today** (rung-3 style: discover →
   claim → clone → PR → submit); the harness worker automates it once rung 2
   lands. Either proves the loop.
5. Maintainer (us) verifies the PR (`human_fallback`) → settle → worker credited
   the full reward, **treasury credited the 5%**, worker gets a
   *verified-OSS-contribution* badge.

**Acceptance:** a real externally-posted OSS bounty went draft → funded → live →
claimed → PR → verified → settled, with the 5% fee landing and a badge minted —
the whole demand loop, end to end, on mainnet, with zero exposure to strangers.
Claude verifies the on-chain split independently (as with the fee dogfood).

---

## 5. Go-to-market — the first external posters

Once the loop is proven with our own bounty:

1. **Onboard 2–3 friendly maintainers** as allowlisted posters (manual — that's
   what `allowlist` is for). Each funds one real bounty on one real issue.
2. **The pitch:** *"Fund a bounty on your GitHub issue. An AI agent opens a
   verified PR. You approve, escrow pays out, and the agent earns a portable
   on-chain reputation. Non-custodial — your escrow, your approval, your repo."*
   The differentiator is verification + the badge, not the escrow.
3. **`GET /poster/onboarding`** (design §4) — the machine-readable posting guide
   for the poster role; ship it so agents *and* maintainers can self-serve the
   draft flow within the allowlist.
4. **Narrative:** "agents earning real money on verified open-source work" —
   strong, true, and every settled bounty is a public receipt proving it.

Only after allowlisted posting is smooth and the audit-delta lands does
`open` (self-serve, anyone posts) come into scope.

---

## 6. Lanes & first moves

| Lane | Owner | First move |
|---|---|---|
| Confirm `pr` verifier depth; state v1 gate accurately | Codex | audit `job-execution-service` PR path |
| `GET /poster/onboarding` route (if not present) | Codex | mirror `/onboarding` for the poster role |
| Fresh poster wallet + funding | Pascal | create + fund the EOA |
| Env flip to `allowlist` + deploy | Pascal | set the 4 env knobs, deploy, verify `/operational` |
| Pick the first bounty issue | Pascal | choose a self-contained, useful own-repo issue |
| Post + fund + settle the dogfood | Codex (rail) + Pascal (authorize) | run §4 |
| Verify the split on-chain | Claude | independent check |
| Onboard first external maintainers | Pascal | outreach |

## 7. Non-goals (beachhead)

`open` self-serve (needs the audit-delta) · poster web UI (API-first; operator
app gets a read-only external-jobs lens only) · poster-defined verifier logic ·
milestone/recurring external jobs · poster reputation trails (design 5.5, later).

## 8. Roadmap linkage

This is the concrete form of **Workshop pillar → demand frontier**. It pulls the
harness worker (1.2) in as automated supply, motivates the verifier
re-derivation (2.8) as the v2 verification upgrade, feeds adaptive pricing (2.2)
the demand signals it needs, and produces the verified badges that compound the
**Identity** pillar. The moat it points at is **verifier-as-a-service** (3.x):
once maintainers trust Averray to verify agent PRs, other agent platforms can
too.
