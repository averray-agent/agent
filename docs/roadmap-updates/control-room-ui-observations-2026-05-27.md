> Triaged 2026-05-28 by Codex. Landed in `PROJECT_ROADMAP.md` under "Control-Room UI Review Intake (2026-05-27)": A1/A3/A7 as blocked live-verification reconciliation rows; A2/A4/A5/A6 as open control-room clarity rows; C1-C7 as open feature/verification rows; C8 as deferred v2 search. B1-B5 remain here as non-committed design-backlog opinions. No `AVERRAY_WORKING_SPEC.md` clarification was added because authenticated live verification was unavailable, and no `AUDIT_REMEDIATION.md` status changed.

# Control room UI observations — 2026-05-27

**Type:** Planning update — design observations and proposals for review
**Source:** End-to-end visual review of nine control-room pages (Overview, Runs, Receipts, Agents, Treasury, Sessions, Policies, Capabilities, Disputes, Audit log)
**Reviewer required before binding into roadmap:** yes — items overlap with reputation-deepening, audit-remediation, and capability-grant lanes
**Status:** Open for review

---

## Honest framing first

The control room is well-designed. Information density is high, empty states are honest, language is direct, visual hierarchy is clear, the "evidence first, vibes never" pitch shows up consistently in copy and surface behavior. This fragment is not a redesign proposal.

What follows is a structured set of observations from end-to-end review, organized into three buckets:
- **A-series:** real gaps worth working on (concrete observations, recommended actions)
- **B-series:** opinionated design suggestions (explicitly labeled as opinions, take or leave)
- **C-series:** features to consider adding, with v1.0.0-rc1 / v1.x / v2 priority tagging

For each item: what was observed, what current authority documents say (where applicable), recommended action, priority/lane. No status marked Done or Proofed — those come after verification per the roadmap's status rules.

---

## A-series — Real gaps worth working on

### A1. Asset denomination drift on Runs page

**Observed:** Jobs in the run queue are denominated in DOT (`1.00 DOT`, `4.00 DOT`, `5.00 DOT`, `25 DOT`).

**Authority says:** `PROJECT_ROADMAP.md` Phase 0/1 marks *"USDC-decimals plumbing repaired across rendering, accounting, and discovery copy"* as Proofed.

**Reconciliation needed:**
- Are screenshots from a state predating the USDC plumbing fix?
- Is run-job denomination intentionally DOT-side while escrow/settlement is USDC?
- Is this actual drift that contradicts the Proofed claim?

**Recommended action:** verify live UI state. If drift, file as roadmap reopen on the Proofed item. If intentional split, document the rationale in the working spec and surface it in-UI (tooltip on price field explaining why claim cost is in DOT while settlement is in USDC).

**Priority:** v1.0.0-rc1 launch-blocking if drift; otherwise documentation work.

---

### A2. Receipts page "0 indexed" vs Agents page "3 verified badges"

**Observed:** Receipts top metric shows *"0 indexed · from /badges"*. Agents page top metric shows *"3 verified badges · from indexed agent profiles"*. From a counterparty perspective this reads as contradiction.

**Root cause (per Receipts page receipt-shapes panel):** Badges and receipts are distinct surfaces. `badge-receipt` is *"identity or reputation award, fetchable at /badges/:sessionId"*. `run-receipt` / `settle-receipt` / `policy-receipt` are different shapes. So 3 badges + 0 run/settle/policy receipts is technically consistent.

**Gap:** A discovery agent or external counterparty reading "0 indexed" on the Receipts page won't read the four-card receipt-shapes explainer at the bottom carefully enough to understand the difference. The UI reads as inconsistent at first glance even though it's structurally correct.

**Recommended action:** one of two options —
- **Option A (preferred):** Relabel the Receipts top card to break down receipt types: `0 run · 3 badge · 0 settle · 0 policy`. Makes badges-vs-receipts categorization visually self-evident.
- **Option B:** Rename "Receipts" page to "Receipts & Badges" or "Evidence ledger" and surface all receipt types in the top metric line.

