# Nine more schedulers can die the same way

Status: **audit + design, not built.** Written 2026-08-11, the day the tenth one did.

---

## 1. What we actually fixed, and what we did not

#1057 fixed the submitted-job auto-verifier: it rescheduled only after `runOnce()`
returned, so one throw or one hung await killed the loop permanently while the API stayed
healthy. That defect cost a day and left an external worker unpaid.

It is not a one-off. **It is a copy-paste pattern, and nine other schedulers still carry it.**

```js
async runOnceAndSchedule() {
  await this.runOnce(new Date());          // throws or hangs -> nothing below ever runs
  if (!this.running) return;
  if (this.timer) clearTimeout(this.timer);
  this.timer = setTimeout(() => { void this.runOnceAndSchedule(); }, this.intervalMs);
}
```

Verified by reading the reschedule site in each, not by grep count alone:

| component | reschedule guarded? | what dies with it |
|---|---|---|
| `submitted-job-auto-verifier` | **fixed** (#1057) | settlement — the 2026-08-11 incident |
| `external-posting-watcher` | **yes** — `try/catch` round the await, reschedule after | funded external jobs going live |
| `bank-xcm-v22-runtime` | **unverified** — see below | bank lane dispatch |
| `first-external-agent-alert` | **unverified** — see below | first-arrival alerting |
| `job-stale-sweeper` | **no** | stale claims never return to claimable |
| `open-data-ingestion-scheduler` | **no** | Data.gov jobs stop appearing |
| `github-issue-ingestion-scheduler` | **no** | GitHub jobs stop appearing |
| `openapi-spec-ingestion-scheduler` | **no** | OpenAPI jobs stop appearing |
| `osv-advisory-ingestion-scheduler` | **no** | OSV jobs stop appearing |
| `standards-spec-ingestion-scheduler` | **no** | standards jobs stop appearing |
| `recurring-scheduler` | **no** | recurring job templates stop firing |
| `bootstrap-self-report-scheduler` | **no** | self-report stops |
| `external-poster-review-escalator` | **no** | poster reviews never escalate |
| `upstream-status-poller` | **no** | upstream status goes stale silently |

### A caveat about this table, which is the point of the whole document

My first pass classified components by whether the file contained a `finally`. That proxy is
wrong: in `bank-xcm-v22-runtime` and `first-external-agent-alert` the `finally` belongs to a
`Promise.race` timeout and a `fetch` abort respectively — **not** to a reschedule site. Two
components were about to be given a clean bill of health on evidence that measured something
else.

They are marked **unverified** rather than guarded, because "I have not checked" and "I
checked and it is fine" must not be recorded as the same thing. Only
`external-posting-watcher` was read line by line and genuinely wraps its await in
`try/catch` before rescheduling.

That is the identical failure this document is about, committed while writing it: a check
that looks like it covers the thing, and does not.

## 2. The consequence nobody would diagnose

Five of the nine are **ingestion** schedulers. If one dies, its source stops producing jobs.
If several die, the board empties.

**An empty board is indistinguishable from no demand.** An agent arrives, finds nothing
worth claiming, and leaves. The funnel records `browsed` and no conversion. We would read
that as a market signal and act on it — exactly the wrong conclusion, drawn confidently,
from a dead timer.

That is the same failure mode as the funnel measuring one door: a broken measurement that
produces a plausible story. We spent today learning how expensive those are.

## 3. The rule

**A component is not healthy because its loop is running.**

Health must assert an *outcome*, not merely liveness. Concretely, for every scheduled
component:

1. **The reschedule must be unconditional.** Put the `setTimeout` in a `finally`, so it
   fires whether the run succeeded, threw, or timed out. A run may fail; the loop may not.
2. **Bound the run.** An await with no timeout is an unbounded hang; the loop cannot detect
   the difference between slow and dead.
3. **Publish liveness with a staleness bound.** `lastRunFinishedAt` plus a
   `staleAfterMs` derived from the interval, degrading health on its own — the pattern
   #1057 introduced. Do not require a backlog to accumulate before anyone notices.
4. **Publish the failure count and the last error.** `consecutiveSchedulerFailures` and
   `lastSchedulerError`, so "running but failing every tick" is visible as such.
5. **Skipping is not success.** A component that skips the same work every tick for the
   same reason is failing with a green badge. That is precisely how a dead payout queue
   reported `ok: true` for hours on 2026-08-11.

Rules 1–4 are mechanical and belong in a shared helper. Rule 5 is per-component and is the
one that actually caught nothing today.

## 4. Do it once, not fourteen times

These loops are near-identical. Extract the pattern into one scheduler helper carrying the
guard, the timeout, the staleness readout, and the failure counters — then have each
component supply `runOnce` and its own answer to rule 5.

Fourteen bespoke copies is how one fix left nine instances behind. A shared helper means
the next fix lands everywhere at once, and the next new scheduler inherits it rather than
re-deriving it.

`submitted-job-auto-verifier` already has the corrected shape from #1057 and is the
reference implementation; the helper should be extracted from it rather than designed
afresh.

## 5. Priority

Not all nine are equal.

- **First:** the five ingestion schedulers and `job-stale-sweeper`. These fail into
  *plausible* states — an empty board, jobs stuck in claimed — that get misread as market
  signal rather than as an outage.
- **Then:** `recurring-scheduler`, `external-poster-review-escalator`,
  `upstream-status-poller`, `bootstrap-self-report-scheduler`. These fail into states that
  are noticed eventually, by someone wondering why a thing stopped.

Order by *how convincing the wrong story is*, not by how important the component sounds.

## 6. What this does not cover

- Components that are running and correct but reading the wrong thing — the D-03 artifact
  mapping, the funnel's single door, `totalEarned` reading a rotating catalogue. Those are
  the same family (green while blind) but need per-case fixes, not a scheduler helper.
- Whether any of the nine has *already* died. This audit read code, not production. Worth
  checking `lastRun` for each once the staleness readout exists — and worth assuming
  nothing until it does.
