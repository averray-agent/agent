# PACKET — T90 perks must not flicker on a single failed credit read

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR, small.

## Observed in production

Minutes after the first locked deposit (T90, 25 USDC, 2026-08-24T14:27Z),
`/me` reported:

```
tier: "flex", contractualTier: "t90", priorityRank: 0,
perksActive: false, perksSuspendedReason: "credit_position_unavailable"
```

Three samples later it read `t90 / rank 2 / perksActive true` with no
change on the depositor's side. The suspension was a **single failed credit
read** during a container restart.

## Why it happens

`getWalletState` suspends T90 perks when the credit position is unreadable:

```
const t90Suspended = highest?.tier === "t90" && (creditOutstanding || !creditPositionReadable);
```

and the reader turns any thrown error into `{available: false, reason:
"credit_pool_read_failed"}`. So one RPC hiccup drops a depositor from their
paid-for tier to Flex, rank 0, until the next read succeeds. Nothing is
persisted wrongly — but what the depositor *sees* is their tier vanishing.

## The rule this must not break

Ladder memo **L7** is a safety property: T90 perks fail closed while we
cannot prove no outstanding credit draw. **Do not delete that.** The fix is
narrower — a recent successful read *is* proof: a draw cannot appear without
an on-chain transaction, so a credit position read 90 seconds ago showing
zero debt remains meaningful evidence about now.

## The fix

A bounded grace window on the readability check only.

1. Cache the last **successful** credit read per wallet: its
   `outstandingDebtRaw` and its timestamp.
2. When a fresh read fails, and a cached successful read exists that is
   younger than `CREDIT_READ_GRACE_MS` (default **5 minutes**, env-settable
   downward only, hard ceiling in code at 15 minutes), evaluate perks
   against the cached value.
3. Past the grace window, suspend exactly as today —
   `perksSuspendedReason: "credit_position_unavailable"`, unchanged.
4. A cached read showing an **outstanding draw** suspends immediately; the
   grace only ever preserves a proven-clean state, never a proven-dirty one.
5. Surface the staleness rather than hiding it: while perks are held open on
   a cached read, the state carries `creditReadStaleSeconds` so a UI can say
   "perks active · credit read 90s stale" instead of pretending freshness.

## Non-negotiables (each pinned by a test)

1. **Fail-closed survives**: no cached read, or a cached read older than the
   ceiling ⇒ perks suspended with today's reason string.
2. **Dirty never gets grace**: a cached read with `outstandingDebtRaw > 0`
   suspends immediately even inside the window.
3. **One hiccup does not flicker**: successful read → failed read 60s later
   ⇒ perks stay active, with `creditReadStaleSeconds` set.
4. **The ceiling is not config-raisable** — same discipline as the
   locked-tier per-wallet cap: env may lower it, code caps it.
5. **Lock creation is untouched.** `#assertNoOutstandingCredit` on the
   quote/consent path still requires a *live* readable position — creating a
   lock on stale evidence is a different risk from displaying perks, and it
   stays strict. A test asserts creation still refuses when the read fails.

## Out of scope

The activation gate, priority-window behaviour, credit origination, any
change to what perks *are*, caching any other read.

## Handback requirements

PR number; green CI; the five test names; the chosen default and ceiling;
and confirmation that lock creation still fails closed on an unreadable
credit position.
