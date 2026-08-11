# Pin the job at claim time — settlement must not depend on a mutable catalogue

Status: **implemented on this branch.** Written after the 2026-08-11 incident.

Related: #1052 (the dead scheduler), #1058 (recovering the 32 orphaned submissions),
#1057 (the scheduler fix).

---

## The failure this prevents

On 2026-08-11 an external worker claimed and submitted 32 jobs. The auto-verifier died
before settling them. While it was dead, ingestion rotated the job catalogue and those job
definitions aged out. When the verifier was fixed and restarted, it found the sessions, could
not resolve their jobs, and skipped every one:

```js
try { job = this.platformService.getJobDefinition(session.jobId); }
catch { summary.skipped.push({ reason: "job_not_found" }); continue; }
```

Verified against production: four sampled session jobIds all return `job_not_found`, while
the board lists 14 entirely different jobs.

The worker is owed money for work it completed correctly. The rewards are escrowed on chain.
And the payment is unreachable because *we* lost the terms.

## The design flaw, stated plainly

**A submitted session's path to payment depends on a mutable, independently-rotating
catalogue.**

The work is done. The reward is escrowed. The terms were agreed at claim time. Yet
verification and settlement both consult the *current* catalogue — so a worker is racing an
ingestion cycle it cannot see, and if the cycle wins, the worker does not get paid.

That race is not a bug in the verifier. The verifier behaves correctly given what it can
see. The flaw is that settlement was ever allowed to depend on live-catalogue state.

## The fix

**Pin an immutable job snapshot to the session at claim time.** Verification and settlement
read the snapshot, never `getJobDefinition`.

What the snapshot must carry is everything needed to decide and pay without further lookup:

- the verifier mode and its configuration (what "correct" means)
- the reward asset and amount, and the claim stake terms
- the output schema or its ref, resolved rather than referenced
- whatever the benchmark/deterministic handlers compare against
- the job id and a content hash of the definition as claimed

Then:

- `getJobDefinition` remains the entry point for *browsing and claiming* — that is a live
  question and should see live data.
- Verification and settlement consult **only** the snapshot, and **assert it reproduces the
  on-chain `specHash`** before deciding (see below — this half is not optional). A rotated
  catalogue becomes irrelevant to anyone who has already claimed.

### Why a hash matters as well as a copy

Storing a hash of the definition as claimed makes two things possible: proving after the
fact what an agent actually agreed to, and detecting if a snapshot were ever tampered with.
It costs almost nothing and it is the difference between "we believe these were the terms"
and "these were the terms."

## Pinning alone is not sufficient — verification must assert the hash

Found during the 2026-08-11 recovery, and it is the more serious half of this.

Two of the orphaned sessions had already been **re-ingested** under the same job id
with different lifecycle timestamps, so their current catalogue definitions no longer
reproduce the on-chain `specHash`. **Normal verification processed and settled them
anyway.**

So verification does not merely depend on a mutable catalogue — it never checks whether
what it is reading is what was agreed. A definition can change silently after claim and
the verifier will decide against the new terms as though they were the original ones.

Today that was benign: the re-ingested definitions were close enough that the outcome was
probably the same. But the same mechanism can approve work against terms the worker never
saw, or reject work that satisfied the terms it actually accepted. Neither is detectable
after the fact, because nothing records which terms were used.

**The rule:** verification must assert that the pinned snapshot reproduces the on-chain
`specHash` before deciding. If it does not, that is not a verification failure — it is an
integrity failure, and it should stop and say so rather than fall through to a verdict.

`EscrowCore` already commits `specHash` at job creation, and `gateway.js` computes it over
the complete normalized definition. The hash exists precisely to make this checkable.
Nothing consults it.

Worth noticing where this rule came from: the hash gate used to decide which orphaned
definitions were safe to restore is exactly the gate that should have been in verification
all along. Recovery needed the discipline that the happy path lacked.

## What this also fixes

- **Claim-time terms become enforceable.** Today, if a job definition changed between claim
  and submission, the worker is judged against terms it never saw. The snapshot closes that
  quietly too.
- **The dispute path gets a fixed reference.** An arbitrator can see exactly what was agreed
  rather than what the catalogue currently says.
- **Retention of the catalogue stops being a payment dependency,** so ingestion can rotate as
  aggressively as it likes.

## Observability that should ship with it

A persistent `job_not_found` skip on a **submitted** session should degrade health. Today
the verifier reports `ok: true` while permanently refusing to settle 32 submissions — technically
accurate about the scheduler, useless about the outcome.

The rule worth generalising: **a component is not healthy merely because its loop is
running.** If it is skipping the same work every tick with the same reason, that is a
failure wearing a green badge. `lastRun.skipped` already holds the answer, but it is
admin-only, which is why this took hours to locate instead of minutes.

## Migration

Existing sessions have no snapshot. Backfilling is best-effort and may be impossible for the
32 already orphaned — that is #1058's problem, not this one. New claims get snapshots from
the day it ships; old sessions keep the current behaviour and are drained or settled
manually.

Do not block this on solving the backfill. The point is that it never happens again.

The hash assertion needs an explicit answer for sessions with no snapshot: they cannot
prove their terms, so they must not silently pass the check. Failing them closed and
surfacing them for operator handling is right — a session that cannot demonstrate what it
agreed to is precisely the case that needs a human, and it is a bounded, shrinking set.

## What this does not solve

- Recovering the already-orphaned sessions (#1058). Recovery there was only possible at all
  because a 5,000-entry Redis event log happened to still hold 24 of 32 ingest snapshots —
  8 were already evicted. At current volume that is an evidence horizon of **hours**, which
  is the real argument for pinning: nothing else retains the terms long enough to matter.
  The split between what was recovered and what was lost was timing, not design.
- Jobs whose *external* reality changes after claim — a GitHub issue closing, a wiki revision
  moving on. The snapshot pins **our terms**, not the world. Whether a worker should still be
  paid when the upstream anchor moves is a separate policy question, and worth answering
  before the OSS lane grows.
