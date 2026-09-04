# PACKET — The pair-deploy script has no bytecode to deploy

Status: **READY FOR CODEX — blocks Ceremony B** · 2026-09-04 ·
Author: Claude (architect+gate) · Repo: **platform** · One PR.
**No contract source changes.**

## The failure

`deploy-venue-pair.mjs` now ships in the backend image (#1336) and runs, but:

```
Could not read HydrationUsdcAdapterV22 artifact at
/app/out/HydrationUsdcAdapterV22.sol/HydrationUsdcAdapterV22.json: ENOENT
```

`out/` is **gitignored** (`.gitignore:10`), the backend image copies **no**
compiled artifacts, and the script defaults to `--artifacts out`. So the deploy
driver exists with nothing to deploy.

Verified by building `origin/main` locally:

| contract | bytecode |
|---|---|
| `HydrationUsdcAdapterV22` | 10,520 bytes |
| `HydrationDepositPoolAdapter` | 9,712 bytes |

Both compile cleanly (`solc 0.8.24`, 49 files, run successful). ~208K of JSON
for the pair.

## What to build

**Bake the artifacts the deploy driver needs into the backend image**, produced
by a build stage rather than committed — `out/` must stay gitignored.

Preferred shape: a Docker build stage that runs `forge build`, then copies only
the two needed JSON files into the runtime image at the path the script already
expects (`/app/out/<Contract>.sol/<Contract>.json`).

**Do not** commit `out/`, and **do not** widen the copy to the whole directory —
ship exactly what the driver names in `CONTRACT_ARTIFACTS`.

## Why not a manual copy

`docker cp` of hand-built artifacts would unblock today and break the next time.
Worse, it makes the deployed bytecode **unattributable** — nobody could later
prove which commit produced the contract now bound permanently to v2.1.
Ceremony B ends in a **set-once** binding; the bytecode must be reproducible
from a known SHA.

## Non-negotiables (each pinned by a test)

1. The image contains both artifacts at the paths `CONTRACT_ARTIFACTS` names —
   assert against the driver's own constant, not a hardcoded copy of it.
2. Adding a contract to `CONTRACT_ARTIFACTS` without shipping its artifact
   fails CI. Same general form as #1336's in-container-scripts guard.
3. `out/` stays gitignored; no build output is committed.
4. The artifacts in the image match a `forge build` of the same commit — record
   the bytecode hash in the image or the evidence so a deployed pair is
   attributable to a SHA.
5. The image's other contents are unchanged; no new runtime dependency (forge
   must not be needed at runtime, only at build).

## Sequencing note

The rebuild trigger derives from the Dockerfile's `COPY` lines (#1324), so
adding these copies also makes contract changes rebuild the backend — which is
correct, and worth confirming in the handback rather than discovering later.

## Handback

PR number; green CI; the five test names; confirmation that
`docker exec agent-mainnet-backend node scripts/ops/deploy-venue-pair.mjs
--profile mainnet --expected-signer 0x5a6836c6… --use-kms` reaches a printed
plan; and the bytecode hashes with the SHA that produced them.
