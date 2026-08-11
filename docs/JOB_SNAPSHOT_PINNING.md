# Pin the job at claim time — settlement must not depend on a mutable catalogue

Status: **design, not built.** Written after the 2026-08-11 incident.

Related: #1052 (the dead scheduler), #1058 (recovering the 33 orphaned submissions),
#1057 (the scheduler fix).

---

## The failure this prevents

On 2026-08-11 an external worker claimed and submitted 33 jobs. The auto-verifier died
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
- Verification and settlement consult **only** the snapshot. A rotated catalogue becomes
  irrelevant to anyone who has already claimed.

### Why a hash matters as well as a copy

Storing a hash of the definition as claimed makes two things possible: proving after the
fact what an agent actually agreed to, and detecting if a snapshot were ever tampered with.
It costs almost nothing and it is the difference between "we believe these were the terms"
and "these were the terms."

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
the verifier reports `ok: true` while permanently refusing to pay 33 people — technically
accurate about the scheduler, useless about the outcome.

The rule worth generalising: **a component is not healthy merely because its loop is
running.** If it is skipping the same work every tick with the same reason, that is a
failure wearing a green badge. `lastRun.skipped` already holds the answer, but it is
admin-only, which is why this took hours to locate instead of minutes.

## Migration

Existing sessions have no snapshot. Backfilling is best-effort and may be impossible for the
33 already orphaned — that is #1058's problem, not this one. New claims get snapshots from
the day it ships; old sessions keep the current behaviour and are drained or settled
manually.

Do not block this on solving the backfill. The point is that it never happens again.

## What this does not solve

- Recovering the 33 already-orphaned submissions (#1058).
- Jobs whose *external* reality changes after claim — a GitHub issue closing, a wiki revision
  moving on. The snapshot pins **our terms**, not the world. Whether a worker should still be
  paid when the upstream anchor moves is a separate policy question, and worth answering
  before the OSS lane grows.
