# PACKET — #1368 did not repair the index: production runs one provider, and Ponder's sync cache replays the hole

Status: ready for implementation. One small PR plus one operator deploy. Follow-on to #1368.

## What I verified after #1368 deployed (2026-09-11, `deployedSha 0d469e7c`)

The deploy rotated the schema (`agent_indexer_mainnet_20260911114228_ecb245ea`,
"INDEXER HISTORICAL RE-SYNC STARTING" at 11:42Z) and the index is synced at
head 20526787. **The three claim events of block 20501734 are still missing**
(`jobEvents` for job `0x0620927a…` holds only `JobCreated`/`JobFunded` at
20501730). Two independent reasons, both verifiable from the repo and the log:

1. **Production configures exactly one provider.** `deploy/indexer.mainnet.env.template`
   sets only `DWELLER_RPC_URL`; `RPC_URL`, `RPC_BACKUP_URLS` and `POLKADOT_RPC_URL`
   are absent, so `resolveIndexerRpcUrls` returns `[DWELLER]`. With one provider
   the transport, by its own test, "neither cross-checks nor guards differently":
   no second `eth_getLogs` answer to compare, no provider to fall through to. The
   #1368 code is correct and idle.
2. **A schema rotation replays the app, not the fetch.** Ponder keeps its raw
   chain cache in the shared `ponder_sync` schema (`sync-store`: `intervals`
   keyed by filter fragment). A fresh `DATABASE_SCHEMA` re-runs the indexing
   functions over cached data and fetches only intervals the cache lacks
   ("Skipped fetching backfill JSON-RPC data (cache contains all required
   data)"). The hole was cached as fetched during the earlier DWELLER-only
   sync, so the 11:42Z replay served it again without touching any RPC. That is
   also why "replay ≈ 5 min" has always been true: it was never a refetch.

Ponder's historical sync only fetches a block when a log filter names it, so
DWELLER's empty `eth_getLogs` answer means block 20501734 was never fetched
and the block guard never ran. Silent, exactly as #1368 described.

## The fix

**PR (small):**
- `deploy/indexer.mainnet.env.template` (and the base template): add
  `RPC_BACKUP_URLS=https://eth-rpc.polkadot.io` so the indexer runs
  `[DWELLER, eth-rpc]`. DWELLER stays primary for throughput; the cross-check
  compares both on every `eth_getLogs`, and the block guard has somewhere to
  fall through to. Regenerate the mainnet template; note these keys are not
  `PONDER_*`, so they do **not** rotate the schema by themselves.
- A one-shot operator script `scripts/ops/indexer-sync-cache-reset.sh` that,
  against the indexer Postgres, drops `ponder_sync` (or, if a bounded
  invalidation of `intervals` for a block range is straightforward in this
  Ponder version, offers `--from-block/--to-block`), prints what it dropped,
  and refuses to run unless `INDEXER_FRESH_SCHEMA=1` is the next deploy — the
  cache reset and the fresh schema must land together.
- Docs: `INCIDENT_RESPONSE.md` gets the true replay model (cache vs fetch) and
  this runbook; the "replay ≈ 5 min" wording everywhere is corrected to
  "≈ 5 min from cache; a cache reset is a full refetch".
- Pins: `resolveIndexerRpcUrls` with the production template yields two URLs
  (mutation: drop the backup — fails); the reset script refuses without the
  fresh-schema flag (mutation: remove the guard — fails); the hosted smoke's
  sync-liveness check stays as #1368 left it.

**Operator deploy (after the PR merges):** run the cache reset on the VPS, then
dispatch the production deploy with `indexer_fresh_schema=1`. Expect a full
historical refetch from block 18 647 521 through both providers (hours, not
minutes — the deploy already keeps `/ready` staged and `/health` 200 during a
re-sync; `/credit`'s receipt graph reports `indexer_stale` by design until
catch-up). Do it at a quiet hour.

**Verification (the test is the incident):** after catch-up,
`jobEvents(where: {jobId: "0x0620927a89b58abf91831d8a83efd5de2d78877f5b00af1cc88c7b569aae9481"})`
lists the three claim events at 20501734, and `docker logs agent-mainnet-indexer`
carries at least one `[indexer-rpc] … omitted 3 log(s) … 20501734` line naming
DWELLER. Paste both.

## Residual (unchanged from #1368)

A hole shared by both providers stays invisible; the periodic two-provider
completeness audit remains the follow-up in the threat model.
