# Outcome-Assurance Pivot — Build Plan

- **Ratified:** 2026-08-17 evening (Pascal), from an external strategy read
  cross-checked against live platform state before adoption.
- **Roles:** Claude architects, gates, and writes packets · Codex implements ·
  Pascal operates, signs, prices, and ratifies decision points.
- **Roadmap entry:** `docs/PROJECT_ROADMAP.md` → "Product Positioning — Outcome
  Assurance" (PR #1151). This plan owns sequencing; each build ships as its own
  narrow packet + PR.
- **Positioning:** Averray is the outcome-assurance layer for autonomous work —
  it verifies the result, releases the money, and leaves a portable receipt.
  Four surfaces: **Verify → Proof-to-Pay → Fulfill → Trust Graph**.

---

## 1. What does not move

The pivot is packaging and product surface, not a rebuild. Zero new contracts.
These commitments continue exactly as scheduled:

| Commitment | When |
| --- | --- |
| First L1 credit draw (originate → repay → release) | Tue 2026-08-18 ≥15:59Z |
| Board deploy (verdict band + truth fixes, #813/#814/#815) | Pascal's next VPS session |
| `ARRIVAL_ACCEPTANCE_WALLETS` env + reward-bank top-up | Tuesday session |
| §8 multisig batch (v1+v2 revocations, twin roles, `perAccountBorrowCap→0`) | Next ceremony window |
| CreditBook L2 deploy ceremony (merged, unceremonied) | When gated; D-03 manifest at ceremony |
| Worker canary, curated lanes, external audit engagement | Unchanged — the lanes are the receipt factory and the liveness proof |

Frozen items were already gated before the pivot (L3 flag-off, Rail-2
memo-gated, no directory ambition, Hermes stays ops-truth). The freeze adds no
new constraint; it just names the priority.

## 2. Component audit — why "mostly packaging" is true

Checked against live state 2026-08-17:

| Component | State |
| --- | --- |
| Escrow + settlement (v3 fee era) | PROVEN — first revenue tx `0x4f0c2a63…`, cancel both directions |
| Deterministic verification + offline git-bundle source binding | LIVE (VerificationContract v1.1, strict fsck, tamper drill) |
| Intent binding (specHash F1–F4) | LIVE |
| x402 payment ramp | PROVEN (real Base USDC payment) |
| Self-signed withdrawals / unsigned-tx templates | PROVEN |
| EIP-712 consent rail (`sendToAgentFor`) | PROVEN (canary recovery, 2026-08-17) |
| Disputes (7-day window, arbitrator, split verdicts) | LIVE |
| External identity (SIWE, MCP front door) | LIVE |
| Self-traffic exclusion (SelfIdentityRegistry + poster classification) | MERGED (#1147; deploy pending) |
| **Canonical work receipt** | **MISSING — the one absent atom** |
| Designated-claimant gate (claims gated by named identity, not just ladder) | MISSING (small, backend) |
| Verifier-profile registry (named, versioned) | MISSING (small; sits on the frozen `AUTO_DECIDABLE_MODES`) |
| `INCONCLUSIVE` verdict state | MISSING (backend enum + routing; no contract change) |

## 3. Phases

### Phase R — `PACKET_WORK_RECEIPT` (keystone; first build)

**Goal:** one canonical receipt object emitted by every settlement, with a
public page and stable JSON.

Scope:
- Receipt v1 schema, four sections mapped to existing evidence:
  - **Intent:** specHash, success policy (verification mode + profile version),
    value at risk, deadline, poster identity, ApprovalGrant hash once #238 lands.
  - **Execution:** provider identity (wallet, optional ERC-8004 ref), artifact
    hash (bundle/submission), source-binding results, verifier-environment id.
  - **Verification:** verifier identity, profile + version, verdict
    (`PASS`/`FAIL`/`INCONCLUSIVE`/`PLATFORM_FAULT`), evidence refs,
    `workerConsequence` classification, dispute status.
  - **Settlement:** outcome (released/refunded/split/disputed), gross, worker
    net, poster fee, retention, settlement tx, destination.
- Receipt id = hash of canonical JSON; `GET /receipts/:id` (JSON) + public page
  (transparency-page family, receipt-backed figures only).
- Emitted forward from ship date; backfill best-effort where evidence is
  complete (canary + acceptance runs qualify).
- Board link-outs from runs/receipts pages. Referencable from MCP responses,
  ERC-8004 validation entries (#236), PRs, transparency page.

Out of scope: aggregation, scoring, any claim beyond the recorded run.
**Owner:** Claude spec (1 day) → Codex build (2–4 days). **Exit:** a real
settled job renders as a receipt page + stable JSON, with seam tests.

### Phase V — Averray Verify shelf (absorbs #237)

**Goal:** a stranger can pay for a verification run and get a receipt without
talking to us.

Scope:
- Three profiles, named and versioned:
  1. `git-patch-tests-v1` — packages the live deterministic repo-test
     verification standalone (input: repo + commit + bundle/patch + test
     command → verdict + receipt). Mostly exists.
  2. `mcp-failure-semantics-v1` — from the MCP failure-lab kit (endpoint +
     bounded failure profile). Partial build.
  3. `structured-output-evidence-v1` — schema + cited-source support. Needs
     build.
- Profile registry: versioned configs **on top of** the frozen
  `AUTO_DECIDABLE_MODES` — the freeze law is what makes a profile pinnable and
  a receipt reproducible.
- `INCONCLUSIVE`: backend verdict only; settlement still fires on `PASS` alone;
  `INCONCLUSIVE` holds and routes to human/dispute. No contract change.
- Intake: x402 402-flow — payment is the auth, no SIWE for verify-only, one
  curl to run. Target median setup < 15 minutes.
- Naming: "MCP Outcome Receipt" / "verification profile" language only — never
  "certification", never a blanket "safe" badge.

**Decision point (Pascal):** pricing menu, ratified after per-profile cost
measurement (anchor: ~$0.059 measured brokered lifecycle gas; verify-only runs
carry no settlement, so margin at low single-digit USDC prices is real).
**Exit / truth-boundary gate:** no public "Averray Verify" page until the exit
sentence above is literally true.

### Phase P — `PACKET_PROOF_TO_PAY` (bring-your-own-counterparty)

**Goal:** one external buyer/provider pair completes agreement → verification →
settlement with Averray supplying neither side.

Scope:
- Agreement = existing job machinery + designated provider identity + pinned
  profile + deadline + dispute window. New: **designated-claimant gate** in the
  backend claim door (allowlist mode alongside ladder eligibility).
- Fees: existing poster fee `max(5%, 0.05)` is the Proof-to-Pay fee; retention
  only if we broker gas; marketplace sourcing fee only when Fulfill supplies
  the provider.
- No new custody class — external funds already flow through escrow; the buyer
  now names the recipient. Scaling is Swiss-memo-gated.
- Disputes: existing 7-day window + arbitrator; `PLATFORM_FAULT` preserves
  `workerConsequence: none`.

**Decision points (Pascal):** pilot caps (suggestion: ≤5 concurrent agreements,
≤25 USDC each — mirrors L2 cap scale) and provider-bond default (suggestion: no
bond when the buyer designates the provider — the buyer chose them; optional
bond-request field for buyers who want it).
**Exit:** the first BYO pair settles on a receipt.

### Phase D — demand engine (explicitly gated)

- **GitHub Issue-to-Bounty** — App/Action drafts a fundable job from a failing
  CI check, reproducible bug, or `averray`-labelled issue (repo commit, bundle,
  failing test, scope, success command, budget cap, deadline); maintainer
  clicks fund-and-post. The most build-heavy item in the plan (App infra,
  webhooks, repo-token scoping) — right product, second slot. **Gate: ≥1
  external paid Verify run.**
- **MCP continuous monitoring / pre-release CI mode** for the outcome profiles.
  **Gate: ≥3 paid shelf runs.**
- **ERC-8004 validation writes** of work receipts — rides #236 registration +
  the observed-consumption instrumentation already ratified.

### Deferred (explicit gates, not vibes)

| Item | Gate |
| --- | --- |
| Receipt-based routing API (task-specific, evidence-specific) | ≥50 external receipts |
| Validator / verification-recipe marketplace (bonded recipes, quorums) | 3 Averray-operated profiles with repeat paying customers |
| Receipt warranty (fee refund / rerun / credit — never job-value indemnity) | Measured invalid-receipt rate over a real corpus + legal review |

## 4. The 30-day experiment (due 2026-09-11, unchanged)

Supersedes the "20 qualified poster conversations" back half of
`ECONOMIC_STRATEGY.md` §7 (note added there).

| Criterion | Unlocked by |
| --- | --- |
| 10 outsiders submit a real artifact/endpoint | Phase V intake |
| 5 complete a paid verification run | Phase V + pricing |
| 3 repeat without manual persuasion | Profile quality + receipt value |
| ≥1 Proof-to-Pay with own provider | Phase P |
| Median setup < 15 minutes | x402 intake design |
| External runs cleanly separated from ours | SelfIdentityRegistry (merged; deploy Tue) |
| ≥1 customer embeds/shares the receipt | Phase R public page |

Kill-or-narrow: <3/20 prospects submit; only the free badge is valued; outcomes
can't be stated as bounded policies; every integration is bespoke; receipts go
unused after the scan. **The signal is repeat payment** — not compliments,
registrations, deposits, or badge claims.

North-star metric: **external verified outcomes settled per week**, excluding
operator/canary/acceptance/self-paid/synthetic traffic — a board query once
Tuesday's env lands.

## 5. Outreach re-segmentation (19 of 20 remaining)

- 8 × MCP / agent-tool operators (lead product: `mcp-failure-semantics-v1`).
- 6 × devtool / OSS maintainers with sponsorship budgets (lead:
  `git-patch-tests-v1`, later issue-to-bounty).
- 6 × agent-platform builders who already delegate work (lead: Proof-to-Pay).

The ask: *"What result are you currently paying an agent, API, or contractor to
produce where payment is disconnected from objective proof that the result
worked?"* Tracker stays `MAINTAINER_OUTREACH_KIT.md` §8 (add a segment column);
conversation #1 (reticle, email) already in flight and counts toward the
maintainer segment.

## 5b. Deliverable shape — PATCH, not PR · RATIFIED 2026-08-18 (Pascal)

The agent's deliverable is a **verified patch plus a receipt**, never a pull
request opened on a repository we do not own. Reticle's repo is never touched;
the maintainer never hears about it unless someone chooses to tell them.

Why, in the order the arguments actually carry weight:

1. **The buyer already exists.** The poster funds the job because they want the
   fix — often they are a dependant, not the maintainer. "Who buys a patch
   nobody applies?" dissolves once you notice someone already paid for it.
   Whether it ever reaches upstream is the poster's business.
2. **Asymmetric failure.** A wrong patch costs the buyer a fee. A wrong PR costs
   a stranger their afternoon and costs us standing we cannot buy back —
   maintainers talk. `inconclusive` exists because verification is good and not
   perfect; errors should land on people who opted in.
3. **Infrastructure, not contributor.** PRs put us in a merge-rate contest
   scored by other people's review queues. Verified patches make us the thing
   that proves work is correct and leave the merge decision with whoever wants
   it. "Sell the rail, not the board", applied to the deliverable.
4. **The hard constraint: PR-shaped requires write credentials on third-party
   repos.** That is T6 credential brokering — recorded as "a decision about what
   kind of company we are, not only a feature". It would widen our blast radius
   from *funds we hold* to *every repo our agents can push to*. A delivery
   format must not smuggle that in as a side effect.

**Costs nothing to adopt:** the Witness verifies a patch against a contract and
never looks at a pull request, so `git-patch-tests-v1` already implements this.

**PR-opening** is not a roadmap goal. It happens only on a specific maintainer's
written request, on their repo, scoped — and is decided on its own terms then.

**Consent-first "come and collect":** publish receipts and let maintainers find
them, or raise it inside a conversation already underway. An unsolicited "here
are eleven patches for your open issues" is still unsolicited outreach, PR or
not.

## 6. Cross-cutting laws

- **Swiss memo — event-triggered (Pascal, 2026-08-17):** blocks nothing while
  aggregate third-party funds held by the platform (open escrow + pool
  deposits + externally-owed AAC balances; the board's solvency-floor inputs
  already measure this) stay below five figures USD. Trigger: trending toward
  ≥10,000 (start counsel near 5k for lead time) or an enterprise prospect
  asking for posture in writing. Until then: scoping note (Claude) + named
  counsel contact (Pascal). Caps stay law; scope is Proof-to-Pay-first when
  commissioned; "memo unstarted" is not a failed Sep-11 gate absent the
  trigger.
- **Truth-boundary marketing gate:** no product page before a stranger can buy.
- **Vocabulary law:** outcome verification / work receipt / proof-to-pay; never
  "certification"; never "AI agent verification" (ERC-8126's term).
- **Revenue-surface boundary:** platform revenue reporting stays on Hermes.
- **Standards posture:** adopt MCP/A2A/AP2/x402/ERC-8004, bridge as evaluator
  and validation-writer, own receipt semantics and verifier profiles. Draft
  ERCs get thin adapters, never the internal data model.

## 7. Decision points queued for Pascal

1. Verify pricing menu — arrives with Phase V cost measurement.
2. Proof-to-Pay pilot caps + provider-bond default — arrives with Phase P
   packet.
3. Swiss memo — name the counsel contact only; the engagement itself is
   event-triggered (≥5-figure held funds). Scoping note arrives from Claude
   regardless, so the fuse is short when lit.
4. Receipt page placement (`averray.com/receipts/:id` vs subdomain) — at Phase
   R gate; recommendation will accompany the spec.

## 8. Calendar sketch

| Week | Load-bearing items |
| --- | --- |
| 2026-08-18 | Phase R spec + Codex build starts · L1 draw (Tue) · board deploy + arrivals env · outreach re-segmentation · memo scoping note (no engagement — event-triggered) |
| 2026-08-25 | Phase V profiles 1–2 + pricing proposal · receipt page live · outreach cadence ~1/day |
| 2026-09-01 | Profile 3 · Phase P build + pilot recruit from outreach |
| 2026-09-11 | Experiment scoreboard vs criteria — decide scale / narrow / kill per lane |
