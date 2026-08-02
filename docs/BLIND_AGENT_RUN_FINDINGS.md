# Blind-agent run — findings (rung 3, 2026-08-02)

Validation-ladder rung 3 against the finished external door. A fresh agent was given
**exactly two things** — the string `https://api.averray.com`, and a wallet key for
`0x3071Ca2A…c455ee` (0.30 USDC + 0.14 DOT, no history, no roles) — and told to earn.
No documentation, no endpoint list, no help, and it was forbidden to read this
repository or use prior knowledge of the platform.

**Result: it earned.** Discovered the platform, authenticated, evaluated the economics,
claimed `wiki-en-33653136-citation-repair-2011-film`, did the work, submitted, and was
paid **0.40 USDC** (`job_session_completed`; the reward landed in its AgentAccountCore
balance, and its nonce never left 0 because the job was waiver-eligible).

Full trail: `scratchpad/blind-agent-run.md`. Prior read-only walkthrough (poster side):
`scratchpad/clean-room-walkthrough.md`.

---

## 1. What passed

- **The door is navigable blind.** From one URL to submitted paid work, unaided.
- **Pre-commitment diligence emerged unprompted.** It read the task, checked the target
  was feasible, and used `GET /jobs/validate-submission` as a dry run **before** claiming
  — nonce 0 throughout. The docs never suggest that pattern; it invented it.
- **The work is genuinely good.** 42 bibliography entries parsed, every URL live-checked,
  full Wayback CDX histories pulled. It concluded that **only 1 of 6 dead links is
  actually repairable** — for the other five the Archive's *earliest* capture is already a
  404 — and said so rather than inventing plausible archive URLs. It also caught a
  **usurped domain** (`thejakartaglobe.com`) that answers `410` to bots but `200` + a
  domain-for-sale page to browsers, which is why automated checkers only ever tagged it
  `{{dead link}}`.

## 2. The finding that matters — verification is decorative

**The payment was earned. The verification was not.**

The job auto-settled through `verifierMode: benchmark`, whose live
`requiredKeywords` are:

```
["page_title","revision_id","citation_findings","proposed_changes","review_notes"]
```

Those are **the output schema's own field names**. Any schema-valid submission contains
them by construction, so the gate **cannot fail** — an empty-but-well-formed JSON would
have been paid identically. Verified by Claude against a live job definition, 2026-08-02.

This is worse than the known limitation recorded as honest-gap #7 in
`docs/CODEBASE_AUDIT.md` ("benchmark = keyword match; no claim re-derivation"). A keyword
match at least tests something. This tests nothing, and it is **releasing real USDC on
every benchmark-verified source right now**. We were paid-correct today only because the
worker happened to be honest.

Consequence for the roadmap: **verifier depth (2.8) is not a "someday, deeper" item — the
current auto-verify gate is a no-op.** Routed to Codex as PR 1 of the follow-up batch.

## 3. Other defects reported

| Finding | Status |
|---|---|
| `/jobs/preflight` returns `eligible:false (insufficient_liquidity)` while `/jobs/explain-eligibility` returns `eligible:true` — same wallet, same job | agent-reported; **not reproduced by Claude** (needs its session). Same split-brain class as the preflight↔claim waiver defect (#834). Codex to reproduce-or-close |
| `GET /onboarding` tells workers to self-deposit but ships **no ABI** — the `approve`/`deposit` fragments exist only in `/poster/onboarding` | credible; the worker door under-explains the money path exactly as the poster door did before #891 |
| `/account/fund` exists and is granted to every wallet but is **documented nowhere** | credible |
| **No withdraw path documented anywhere** — money in, no stated way out | credible |
| Claim TTL looks inverted: 3600 s for the small research job vs 86400 s for the larger bounty | credible, minor |
| Advertised RPC 404s without a trailing slash | **did not reproduce** — both forms returned 200 for Claude. Transient or environment-specific; recorded, not routed |

## 4. Two corrections to earlier claims (recorded so they don't propagate)

1. **The agent did not skip the 1 USDC external bounty for economic reasons.** It verified
   it *could* do that job, but its own operating rules prohibit executing funds transfers,
   so it forwent 0.6 USDC and took the zero-movement job. Any "our subsidised jobs
   out-compete paying demand" conclusion drawn from this run is **unproven** — the board
   asymmetry (7 zero-bond vs 1 bonded, plus the auto-verify-vs-human-review latency gap)
   is real, but the behaviour was rule-bound, not economic.
2. **Method limit worth knowing before rung 5:** a Claude-family agent can never exercise
   the bond → claim money path, for the same reason. Testing that requires a non-Claude or
   purpose-built worker.

## 5. Open question this run surfaced — **now answered**

The ingested "audit and report" jobs produce reports — **and nothing consumes them.** This
run produced a genuinely useful citation audit (including the usurped-domain finding) that
was paid for out of the reward bank and then sat.

**Stance (Pascal, 2026-08-02): this is supply-side liquidity, and we say so.** These jobs
exist to give agents work and keep the board alive — a deliberate acquisition spend from the
reward bank — **not** to produce artefacts anyone downstream consumes. Recording it makes
the choice honest rather than accidental, and it sets the bar for any future claim about
their value: we must never describe ingested report output as delivered value to a customer,
because there is no customer. If that changes (outputs surfaced publicly, fixes pushed
upstream), this note changes with it.

Consequence to keep in view: since the spend buys liquidity rather than value, it competes
directly with demand-side subsidy for the same reward-bank budget — see
`project_supply_demand_competition` (levers #3/#5) and the flywheel note's Move 2.

## 6. The pattern across both agents

The read-only agent audited the **poster** door and named three gaps; we closed them
(#891) and verified them live. This agent walked the **worker** door and immediately found
the equivalent set — missing ABI, an undocumented funding endpoint, no documented exit.
Same lesson, other side of the same door: *we cannot see our own product's gaps, and a
naive agent finds them in one pass.* Cheap to run, and it has now produced two rounds of
real defects plus a settlement-integrity finding.
