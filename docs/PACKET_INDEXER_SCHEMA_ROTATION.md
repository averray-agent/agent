# PACKET — The indexer rotates on our identity, but Ponder judges on its own

Status: READY FOR CODEX · 2026-08-30 · Author: Claude (architect+gate) ·
Repo: **platform** · One PR. **No contract changes.**

## What broke

The 2026-08-30 forced deploy left `agent-mainnet-indexer` crash-looping:

> `MigrationError: Schema "agent_indexer_mainnet_20260725131847" was previously
> used by a different Ponder app.`

Health has carried `indexer_unavailable` since ~12:53Z. `/pool`, `/jobs` and
the site stayed 200 — this degrades the ops board and derived views, not the
money path.

## Root cause — two facts that only bite together

1. **`indexer/package.json` declares `"ponder": "^0.16.6"` and `indexer/` has
   no committed lockfile.** Every image build re-resolves the tree and may pull
   a newer patch. Ponder's app identity includes its own version.
2. **`indexer_app_identity()` hashes only `indexer_tree` + `ponder_config`.**
   The resolved Ponder version is not an input.

So Ponder's notion of "same app" and ours disagree. A floated patch changes
Ponder's identity while ours is unchanged, no rotation fires, and the container
refuses to start. **`indexer_fresh_schema=1` clears it today and it recurs on
the next rebuild that floats the version.**

## What to build

**A — Make indexer builds reproducible.** Commit a lockfile for `indexer/` so
an image rebuild resolves the same tree. This is the fix that stops the
recurrence. (Note the standing constraint: the *root* lock is immovable and
does not describe the indexer container, which resolves its own tree — so this
lockfile is genuinely new, not a duplicate of the root one.)

**B — Make rotation trigger on what Ponder actually judges.** Add the resolved
Ponder version to `indexer_app_identity()`. Then a deliberate upgrade rotates
the schema automatically instead of crash-looping. **A and B are complementary:
A stops accidental drift; B handles the intentional upgrade.**

**C — Fail legibly.** If the indexer refuses on a schema-ownership error, the
deploy should name that specific cause and point at `indexer_fresh_schema=1`,
rather than surfacing a wall of repeated `uncaughtException` lines.

## Non-negotiables (each pinned by a test)

1. A changed resolved Ponder version produces a different
   `indexer_app_identity` and triggers rotation.
2. An unchanged tree, config **and** resolved version does **not** rotate —
   rotation stays rare, since it forces a full historical re-sync.
3. The indexer build resolves deterministically from the committed lockfile.
4. Existing rotation reasons and the persisted-schema rollback path are
   unchanged.
5. No other component's deploy behaviour changes.

## Out of scope

Upgrading Ponder, changing the indexer's schema definition, and the backend
rebuild-trigger fix (that is #1321).

## Handback

PR number; green CI; the test names; the committed lockfile's resolved Ponder
version; and confirmation that rotation still does **not** fire when nothing
changed.
