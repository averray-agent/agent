# Indexer schema ownership and recovery

Ponder records the app build that first claimed a PostgreSQL schema. Reusing
that schema after the indexer app changes produces a `MigrationError` before
the service binds `/health`. A deploy must therefore choose the schema before
it recreates the container.

## Normal deploy behavior

`scripts/ops/deploy-production.sh` is the only supported indexer deployment
entrypoint. It:

1. Holds the production deploy lock and the host-wide
   `/tmp/averray-indexer-schema.lock`.
2. Computes the incoming app identity from the committed `indexer/` Git tree.
3. Compares it with the identity that last deployed successfully.
4. Reuses the persisted schema when the identity matches.
5. Mints a unique, network-scoped schema when the identity changed, then
   recreates the indexer.
6. Requires `/health` to remain stable for at least 15 seconds. A rotation
   deliberately leaves `/ready` staged while historical indexing catches up.
7. Persists the new schema and owner identity only after the health gate
   succeeds.

The state files are outside the checkout under `$DEPLOY_STATE_DIR`:

- `indexer.database-schema.<network>` — last-good schema
- `indexer.app-identity.<network>` — Git tree that owns it
- `indexer.resync.<network>` — auditable re-sync-start record, including the
  initial staged status, source SHA, actor, reason, previous schema, and start
  time. It is historical evidence, not the current catch-up signal.

An identity change prints `INDEXER HISTORICAL RE-SYNC STARTING` as a workflow
warning. During that window the backend's
`capabilityHealth.externalPostingWatcherLagSeconds` remains the truth signal:
the external-posting watcher derives it from the indexer's finalized block
timestamp and stays `staged` until both `caughtUp` is true and lag is within
budget. Do not suppress that degradation.

`scripts/ops/redeploy-indexer.sh` rejects direct invocations that lack the
wrapper's ownership preflight. Use:

```sh
RUN_INDEXER=1 scripts/ops/deploy-production.sh
```

If a replacement fails health, rollback restores the exact last-good schema
before it recreates the previous image. The candidate schema/identity are not
recorded as last-good.

## Explicit recovery controls

Normal app-identity changes rotate automatically. The workflow inputs remain
available for an operator-directed recovery:

- `indexer_fresh_schema=1` mints a never-used schema.
- `indexer_database_schema=<name>` selects an explicit never-used schema.

The deploy refuses an explicit schema that is already associated with the
previous app when the identity changed.

## Retiring stale schemas

Cleanup is deliberately manual because `DROP SCHEMA ... CASCADE` is
destructive. Wait until the new indexer is caught up, the watcher is current,
and a database backup exists.

First record the active schema and list candidates:

```sh
sudo awk -F= '/^DATABASE_SCHEMA=/{print $2}' /run/agent-stack-mainnet/indexer.env
docker exec agent-postgres psql -U agent -d agent -c \
  "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'agent_indexer_%' ORDER BY schema_name;"
```

For every candidate, confirm it is not the active schema and is not named in
either network's `indexer.database-schema.*` state file. Then inspect its size:

```sh
docker exec agent-postgres psql -U agent -d agent -c \
  "SELECT pg_size_pretty(sum(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename)))) FROM pg_tables WHERE schemaname = '<stale_schema>';"
```

Only after a named operator reviews those checks, drop one explicitly:

```sh
docker exec agent-postgres psql -U agent -d agent -c \
  'DROP SCHEMA "<stale_schema>" CASCADE;'
```

Never put schema deletion in the deploy path or a retention timer.
