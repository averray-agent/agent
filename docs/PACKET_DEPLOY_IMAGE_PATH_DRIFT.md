# PACKET — Files ship in the backend image but do not trigger its rebuild

Status: **SHIPPED — #1321 merged 2026-08-30 (its node dependency then blocked deploys; fixed by #1324)** ·
2026-08-30 · Author: Claude (architect+gate) · Repo: **platform** · One PR.
**No contract changes.**

## What happened

PR #1320 merged and its production deploy (`ed1610b6`, 12:38–12:40Z) reported
**success**. The backend container was never recreated — it still dated from
11:21:00Z, the #1319 deploy. Running the fixed script produced the *pre-fix*
error at the *pre-fix* line numbers, and
`docker exec … grep -c runDepositLegPlan` returned **0**.

**Root cause.** `scripts/ops/deploy-production.sh:1979` gates the backend on:

```
^(mcp-server/|witness/|sdk/|examples/|docs/schemas/|package(-lock)?\.json
 |scripts/ops/redeploy-backend\.sh|deploy/…|deployments/(testnet|mainnet)\.json)
```

`scripts/ops/pool-venue-dispatch.mjs` matches none of it. But
`mcp-server/Dockerfile` now `COPY`s **five** files out of `scripts/ops/`:
`ceremony-module-loader.mjs`, `ceremony-rpc.mjs`, `pool-venue-ceremony.mjs`,
`capture-bank-xcm-v22-staging-quote.mjs`, `pool-venue-dispatch.mjs`.

Those COPY lines were added by #1317 and #1318 **without adding their paths to
the rebuild trigger**. So a change confined to any of them deploys green and
never reaches the container. #1319 only worked by luck: it happened to touch
`mcp-server/src/`.

This is the dangerous shape — not a failure, a **silent success**.

## What to build

**A — Make the trigger cover what the image ships.** The backend pattern must
include every path the Dockerfile copies. Prefer **deriving** it from the
Dockerfile over hand-maintaining a second list; a hand-copy is what drifted in
the first place.

**B — Pin the class, not the instance.** `check-dockerfile-deployments.test.mjs`
already fails when `src` reads a path the image does **not** ship. Add the
inverse: **every path the Dockerfile `COPY`s must match the backend rebuild
pattern.** That is the test that would have caught this and will catch the next
COPY someone adds.

## Non-negotiables (each pinned by a test)

1. A change to any Dockerfile-copied `scripts/ops/*` file triggers a backend
   rebuild.
2. The inverse test fails when a `COPY` path is not covered by the pattern —
   proven by mutation (add a COPY, assert the test fails).
3. Existing triggers are unchanged; nothing that rebuilt before stops
   rebuilding.
4. No component other than the backend changes behaviour.

## Immediate operational note

The stranded ceremony is unblocked without this PR by forcing the component:

```
gh workflow run deploy-production.yml --ref main -f components=backend
```

That is a workaround for today, **not** the fix. Until A and B land, every
ceremony-script change carries the same silent-staleness risk.

## Why this one matters more than it looks

A deploy that fails is safe — you retry it. A deploy that **succeeds while
leaving old code running** breaks the assumption every later step rests on. We
spent a full cycle diagnosing a "fixed" bug that was never deployed, and the
only reason we caught it was that the error line numbers had not moved.
