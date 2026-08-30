# PACKET — Tier perks put a chain read in the signed-in balance path

Status: **READY FOR CODEX — P1, a signed-in surface is broken** · 2026-08-30 ·
Author: Claude (architect+gate) · Repo: **platform, mcp-server** · One PR.
**No contract changes.** Reported by QA on SHA `2627e0aa`.

## Symptom

Signed-in `/work-withdraw/` shows **"Retry balance read"** / **"Unavailable"**
instead of the live balance. `WorkWithdrawal.tsx:30` fetches
`/account/position?asset=USDC`; line 127 renders the retry button on
`accountQuery.error`, line 129 renders "Unavailable" when the value is empty.

## Cause — high confidence, not yet reproduced signed-in

`/account/position` is served by the earnings door, which calls
`workerExposurePolicy.capacityForWallet(wallet)`
(`earnings-door.js:516–519`). That now reaches
`worker-exposure.js:234`:

```js
const tierPerks = await this.tierPerksPolicy?.forWallet?.(wallet, {
  defaultOpenExposureCapRaw: this.capUnits.toString()
});
```

**There is no try/catch around it**, and `forWallet` performs a **live reward-
bank read**. #1313 introduced it; #1314 enabled it on mainnet. So a throw, a
slow chain read, or an RPC hiccup now fails a signed-in balance response.

Before #1313 this path was local computation plus a vesting lookup. **A network
dependency was added to a hot read-only path without a failure mode.**

## What to build

**A — Contain the failure.** Wrap the `tierPerks` call so *any* failure —
throw, rejection, timeout — degrades to `this.capUnits` (the legacy cap), which
is precisely what "fail closed" means here: the worker keeps their existing
allowance and the page still renders. **A perks lookup must never be able to
prevent someone reading their own balance.**

**B — Bound the wait.** Give the lookup an explicit timeout well under the
page's tolerance, and degrade on expiry rather than hanging. The reward-bank
provider caches, but a cache miss is still a live chain read on a user request.

**C — Say when it degraded.** When perks are unavailable, the response should
carry a named indicator (the way other surfaces expose a reason code) so this
is visible in logs rather than silently serving legacy caps forever.

## Non-negotiables (each pinned by a test)

1. A `tierPerksPolicy.forWallet` that **throws** still yields a successful
   position response using the legacy cap — proven by mutation.
2. A `forWallet` that **hangs** is bounded and degrades; the response does not
   wait on it indefinitely.
3. The degraded path returns the **same** cap a pre-#1313 deployment returned —
   perks failing must never *reduce* an existing allowance.
4. When perks resolve normally, behaviour is unchanged from today.
5. No change to the perk values themselves, the bank-linked formula, or the
   floor.

## Note on the flag

`NON_YIELD_TIER_PERKS_ENABLED` can be set to `false` as an immediate mitigation
if the page must be restored before this lands. That is a rollback, not a fix —
and it would also disable the caps ladder we just shipped, so prefer landing A
and B quickly.

## Handback

PR number; green CI; the five test names; and confirmation that a signed-in
`/account/position` succeeds with the perks policy forced to throw.
