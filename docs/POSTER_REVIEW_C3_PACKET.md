# C3 — the poster reviews their own job (packet)

The final rung of the poster-door clarity packet (`POSTER_DOOR_CLARITY_PACKET.md`
§4/C3), specced after C1+C2 shipped and a real external bounty went live from
the browser (job `0xaa4b7b03…`, depre-dev/averray-reference-agent#625). This
packet grants exactly one new authority and reroutes one settlement path.
**Threat-model note comes first — no implementation lands before it.**

---

## 1. The single authority granted

> **A poster may decide the review of a submission on their own external job.**

Bounded precisely:

- Only jobs whose **recorded on-chain poster equals the SIWE session wallet**.
- Only **external-source** jobs (`source: external`).
- Only from state **Submitted** (one live submission awaiting review).
- **Approve** can release funds only to *that job's submitter*, only the
  amounts already escrowed at creation (reward → worker, snapshotted fee →
  treasury). No amount choice, no recipient choice, no cross-job reach.
- **One decision, idempotent.** A second decision on the same submission is a
  no-op returning the recorded outcome (MAIN-002/003 receipt conventions).
- Wallet sessions only (like drafts) — service tokens refused.
- Admin/operator decision paths remain (override + support), unchanged.

Why this is safe to grant: approval spends **the poster's own escrow** on the
**worker who actually submitted** — the poster can only give what they already
committed, to the only party they owe. There is no theft shape; the worst
misuse is a poster paying for bad work with their own money.

## 2. Settlement rerouting (the backend delta)

Current v1 path for `human_fallback`: verifier → `HUMAN_REVIEW_REQUIRED` →
rejection recorded → worker opens dispute → **hardware arbitrator** resolves.
That was correct while no poster-decision channel existed. C3 changes the
routing, not the machinery:

- **Approve** → backend records the poster verdict (canonical receipt:
  decision, wallet, rationale hash, timestamp) → settles through the
  **existing settlement-broker path** (the same `verifySubmission` →
  settle flow that resolves starter jobs from Submitted today). Worker gets
  the full reward + bond released; treasury gets the snapshotted fee;
  `SettlementSplit` emitted. **No arbitrator involved.**
- **Reject** → backend records the verdict + reason (rationale hashed like
  dispute verdicts) → the existing on-chain rejection is recorded → the
  worker's 7-day dispute window engages, unchanged: worker silent → anyone
  finalizes → bond slashed, poster fully refunded; worker contests → dispute
  → arbitrator (or 14d auto-resolve favoring the worker).
- The **hardware arbitrator's role shrinks to genuine disputes only** — its
  intended F6 shape.

### Poster-silence escalation

If a submission sits undecided past the **review window** (live-config knob,
default 7 days — never hardcoded), the platform escalates in ONE brokered
step: record the review-timeout rejection **and** open the dispute on the
worker's behalf (`openDisputeFor`, the existing serviceOperator path) — so a
ghosted worker is never required to act to preserve their rights, and never
slash-exposed by the poster's absence. From there the normal dispute terminals
apply (arbitrator, or 14d auto-resolve → worker paid in full).

**Known adjustment:** the dispute pipeline currently fail-closes on *opening*
disputes it cannot itself resolve (`out_of_band_hardware`, seen live in the
dogfood). That gate was designed to avoid recording verdicts it can't execute;
**opening** is safe because resolution has a permissionless terminal
(auto-resolve). Codex: split the gate — refuse un-executable *verdict
recording* (keep), allow *escalation opening* (change), with the reasoning in
the threat-model note.

## 3. Endpoints (poster-scoped, both new authz)

- `GET /jobs/:id/submission` — the deliverable for review (evidence: PR URL /
  report payload, submitted-at, worker wallet), readable **only** by the
  job's poster (+ admin). 404-shapes must not leak others' submission
  existence beyond what the public catalog already shows.
- `POST /jobs/:id/review` — body `{verdict: "approve" | "reject", reason}`
  (reason required for reject, min length; hashed into the receipt). Applies
  §1's guards, then §2's routing. Idempotent per submission.
- Rate-limited per wallet (mirror the `external_drafts` bucket pattern).

## 4. Threat-model note (FIRST deliverable, blocks the rest)

One page added to `THREAT_MODEL.md` covering, at minimum:

- The §1 authority and its exact bounds; why no theft shape exists.
- **Self-dealing**: poster claims their own job via a second wallet and
  self-approves — economically a wash that *loses* the protocol fee; state
  why that's acceptable (and note the bond makes squatting-to-self-deal cost
  liquidity).
- **Race edges**: decision vs claim-expiry; decision vs escalation firing;
  double-submit of the review call (idempotency key); approve arriving after
  auto-escalation opened a dispute (must be refused — the dispute path owns
  it from that point).
- **Broker-authority delta**: the settlement broker now acts on a
  poster-supplied instruction for external jobs; enumerate the checks binding
  broker action to (job, submitter, escrowed amounts) so a forged/replayed
  instruction cannot move anything else.
- The §2 gate split (verdict-recording fail-close kept, escalation-open
  allowed) and why.

## 5. Authz test matrix (backend, must exist before UI)

| Caller | Expected |
|---|---|
| Poster-of-job (SIWE) | ✓ decide |
| Different enrolled poster | ✗ 403 |
| Arbitrary wallet | ✗ 403 |
| Service token | ✗ 401/403 (wallet sessions only) |
| Admin | ✓ (operator path retained) |
| Poster, job not Submitted | ✗ honest state error |
| Poster, second decision | idempotent no-op w/ recorded outcome |
| Poster, after escalation opened dispute | ✗ refused, dispute owns it |

Plus: approve → broker settles → on-chain `SettlementSplit` asserted in test;
reject → rejection recorded + window math; escalation → single brokered step.

## 6. UI (Claude, after the backend gates green)

The "Needs your review" queue on `/poster` (mockup agreed 2026-08-01):
submitted-state jobs of the session wallet; deliverable shown beside the
poster's own acceptance criteria verbatim; deadline chip from live window
config; approve (with the pay amount) / reject (reason required); lights via
the existing SSE events; every state honest (deciding, settled with tx link,
rejected with window countdown, escalated).

## 7. Lanes & acceptance

| Piece | Owner |
|---|---|
| Threat-model note | Codex (Claude gates) |
| Backend: authz + routing + escalation + endpoints + tests | Codex (one PR) |
| UI queue | Claude (one PR, after backend green) |
| Live acceptance | Pascal — decide a real submission on job `0xaa4b7b03…` (#625) end-to-end from the Posting page |

**Packet acceptance:** a real submission on the live bounty is approved (or
rejected) by the poster from the browser; on-chain settlement verified
independently; the silence and rejection cascades' timeout math covered by
tests; arbitrator untouched on the happy path.

## 8. Non-goals

Poster-defined verifier logic · partial approvals/split payouts (arbitrator
`split` remains the only partial path) · poster notifications beyond the
in-app queue (email/webhook = separate future item) · any change to worker
bonds or dispute windows.
