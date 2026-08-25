# PACKET — Payout-evidence cross-check: a failed run must not consume the success interval

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **reference-agent (slack-operator)** · One PR, small.

## The live symptom

The board reads, right now:

> `cross-check could not run — payout evidence unverified — log read failed
> (eth_chainId → RPC endpoint throttled (HTTP 429)) · CROSS-CHECK OVERDUE`

The primary proof is CONFIRMED; it is the **second-provider agreement** that
has stopped happening. Both endpoints answer HTTP 200 in ~0.1s from outside,
so this is the VPS's own IP being rate-limited on the public endpoint —
which our backend also uses as RPC failover.

## The bug

`payout-crosscheck-cache.ts` gates re-runs on one clock:

```
if (lastRunAtMs !== null && nowMs - lastRunAtMs < intervalMs) return;   // 7 days
...
} finally {
  lastRunAtMs = nowMs;   // set even on failure
}
```

`intervalMs` is **7 days**; `CROSSCHECK_OVERDUE_MS` is **10 days**. So a
single transient 429 marks the attempt as "run" and blocks any retry for a
week. Two consecutive throttles put the last agreement past 10 days and the
check reports overdue — permanently, until someone notices by eye.

The `finally` block's comment is right about the danger it was defending
against ("a provider that is down must not be retried every heartbeat") —
it just used one interval for two different facts.

## The fix

Separate the two clocks. **A successful comparison** resets the long
interval; **a failed attempt** schedules a short retry.

1. Track `lastSuccessAtMs` (a completed comparison, agree *or* disagree —
   both are real answers) and `lastAttemptAtMs` separately.
2. Re-run when `nowMs - lastSuccessAtMs >= intervalMs` **or** when the last
   attempt failed and `nowMs - lastAttemptAtMs >= retryIntervalMs`.
3. `retryIntervalMs` default **30 minutes**, with exponential backoff on
   consecutive failures capped at the 7-day interval — so a genuinely dead
   provider still is not hammered, while a transient throttle recovers the
   same hour.
4. Reset the backoff on any successful comparison.

## Second half: throttling is its own fact

A 429 is not the same as "the providers disagree" or "the chain is
unreadable", and the board should not have to infer it from a message
string. Add a distinguishable reason so the rendered line can say
`throttled — retrying in Nm` rather than the generic could-not-run text.
Keep `decideCrossCheck`'s existing statuses; this rides in the reason field
the view already renders.

**Do not** change `CROSSCHECK_OVERDUE_MS`, and do not soften the overdue
state. An overdue cross-check must keep reporting overdue — the point of
this fix is that it should stop *becoming* overdue for a transient reason,
not that overdue should be quieter.

## Non-negotiables (each pinned by a test)

1. **A failed attempt does not consume the success interval**: fail at T,
   then at T+31min a retry is attempted (today: nothing until T+7d).
2. **Backoff is bounded**: N consecutive failures never schedule retries
   faster than the previous one, and never slower than `intervalMs`.
3. **Success resets everything**: one successful comparison clears the
   backoff and restarts the 7-day clock.
4. **Disagreement is a success, not a failure** — providers that disagree
   have answered; that must reset the attempt backoff while the *verdict*
   stays `disagree`. This distinction is the point of the packet: a broken
   check and a check that found a problem are opposite facts.
5. **No hammering**: with a provider that always fails, the number of
   attempts in a simulated week stays bounded (assert an explicit ceiling).
6. Existing cross-check tests pass unchanged.

## Out of scope

Changing which providers are used, adding an API key or a paid endpoint,
touching the primary payout proof (it is CONFIRMED and not part of this),
any change to `decideCrossCheck`'s status vocabulary, retry logic anywhere
else in the monitor.

## Handback requirements

PR number; green checks; the names of the five behaviour tests; the chosen
retry default and backoff curve; and a one-line statement of what the board
will render while a throttle is being retried.
