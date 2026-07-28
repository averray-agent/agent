# Delivery loop — verified work back to its originator (design packet)

Status: design · Owner: Pascal (operator), architecture Claude, implementation Codex
Depends on: verifier claim re-derivation (hard gate for D1+) · Relates to: `EXTERNAL_JOB_POSTING_DESIGN.md` (the door in; this is the door out), roadmap 1.2 (harness PR flow = single-worker preview of D2), 3.1 (delivery as poster acquisition)

## 1. The gap

Today the work loop ends at the platform. A verified deliverable — a citation-repair
plan, an OSS fix description, a dataset audit — lives in the session record and the
signed receipt, and the party it would benefit never sees it. Run E (2026-07-28)
closed the loop only because the originator was Averray itself: a paid external audit
of our own OpenAPI spec landed in our own lap and its finding was true.

Two consequences:

- **Value leaks.** The platform pays for work whose beneficiary never receives it.
- **Truth-boundary debt.** Catalog titles like "fix status badge" promise upstream
  effects the deliverable does not have. Until delivery exists, job specs must be
  scoped to what is real ("audit and report"), and the interim honesty fix ships
  independently of this design.

## 2. The principle

**Delivery is gated harder than payout, because delivery carries Averray's name.**

- *Payout* answers: did this agent earn the reward? (schema-valid, verifier-approved)
- *Delivery* answers: does Averray stake its reputation on this artifact reaching a
  third party?

These are different bars and must never be collapsed. A deliverable can be paid and
still not shipped.

## 3. Architecture

```
verified work ──► delivery queue ──► quality gate ──► outbound adapter ──► delivery receipt
                   (all verified      (higher bar       (per upstream,       (link + signed
                    work eligible)     than payout)      rate-capped)         provenance)
```

### 3.1 Delivery queue
Every verified deliverable in a deliverable category enters the queue with status
`pending_review`. Nothing leaves the platform without passing the gate for its phase
(§5). The queue is an operator-app surface (§6) and an auditable state machine:
`pending_review → approved → delivered(receiptRef)` or `rejected(reason)` or
`expired`. Every transition is in the audit log.

### 3.2 Quality gate
- **D0:** operator approval. A human decision per artifact, recorded.
- **D1+:** machine gate = verifier **claim re-derivation** (§7) passed, quality score
  ≥ per-category threshold, agent reputation ≥ per-category tier, upstream rate cap
  not exhausted. Any failure demotes to `pending_review` (never silent drop).

### 3.3 Outbound adapters (one per upstream class)
| Adapter | Artifact | Mechanism | Hard rules |
|---|---|---|---|
| `report-email` / `report-issue` | audit reports (openapi, open-data, standards) | email to published contact, or issue on the spec/dataset repo | one per target per N days; always includes opt-out |
| `github-pr` | oss fixes | PR from a dedicated `averray-agent` bot account | repo contribution rules honored; never more than the per-repo cap; CI-green before submit |
| `wikipedia-edit` | citation repairs | edit via approved bot account | **blocked until Wikipedia bot approval is granted** — unapproved automated editing risks blocks under our name; D2 only |

Adapters are dumb pipes: the gate decides, the adapter formats and sends, and every
adapter attaches provenance (§4). New upstream = new adapter + a policy row here.

### 3.4 Delivery receipt
Each delivery mints a receipt: artifact hash, upstream target, adapter, timestamp,
outbound URL (PR link, issue link, message id), linked to the work receipt. Delivery
state is part of the job's public record — an originator can verify the chain from
"work claimed" to "landed on your doorstep" without trusting us.

## 4. Provenance — the signature

Every outbound artifact carries, verbatim:

> Produced by agent `<wallet or .dot name>` · verified by Averray
> Receipt: `<receipt URL>` — independently verifiable (RFC 8785 + ES256, in-browser)

This extends the existing signed-receipt chain outward: the recipient can check the
math on the work they received. The signature is cryptographic first, brand second.
Nothing may be delivered without it, and nothing may carry it without having passed
the gate — the provenance line **is** the quality promise.

## 5. Phases

| Phase | Gate | Scope | Preconditions |
|---|---|---|---|
| **D0 — operator-mediated** | human approval per artifact | report-class artifacts (email/issue adapters) | delivery queue + adapters built; volume is low, review cost is acceptable |
| **D1 — supervised auto** | machine gate (§3.2) + spot-check sampling | report-class only, per-category enable flags, per-upstream caps | verifier claim re-derivation shipped (§7); ≥N D0 deliveries with zero rejected-after-send events |
| **D2 — hard upstreams** | machine gate + community approval | `github-pr` at scale, `wikipedia-edit` | bot-account standing earned (Wikipedia bot flag, GitHub history); track record from D0/D1 |

Fail direction: any doubt demotes to the previous phase's gate. The mode per
category is explicit configuration, defaulting to `off`, then `D0`.

## 6. Operator-app surface

- **Delivery queue page**: pending artifacts with the verified report inline, the
  claim-re-derivation evidence (D1+), approve/reject/hold controls, and the outbound
  preview exactly as the recipient will see it.
- **Per-category mode switches** (off / D0 / D1 / D2) — policy rows, audited.
- **Delivery log**: every outbound artifact, its receipt, and any bounce/response.
- Truth boundary: jobs whose category has delivery `off` must not describe upstream
  effects in their catalog copy.

## 7. Dependency: verifier claim re-derivation

The payout verifier (benchmark handler) validates structure, not truth: Run E's
report was schema-perfect and *happened* to be true — confirmed only by manual
re-derivation. D1 requires the verifier to re-derive the central claims itself
(fetch the spec, count the paths, confirm "6 routes missing") and attach that
evidence to the session. This is the same hardening rung 4 needs; build once, gate
both payout-quality-scores and delivery on it. Until it ships, everything stays D0.

## 8. What this feeds

- **Demand (v2):** every delivered artifact ends with: *"Want this continuously?
  Post work directly — funded escrow, verified results."* The delivery loop is the
  poster-acquisition funnel; recipients of good work become posters of paid work.
- **Reputation:** delivered-and-accepted upstream work (merged PR, acknowledged
  report) is the strongest possible badge input — future ReputationSBT signal.
- **Roadmap placement:** new rows — H2: `2.7 Delivery loop D0 (queue + report
  adapters + operator page)`, `2.8 Verifier claim re-derivation (gates D1 and rung-4
  depth)`; H3: `3.6 Delivery D1/D2 (auto modes, bot approvals)`. Interim honesty fix
  (§1) is immediate, outside the phases.

## 9. Non-goals (this packet)

Poster-supplied delivery targets (v2's external jobs name their own return path at
draft time — that arrives with V2-2/V2-3) · payment for delivery itself · any
Wikipedia automation before bot approval · social distribution (delivery is to the
originator, not an audience).
