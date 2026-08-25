# PACKET — A gate is a permission, not an observation

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR, copy and one
derivation fix. No contract change, no gate-economics change.

**Priority: this is live and wrong on a money surface right now.**

## The finding

At 14:41Z the venue recall completed: cost basis 0, deployment 3 closed,
`managedAssets` 0, nothing deployed anywhere. `/pool` currently serves both of
these in the same payload:

```
lockedDeposits.activationGate.yieldStatusText
  "NAV share active — the locked cohort satisfies the automatic activation gate."

yieldStatus       "not_yet_earning"
venueMark.status  "not_deployed"
```

The locked-deposit surface tells a depositor their cohort has an **active NAV
share**. Nothing is deployed. Nothing is earning. The statement facing
depositors is the false one.

## Root cause — the defect worth naming

`mcp-server/src/services/locked-tier-service.js:172` selects that text on
`open`:

```js
yieldStatusText: open
  ? "NAV share active — the locked cohort satisfies the automatic activation gate."
  : LOCKED_TIER_YIELD_INACTIVE_TEXT
```

`open` is the **activation gate**, which answers *"does this cohort qualify for
deployment?"* — a permission. It does not answer *"is capital deployed and
earning?"* — an observation. The copy conflates the two, so the moment the gate
opened (2026-08-25) the surface began claiming activity that never existed.

The sibling module already states the correct rule, in a comment, and follows
it — `deposit-pool-yield-status.js` derives from deployed principal:

> *"The chain fact is deployed principal, not a release flag: zero means no
> capital is earning."*

`depositPoolYieldStatus` is **correct and should not change.** The locked-tier
service simply reads the wrong input.

## What to change

**A — Derive locked-tier yield text from deployed principal, not the gate.**
The gate and deployment are independent facts and the surface must express
both. Gate open with nothing deployed is a real, expected, honest state:
*eligible, not deployed.* It needs its own wording, not the active one.

Keep `activationGate.status`/`open` exactly as they are — the gate reporting
`open` is correct and load-bearing. Only the yield claim moves.

**B — Stop implying deployment is imminent.**
`DEPOSIT_POOL_YIELD_NOT_EARNING_TEXT` says deployment "is a pending operator
ceremony." That was true this morning. Under **D3** (ratified 2026-08-25) the
venue lane is closed: `deployToVenue` hard-caps epochs at `NOTICE_7_DAYS` while
break-even needs ~35.5 days, so redeployment is structurally loss-making until
TVL reaches ~62 USDC deployed or the cap is amended. "Pending" reads as
about-to-happen. Say what is true: capital is home, and deployment is not
scheduled.

Do not overcorrect into promising it will never happen — it reopens on either
condition above. State the condition, not a date.

## Non-negotiables (each pinned by a test)

1. **Gate open + zero deployed principal produces the eligible-not-deployed
   wording**, never the active one. Assert the exact served string.
2. **A mutation proves the binding**: with the gate open, moving deployed
   principal 0 → positive must change the text, and only that input changing
   must change it. A test that only asserts today's output would have passed
   before this bug and after it.
3. **No surface claims active yield while deployed principal is zero** —
   assert across the locked-tier payload and `/pool` together, since the defect
   was that two parts of one payload disagreed.
4. `depositPoolYieldStatus`, the activation gate's own economics, thresholds,
   and `activationGate.status` are **unchanged**.
5. Consent text is **untouched** — the venue-exposure sentence is load-bearing
   under the ratified deployment memo and must not be weakened while we are
   between venues.

## Out of scope

Contract changes, activation-gate economics, per-wallet caps, consent text, the
deposit gate shipped in #1287, and anything that would deploy capital.

## Related

`PACKET_LOCKED_CAPITAL_DEPLOYMENT.md` is **shelved** by D3 — it builds the
mechanism to deploy locked capital to a venue we have deliberately closed. Do
not implement it. See `RUNSHEET_VENUE_RECALL_V2.md` for the executed recall and
the D1–D3 decisions.

## Handback requirements

PR number; green CI; the mutation test name and what it mutates; the exact
served strings for both states (gate open + zero deployed, and gate open +
positive deployed); and confirmation that gate economics, `activationGate.status`,
and consent text are unchanged.
