# PACKET — The repo carries an indexer schema name that is actively wrong

Status: READY FOR CODEX · 2026-08-30 · Author: Claude (architect+gate) ·
Repo: **platform** · One PR. **No contract changes.**
**Supersedes my earlier diagnosis** in `PACKET_INDEXER_SCHEMA_ROTATION.md`,
which blamed a floating Ponder version. That was wrong — the deploy log shows
the app identity **matched** the last-good owner. #1322 (lockfile, `npm ci`,
version-aware identity) is still worth having, but it did not address this.

## The actual chain

```
deployments/mainnet.json  runtime.indexer.schema = agent_indexer_mainnet_20260725131847   (25 Jul)
        |  render-mainnet-backend-env.mjs  (DATABASE_SCHEMA: indexer.schema)
        v
deploy/indexer.mainnet.env.template        DATABASE_SCHEMA=agent_indexer_mainnet_20260725131847
        |  op inject at deploy
        v
/run/agent-stack-mainnet/indexer.env       ← reset to the 25 Jul value on EVERY deploy
        |  deploy script re-applies the persisted override
        v
host state                                 agent_indexer_mainnet_20260823202107_6e0da0fd  (23 Aug)
```

**A schema rotation on 23 August recorded itself only on the host.** The
manifest still names the 25 July schema, so every render writes a value that is
known-wrong and must be corrected by a later step in the same deploy.

On 2026-08-30 that later step did not complete, the container started on the
25 July schema, and Ponder refused it as *"previously used by a different
Ponder app."* The indexer crash-looped for roughly an hour.

## Why this is the real defect

**The repo contains a value that is actively false about production**, and the
truth lives only in host-local state that nothing in version control can see.
Everything downstream is then a race between writing the wrong value and
correcting it. Today the correction lost.

It also silently breaks the usual guarantee that a fresh host, rebuilt from the
repo, reproduces production — a rebuild would come up on the 25 July schema.

## DECISION — RATIFIED 2026-08-30 (Pascal): option B, drop it from the repo

**A — Rotation writes back to the repo.** A schema rotation produces a change
to `runtime.indexer.schema`, so the manifest stays true. One source of truth,
but a deploy-time event now has to become a commit.

**B — Remove the schema from the manifest and template entirely.** Host state
becomes the only source, and the render stops emitting a competing value it
cannot know. Needs a bootstrap path for a host with no persisted state (mint a
fresh schema rather than inherit a stale literal).

**RATIFIED: B.** Remove `runtime.indexer.schema` from the manifest and
`DATABASE_SCHEMA` from the rendered indexer template. Host state is already
authoritative — it is what the running container claimed — and a weaker second
copy in the repo buys nothing except the chance to be wrong.

**Accepted costs, stated plainly so nobody is surprised later:**

1. **The repo will no longer record which schema production runs.** That fact
   lives only on the VPS. Anyone debugging from a checkout must read host state
   to know it. Document where.
2. **A rebuilt host re-syncs from scratch** rather than adopting the existing
   schema, because it has no persisted state to inherit and must mint fresh.
   That is a full historical re-sync, and it is the price of never rendering a
   wrong value.

## Regardless of A or B — fail closed on disagreement

If a rendered `DATABASE_SCHEMA` and the persisted override disagree, the deploy
must **say so loudly** and refuse to start a container on the rendered value.
Silent correction is what let this hide; the same deploy both wrote the wrong
value and fixed it, so nothing ever surfaced until the fix step was skipped.

## Non-negotiables (each pinned by a test)

1. A container is never started on a schema that disagrees with persisted state
   without an explicit operator override.
2. A host with no persisted schema mints a fresh one; it does not inherit a
   stale literal from the manifest.
3. `--check` on the generator still fails on a genuinely stale template.
4. Existing rotation reasons and the persisted-schema rollback path are
   unchanged.
5. No other component's deploy behaviour changes.

## Handback

PR number; green CI; the chosen option with reasoning; the test names; and
confirmation of what a brand-new host does on first deploy.