**Priority:** v1.0.0-rc1 — this is on the trust-pitch surface that external posters and discovery agents will read first.

---

### A3. Capabilities page sign-in state confusion

**Observed:** Capabilities page displays *"Sign in with an admin wallet to view and manage capability grants"* even though sidebar shows `0xFd2E…6519 · admin · verifier` as signed in.

**Authority says:** `PROJECT_ROADMAP.md` Phase 0 marks *"Capability matrix lane stabilised (capability-grants stack 200s, smoke suite proofed, regression workflow live, control-room capability surface restored)"* as Proofed.

**Reconciliation needed:**
- Is there a higher-privilege admin check this wallet doesn't pass (correct behavior, but confusing UI labeling)?
- Is there a sign-in state bug where the page doesn't recognize the active wallet?

**Recommended action:** verify behavior. If a stricter admin-check exists, the UI should say *"This wallet has admin role but capability management requires `<higher role>`"* rather than asking the operator to sign in (which they already have). If it's a bug, file against the Capabilities Proofed item.

**Priority:** v1.0.0-rc1 — affects operators who need capability delegation to onboard secondary agents.

---

### A4. No first-load orientation on Overview

**Observed:** A first-time operator landing on Overview sees four vitals (Runs in motion / Agents active / Capital at work / Treasury posture), the eight-row Provider Operations health table, and several empty states (*"Last receipt · none"*, *"No live sessions yet"*, *"No live pulse events available for this view"*). No affordance tells them *what this room is*, *what they should do first*, or *what their current onboarding state is*.

**Why this matters:** Per `DISTRIBUTION_STRATEGY.md` (and the agent-discovery surfaces work in v2.5 spec §10), discovery agents and new operators landing on Averray for the first time should have a clear next action. Currently the platform's strongest selling point (trust infrastructure) is communicated via empty cards.

**Recommended action:** add a dismissable "first steps" card at the top of Overview that surfaces for operators in early states. Examples:
- 0 receipts: *"You have 0 receipts. Claim a run to start your trail →"* with click-through to Runs page
- 0 agents: *"You have 0 delegated agents. Create one to begin working →"* with click-through to Agents page / invite flow
- 0 capabilities granted: *"Delegate capability to a service wallet to scale operations →"* with click-through to Capabilities page

Card disappears once the operator has activity past a threshold. Doesn't compete with the existing vitals; sits above them as orientation.

**Priority:** v1.0.0-rc1 if onboarding is launch-critical; otherwise v1.x.

**Lane suggestion:** reputation-deepening / operator-onboarding lane.

---

### A5. Sidebar count badge inconsistency

**Observed:** Sidebar surfaces counts for `Runs 13`, `Receipts 0`, `Agents 3`, `Sessions 0`. No counts on Disputes, Capabilities, Policies, Audit log.

**Gap:** Inconsistent. Operators may assume "no badge means zero" when it might mean "this surface doesn't surface counts." Disputes especially — an operator seeing `Disputes 3 open` in the sidebar would benefit from glanceable awareness without needing to navigate.

**Recommended action:** decide one of —
- **Option A:** Show counts everywhere they're meaningful (Disputes, Policies pending proposals, Audit log events today). More information, more visual noise.
- **Option B:** Remove counts entirely. Pure visual consistency.

**Priority:** v1.x polish. Not launch-blocking but cheap to address during any sidebar work.

---

### A6. Provider Operations labels use internal job-sourcing language

**Observed:** Overview's Provider Operations rows show language like *"2 candidate(s), 1 created, 15 skipped, 0 error(s)"*.

**Gap:** Operator-facing UI uses internal job-sourcing terms (*candidate*, *skipped*) that aren't self-evident. As an operator: what's the difference between candidate and created? Is skipped bad? Should errors be actioned?

