# PACKET — Retention surfacing (mechanics exist; this builds the moment)

**Author:** Claude · **Ratifier:** Pascal (by dispatch, 2026-08-21) · **Implementer:** Codex
**Deliverable:** ONE PR (mcp-server) + one small marketing follow-on after the
profile-page fix lands. Human-loop screens CONSUME this; do not duplicate there.

## 1. The finding (blind tester, pass 2)

The platform's retention mechanics — ladder caps, badges/tiers, deposit
entitlements, credit for proven workers — are pure enforcement with zero
narrative surface. A blind agent who earned a badge and a tier never learned
either existed (the one page showing them was broken), and enumerated every
invitation we make: retention was in none of them. Workers can't be retained by
mechanisms they cannot see.

## 2. Decisions

**R1 — One canonical `progression` block, computed server-side, consumed
everywhere.** Shape (all values live-computed, never cached into copy):
`{ tier, badges: [...], effectiveCaps: { perJobMax, rolling24h, concurrent },
justChanged: { field, from, to } | null, raises: [ { action: "keep_completing" |
"deposit", effect: <human sentence with live numbers> } ],
creditInterest: { eligible: bool, registered: bool } }`.

**R2 — The retention moment is settlement.** The verify/settle response and the
session-status payload for a settled session embed `progression`. A worker's
best moment to learn "what this unlocked" is the second they get paid.

**R3 — `explainEligibility` narrates, not just gates.** Alongside today's
verdict it returns `currentCap`, `capSource` (tier/deposit components), and
`nextRaise` (the cheapest action that would raise it) — same block, per-job view.

**R4 — MCP welcome gains ONE progression line** (budget-conscious):
"Completions raise your claim caps; deposits raise them further — see
getAccountPosition and explainEligibility for yours." No new tools.

**R5 — Credit is surfaced as opt-in interest, never a promise.** Where
`progression.creditInterest.eligible` (worker has ≥ N settled external-verified
jobs — start N=3, config), the block offers a registration flag (one authed
call, stored; visible in the existing admin credit views). Copy: "Proven workers
can register interest in a small zero-interest cash line (pilot)." NO amounts,
NO approval implication, NO timeline. The L2 cohort gets built FROM this list.

**R6 — Truth rules.** Synthetic/canary identities never receive or count toward
progression surfaces · marketing markup carries no figures (profile page renders
tier/badges/unlocks from the API, after the in-flight profile fix lands — a
separate small marketing PR sequenced behind it) · vocabulary law applies
("reputation", "caps", "receipts" — never "certification").

## 3. Tests

Progression block: computed correctly for a fresh wallet, a badged wallet, and a
deposit-holding wallet (three fixtures) · `justChanged` fires exactly on the
settlement that crossed a threshold, by name · welcome line present · eligibility
narration fields present and consistent with the gate verdict · credit-interest
flag: gated by N, idempotent, listed in admin, and NEVER auto-approves anything
(mutation drill: wiring it to any origination path must fail by name) · synthetic
wallets excluded, by name.

## 4. Out of scope

Any origination/underwriting change · new tools/endpoints beyond the interest
flag call · marketing profile rendering (follow-on PR after the fix) · human-loop
screens (that PR consumes `progression` — coordinate).
