# PACKET — Human find-work loop (screens, not docs)

**Requirements:** Pascal, 2026-08-21 (verbatim brief in §1) · **Architecture:** Claude · **Ratifier:** Pascal
**Implementer:** Codex · **Deliverable:** TWO PRs (app, marketing) — mcp-server only if §D3's field audit finds a gap.

## 1. The requirement (Pascal's brief, binding)

A motivated first-time person on averray.com completes the same loop a first-time
agent already can — discover work, understand terms, claim, submit, watch
verification, get receipt + payout — without API JSON, MCP, or GitHub. Same jobs,
same verifier, same receipts. SIWE only. Operator app stays the operator room.
Done when a blind human re-run with "no API" completes one waiver-eligible starter
and points at a public receipt URL + non-zero payout.

## 2. Architecture decisions

**D1 — The loop lives in the app package as a public route-group `/work`**, with
its own worker layout (no operator chrome). Rationale: the app already owns SIWE,
wallet connect, and the authed API client; Astro would duplicate all three. The
operator room stays intact behind its existing routes.

**D2 — Sign-in forks by wallet role.** After SIWE: operator-allowlisted wallets →
`/overview` exactly as today; every other wallet → `/work`. A worker wallet never
sees the operator shell. Browsing `/work` needs NO wallet — the wallet prompt
appears at claim time (matching the agent flow, where listing is public).

**D3 — Zero new backend surface intended.** The screens consume the EXISTING
HTTP endpoints the agent loop uses (list, definition, preflight, eligibility,
net-reward, claim, submit, session status). First implementation step is a field
audit: if the public listing lacks anything §3's screens need (e.g., waiver flag,
human success-criteria text), the fix is an ADDITIVE field on the existing
endpoint — one small mcp-server PR, never a second catalogue.

**D4 — Submission is a schema-guided editor, not per-job form builders.** The
submit screen renders the job's instructions and output schema, provides a
guided editor validated client-side against that schema (human-readable errors,
required-field hints, a filled example derived from the schema), and submits
through the same `submitWork` the agents use. Same verifier, same receipts —
the human just gets seatbelts. Bespoke pretty forms per job type are future work.

**D5 — Pre-claim honesty panel.** Before the claim button: reward and net
estimate, whether a bond/stake applies, gas story (operator-brokered vs
worker-paid), waiver eligibility, claim TTL — sourced from preflight/eligibility
endpoints. A job that would fail at claim is marked before the wallet ever pops.

**D6 — Verification watch that cannot hang.** Session screen polls status with
the hardened-reader pattern (timeout + retry + honest stall message), then links
the receipt page and the wallet's public profile. The benchmark check-depth
statement (per the anchored-evidence dispatch) renders here too.

**D7 — Synthetic work never reads as demand.** The `/work` listing excludes
canary/witness/disposable-proof jobs (server-side filter param or client filter
on the existing flags — decided in the field audit). Agent-facing listings are
unchanged.

**D8 — Entry point.** Marketing homepage gains one CTA: "Find paid work →" →
`app.averray.com/work`, with the one-line explainer ("Paid tasks with public
receipts. Browse freely; claiming takes a browser wallet."). Content lint stays
green; no counters, no baked numbers.

## 3. The screens

1. **`/work`** — claimable list: title, one-line "what done means", reward,
   waiver/wallet/bond badges, claim TTL. Empty state is honest ("No open starter
   work right now — lanes refill on a schedule").
2. **`/work/[jobId]`** — full definition: instructions, success criteria, output
   schema (readable rendering), the D5 honesty panel, Claim button (SIWE here).
3. **`/work/session/[sessionId]`** — the claimed job workspace: instructions +
   D4 editor + submit; then D6 verification watch → receipt link + profile link.
4. Sign-in fork (D2) inside the existing sign-in flow.

## 4. Constraints restated (binding, from the brief)

Same jobs/verifier/receipts — no second catalogue, no paper-grader · SIWE only,
no email · operator app unchanged for operators · A/B/C honesty rules apply
everywhere here (no 404s, no blank hydration, no silent walls, no hung fetches) ·
synthetic agents/canaries/Witness never look like demand · non-goals: About/
Contact/Pricing/Blog, human treasury/posting/admin, MCP-HTTP onboarding changes,
the auto-verifier ops item.

## 5. Acceptance (the blind re-run is the gate)

1. Scripted walkthrough in CI where feasible (component/e2e per app conventions):
   browse → claim (mock wallet) → submit schema-valid output → status → receipt
   link renders.
2. A waiver-eligible starter is completable with a fresh wallet holding nothing.
3. The listing shows zero canary/witness jobs while the agent listing still does.
4. Lighthouse-level sanity: `/work` renders content without JS hydration hangs.
5. **The human re-run:** Blind User (or equivalent) repeats the exercise with
   "no API" allowed and completes the loop — the packet is DONE only on that
   evidence, recorded like the first transcript.

## 6. Sequencing

After Packets A/B/C land (they fix the walls this path walks past). The
anchored-evidence dispatch may land in parallel — D6 renders whatever depth
statement exists.