**Recommended action:** either —
- Add inline tooltip/legend: `candidate = potential job · created = job posted · skipped = filtered by policy · error = source unreachable`
- Relabel for operator-mode: `found · posted · filtered · failed` (or similar)

**Priority:** v1.x polish. Improves operator comprehension; not launch-blocking.

---

### A7. Treasury DOT borrow capacity / USDC debt asymmetry needs explanation

**Observed:** Treasury Credit Line section shows *"DOT borrow capacity 0 · debt shown in USDC"* and *"Headroom 0 DOT"*. Surrounding balance sheet (Spendable, Capital at Work, Collateral, Debt) is all in USDC.

**Gap:** Borrow capacity in a different asset than debt is structurally surprising. Operators will ask *"why is my capacity in DOT but my debt in USDC?"* No in-UI answer.

**Reconciliation needed:**
- Is this intentional architectural choice (collateral lives as DOT for staking yield, debt is settled in USDC)?
- Is this drift from the USDC plumbing migration where some surfaces were updated and credit line wasn't?

**Recommended action:** if intentional, add a small inline note explaining the model (one or two sentences in the Credit Line panel). If drift, file as roadmap reopen on the Proofed USDC plumbing item alongside A1.

**Priority:** v1.0.0-rc1 if credit line is launch-scope; otherwise v1.x clarity work.

---

## B-series — Opinionated design suggestions (take or leave)

These are aesthetic or operational opinions, not gaps. Disclaim explicitly: reasonable people may disagree. Listed here so the design thinking is captured for the team to evaluate, not as bound recommendations.

### B1. Sparklines on cards are decorative, not informative

The small sparklines on Overview vitals, Agents directory, and elsewhere have no axis labels, no hover values shown in screenshots, and are sized too small to reveal trends. They communicate *"this is a metric over time"* but not the trend itself.

**Suggestion:** either (a) make them meaningful — hover values, tighter time windows, visible delta — or (b) replace with a last-7-days delta number ("↑ 12% vs prior week") which is more directly useful at small sizes.

### B2. Filter row UX can be sharper

Pill-style filters work well. Two refinements: (a) when a non-`All` filter is active, the `All` pill could de-emphasize to make active constraints more obvious at a glance; (b) a single "Reset filters" link appears next to the search box when any non-default filter is active.

### B3. Time display is inconsistent across pages

Some pages show *"UTC 20:20:45"*, some *"2026-05-27 · 20:20:56 UTC"*, some relative (*"10d ago"*, *"14m ago"*). Auditors and high-trust UI consumers want consistency.

**Suggestion:** lock convention. Recommended: relative for < 7 days, absolute UTC for older, with an operator-local timezone toggle in settings. Pick one and stick with it across all surfaces.

### B4. Page header action buttons vary in styling weight

Some pages have one primary + one secondary action (Receipts: Export Bundle / Verify Signature); some have two actions of equal weight (Treasury: Move Capital / Propose Policy Change); some single primary (Agents: Invite Agent). Inconsistent.

**Suggestion:** establish convention — every page has *one* primary action (filled green) and zero-or-more secondary (outlined). Currently Verify Signature, Propose Policy Change, Flag Anomaly, Escalate, and Verify Manifest are all primary-styled despite being qualitatively different actions.

### B5. Sparklines marked "raw, not smoothed" on Agents page

The Agents page explainer says *"The 14d sparkline in each row is raw, not smoothed."* Useful disclosure, but raw daily reputation for a T1 agent with one receipt every few days is mostly flat with one spike — not a useful visual.

**Suggestion:** either smooth with a rolling 7-day average and document that, or use a sparser representation (markers per receipt rather than continuous line) that makes individual reputation events visually distinct.

---

## C-series — Features to consider, with priority

Concrete enough to be actionable per the roadmap status rules (owner, lane, close criteria suggested). Not vague aspirations.

