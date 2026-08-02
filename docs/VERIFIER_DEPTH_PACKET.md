# Verifier depth (roadmap 2.8) — packet

Make "verified" mean *the claim was independently re-derived*, not *the worker echoed the
task*. Two separate findings on 2026-08-02 pointed here: the blind agent proved the
benchmark gate was a tautology (`BLIND_AGENT_RUN_FINDINGS.md`), and the demand-side analysis
found external bounties lose worker attention to **latency**, not price
(`project_supply_demand_competition`) — both fixed by the same build.

> **The central finding of this packet: most of it already exists.** The `github_pr`
> handler (`verifier-handlers.js:109`) already re-derives against **live GitHub** —
> `issueReferenced`, `merged`, `checksPassing`, test evidence, scored, with submitted
> evidence only as a fallback when the lookup fails. The work is not "build re-derivation";
> it is **route the right jobs to it, and extend the idea to the sources that still use
> keyword matching.**

## 1. Where each verifier actually stands

| Mode | What it proves today | Verdict |
|---|---|---|
| `github_pr` | Live GitHub: PR exists, references the issue, merge state, CI/check state, test evidence — scored | **Already 2.8-grade** |
| `deterministic` | Exact/pattern match against expected output | Fine for its niche |
| `benchmark` | Keyword match. After #895 the terms are source identifiers (title, revision id, URL) rather than schema keys — but **all of them are copyable from the job spec**, so it proves the worker *read the task*, not that work happened | **The gap** |
| `human_fallback` | A human decides | Honest, but slow — and slowness is the demand-side problem |

## 2. Move A — route PR-deliverable bounties to `github_pr` (small, highest leverage)

The posting wizard's *"Fix with a pull request"* template currently sets
`verifierMode: human_fallback`. That was right when the alternative was a URL-only check —
but `github_pr` already re-derives properly, so those bounties can settle **automatically
and fast** without weakening the gate.

- Wizard's PR template → `github_pr`; the audit/report template stays `human_fallback`
  (open-ended prose genuinely needs a human).
- **Failure must degrade to human review, never to pass.** GitHub unreachable, rate-limited,
  private repo, ambiguous score → escalate to `human_fallback`, never auto-approve.
- Poster-facing honesty: the wizard and `/poster/onboarding` must state *which* gate a
  bounty will use and what it checks — a poster choosing "PR" is choosing automated
  settlement and should know it.
- **This alone erases the latency asymmetry for exactly the jobs external posters care
  about**, which is the demand-side fix.

## 3. Move B — re-derivation for the ingested sources (the real build)

Each `benchmark` source needs a claim its verifier can independently check. The pattern:
**the submission asserts something about the world; the verifier goes and looks.**

| Source | The claim to re-derive | Cheap check |
|---|---|---|
| Wikipedia citation repair | "these citations are dead / these archives exist" | re-request the URLs the report marks dead; confirm the archive snapshots it proposes actually resolve |
| Wikipedia freshness / infobox | "the article's revision is X and field Y is stale" | fetch the live revision; compare |
| OSV advisory | "package P is vulnerable in range R, fixed in F" | re-query the advisory |
| OpenAPI / standards drift | "the spec at URL is version V and our surface differs" | fetch the spec; compare the version + the named surface |
| Open data | "the resource at URL is format F and has issue I" | HEAD/fetch the resource |

Design rules that apply to all of them:
- **Fail honest, never fail open.** Network error, rate limit, or an unverifiable claim →
  escalate to `human_fallback`. Never auto-approve on a failed lookup — that is exactly the
  hole #895 closed, in a new costume.
- **Re-derive the claim, don't re-do the work.** The verifier checks a *sample* of asserted
  facts, not the whole task; cost and latency must stay bounded (state the budget per source).
- **Anti-gaming:** a claim that is trivially self-fulfilling isn't evidence. For PRs that
  means diff non-triviality; for citation repair it means the proposed archive must actually
  serve the cited content, not merely return 200.
- The #895 keyword gate stays as a **floor**, not the ceiling — belt and braces during
  rollout, removable per-source once re-derivation lands.

## 4. What this does NOT claim

Re-derivation checks the *stated claim*, not the *quality of judgement*. A report can be
factually accurate and still shallow. So:
- `human_fallback` remains correct for open-ended analysis, and the poster guide's "what
  verified means today" section must keep saying so.
- Nothing in this packet licenses describing auto-settled work as "reviewed".

## 5. Sequence

1. **Move A** (route PR bounties to `github_pr` + honest degradation + poster-facing
   disclosure). Small, immediate demand-side win.
2. **Move B**, one source at a time, highest-volume first — each source is independently
   shippable and independently gated.
3. Per source, retire the keyword floor only after its re-derivation has run clean.

## 6. Lanes

| Piece | Owner |
|---|---|
| Move A routing + degradation + disclosure | Codex |
| Move B per-source re-derivation | Codex, one PR per source |
| Wizard/onboarding copy for which gate applies | Claude |
| Independent gating (incl. a "does a plausible-but-false submission fail?" test per source) | Claude |

## 7. Acceptance

For every source touched: a submission that **asserts something false** is rejected, a
**correct** one passes, and a **lookup failure** escalates to human review rather than
either extreme. That triple is the packet's whole point — and it is the test the old
benchmark gate could never have passed.
