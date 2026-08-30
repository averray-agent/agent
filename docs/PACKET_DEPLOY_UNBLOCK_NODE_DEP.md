# PACKET — #1321 blocks every deploy: the host has no `node`

Status: **READY FOR CODEX — PRODUCTION DEPLOYS ARE FULLY BLOCKED** ·
2026-08-30 · Author: Claude (architect+gate) · Repo: **platform** · One PR.

## What happened

#1321 derives the backend rebuild pattern by invoking
`scripts/ops/backend-image-rebuild-pattern.mjs`. The deploy script runs on the
**VPS host**, which has no `node` — everything there runs in containers:

```
./scripts/ops/deploy-production.sh: line 1984: node: command not found
Cannot derive the backend rebuild trigger from mcp-server/Dockerfile;
refusing a potentially stale deploy.
```

**The fail-closed behaviour is correct and did its job** — it refused rather
than deploying with an empty matcher. But the feature cannot run at all on the
host, so **every deploy now fails**, including the ones needed to fix the
indexer.

My gate missed this: I verified the derivation worked in a repo worktree with
node available, and never asked whether the runtime that executes
`deploy-production.sh` has a node binary. **A script that runs on the host must
only depend on what the host has.**

## Fix — derive in shell, not node

Parse the `COPY` sources out of `mcp-server/Dockerfile` with `grep`/`sed`/`awk`
inside `deploy-production.sh`. The inputs are literal `COPY <src> <dst>` lines;
this needs no JavaScript.

**Keep everything else from #1321:**

- the pattern is still **derived** from the Dockerfile, never hand-maintained
- it still **fails closed** if derivation yields nothing
- the inverse test still fails when a `COPY` path is not covered

The `.mjs` module may stay for the **test** to import (CI has node); the
**deploy path** must not shell out to it.

## Non-negotiables (each pinned by a test)

1. The deploy derives the pattern with no `node` on `PATH` — prove it by
   running the derivation with `PATH` stripped of node.
2. The derived pattern still covers all five copied `scripts/ops/*` files and
   preserves every original trigger.
3. Derivation yielding an empty result still fails closed.
4. The inverse Dockerfile-coverage test still catches a new uncovered `COPY`.

## Why not simply revert

Reverting restores deploys but reinstates the silent-staleness bug that let
#1320 report success while leaving old code running — the defect that cost a
full diagnostic cycle today. **Fix forward if it can land quickly; revert only
if it cannot**, since a blocked deploy is loud and a silent stale one is not.

## Handback

PR number; green CI; the four test names; and the exact derived pattern string
produced by the shell implementation, so it can be diffed against the node
one.