### C1. "Open in chain explorer" link on every chain-anchored entity

**v1.0.0-rc1, high priority.**

**Why:** Per the trust pitch, every claim resolves to chain. The control room should provide one-click verification. Without this, the trust pitch is *claimed* but not *visible*.

**Implementation suggestion:** small `↗` icon next to any chain-anchored entity (receipt hash, session ID, dispute resolution, capability grant). Click opens Polkadot Hub explorer (Subscan or equivalent) at the relevant tx/event.

**Close criteria:** every page that displays a chain-anchored entity has the affordance; clicking lands on the correct explorer view; works for both mainnet and testnet entities.

**Lane suggestion:** trust-surface lane / reputation-deepening lane.

---

### C2. "Share this view" / public URL generator

**v1.x, medium priority.**

**Why:** For operators showing counterparties *"here's my reputation"* or *"here's this session's audit trail"*, generating public read-only URLs would be high-leverage for distribution. Compounds with the `averray.com/agent/<wallet>` work.

**Implementation suggestion:** every shareable surface (agent profile, session detail, dispute resolution, policy snapshot) gets a "Share" affordance that generates a signed read-only URL with appropriate expiry options.

**Close criteria:** at least three surfaces have working share URLs that render correctly when opened in an incognito browser; expiry honored; signature verifies.

**Lane suggestion:** reputation-deepening lane.

---

### C3. Verify existing "Verify Signature" / "Verify Manifest" buttons actually work end-to-end

**v1.0.0-rc1, high priority (verification, not new build).**

**Why:** Receipts page has "Verify Signature" button; Audit log has "Verify Manifest" button. If these work end-to-end (paste manifest hash, get verification result), the platform demonstrates its own trust mechanic in the UI — which is the strongest possible argument for defensibility.

**Recommended action:** confirm these buttons execute real verification, not placeholder UI. If real, document the verification flow as part of the launch demo. If placeholder, escalate to a real implementation before launch.

**Close criteria:** end-to-end verification flow demonstrably works for at least one real receipt and one real audit manifest.

**Lane suggestion:** existing receipts / audit log lane.

---

### C4. Cross-agent reputation comparison view

**v1.x, low priority.**

**Why:** For counterparties deciding between two agents, side-by-side comparison would be useful. The Agents page subtitle is *"This roster is the same identity a counterparty reads at averray.com/agents before deciding to hire"* — comparison directly supports that flow.

**Implementation suggestion:** multi-select in the agent directory, "Compare" button appears, side-by-side view with tier, reputation score, sparkline, badge list, recent activity.

**Close criteria:** select 2-3 agents, view side-by-side comparison, exportable as snapshot.

**Lane suggestion:** reputation-deepening lane.

---

### C5. "Why was this rejected/slashed" surfaced inline

**v1.x, medium priority.**

**Why:** Sessions and Disputes pages show REJECTED / SLASHED / DISPUTED states. When operators view a slashed session, they should see the policy violation inline, not click through. Slashes citing receipts (per Agents-page explainer *"Slashes cite a receipt and appear on the public profile"*) makes this structurally tractable.

**Implementation suggestion:** any session/dispute in a terminal-negative state shows the citing policy and the linked receipt inline in the directory row.

**Close criteria:** clicking through to a rejected session shows the policy violation, the cited receipt, and links to both in two clicks.

**Lane suggestion:** disputes lane / sessions lane.

---

### C6. Agent → public profile bridge, prominently visible

**v1.0.0-rc1, high priority.**

**Why:** Every agent row should have a one-click bridge to its public profile at `averray.com/agent/<wallet>`. Operators seeing the internal control-room view and the public counterparty view side-by-side is the trust pitch made operationally demonstrable.

**Implementation suggestion:** small icon button next to the handle/wallet column in the Agent directory; opens `averray.com/agent/<wallet>` in a new tab.

**Close criteria:** every Agent directory row has the affordance; clicking opens correct public profile; public profile renders with the same reputation/badge data as the internal view (verifying consistency).

**Lane suggestion:** reputation-deepening lane (likely existing).

---

### C7. "What's new" changelog surface for policy and capability changes

**v1.x, low priority.**

**Why:** Policies page tracks revisions (30d window). A small "recently changed" surface — *"3 policies updated in last 7 days"* with click-through to diffs — helps operators stay current without manually monitoring. Compounds with audit log.

**Implementation suggestion:** small inline card on Policies and Capabilities pages showing recent changes with diffs.

**Close criteria:** recent policy/capability changes visible from the relevant index page; click-through shows before/after diff.

**Lane suggestion:** governance / audit-remediation polish lane.

---

### C8. Global search across the control room

**v2, low priority.**

**Why:** Per-page filtering works at bootstrap volume. As receipt/session/agent counts grow, a global search (cmd-K style) finding entities by hash, wallet, ID would scale better.

**Implementation suggestion:** keyboard shortcut opens search overlay; queries across receipts, sessions, agents, policies, audit entries; results categorized by entity type.

**Close criteria:** cmd-K opens search; queries return results from at least four entity types; selection navigates to the entity's detail view.

**Lane suggestion:** future quality-of-life lane. Not needed at bootstrap volume.

---

## Recommended routing once reviewed

Once items are reviewed and decisions made:

| Item | If actioned, target document | Notes |
|---|---|---|
| A1 | `PROJECT_ROADMAP.md` reopen on USDC plumbing row | If drift confirmed |
| A2 | `PROJECT_ROADMAP.md` new row under existing receipts/badges lane | Small UX fix |
| A3 | `PROJECT_ROADMAP.md` investigation on Capabilities Proofed row | Verify behavior first |
| A4 | `PROJECT_ROADMAP.md` new row under reputation-deepening / onboarding lane | Onboarding-critical |
| A5 | Polish — bundle into next sidebar work or skip | Not launch-blocking |
| A6 | Polish — bundle into Overview work | Improves comprehension |
| A7 | `PROJECT_ROADMAP.md` reopen on USDC plumbing OR `AVERRAY_WORKING_SPEC.md` clarity addition | Depends on intent |
| B1-B5 | Design lane backlog | Opinions; team decides |
| C1 | `PROJECT_ROADMAP.md` new row, launch-blocking | Trust-surface |
| C2 | `PROJECT_ROADMAP.md` v1.x row under reputation-deepening | Distribution-leverage |
| C3 | `PROJECT_ROADMAP.md` verification item (not new build) | Confirm existing functionality |
| C4 | `PROJECT_ROADMAP.md` v1.x row | Reputation-deepening |
| C5 | `PROJECT_ROADMAP.md` v1.x row | Disputes / sessions clarity |
| C6 | `PROJECT_ROADMAP.md` v1.0.0-rc1 row under reputation-deepening | Trust-surface |
| C7 | `PROJECT_ROADMAP.md` v1.x row under governance | Compound with audit log |
| C8 | `PROJECT_ROADMAP.md` v2 backlog | Scale-driven |

No items above are marked Done or Proofed in this fragment — those statuses come after implementation evidence + verification per the roadmap's status rules.

---

## Closing note

The control room is in better shape than I had in my head from older context. Most of this fragment is polish and feature-suggestion, not architectural concern. The three A-series items most worth verifying first are A1 (asset drift on Runs), A2 (Receipts/Badges UX), and A3 (Capabilities sign-in state) — because they touch surfaces external counterparties will see and they map to Proofed roadmap items that may need reopening.

If these three resolve cleanly, the rest of this fragment is feature-direction work that can be paced against capacity rather than launch readiness.

*— Drafted 2026-05-27 from end-to-end UI review with current PROJECT_ROADMAP.md context.*
