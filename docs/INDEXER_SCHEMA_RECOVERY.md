# Ponder schema identity recovery

The production indexer is derived state. Its PostgreSQL schema may be rebuilt
from chain events, but backend and public schemas are never recovery targets.

`scripts/ops/redeploy-indexer.sh` has one automatic schema-recovery case: the
exact Ponder `MigrationError` stating that the configured schema was previously
used by a different Ponder app. The schema named in the error must equal the
runtime `DATABASE_SCHEMA`. Other migration, database, application, and health
failures follow the normal rollback path.

For that exact mismatch the deploy:

1. creates a custom-format, schema-only `pg_dump` under
   `/srv/agent-stack/backups/postgres/`;
2. validates the archive with `pg_restore --list`;
3. leaves the previous schema unchanged;
4. persists a fresh `agent_indexer_<UTC timestamp>` schema in deploy state;
5. restarts the single Compose indexer service and applies the normal health,
   readiness, and smoke gates.

If backup creation or validation fails, no schema switch occurs. The self-heal
can be disabled for an incident with `INDEXER_SCHEMA_SELF_HEAL=0`.

After a successful recovery, the indexer root metadata and backend `/health`
`components.indexer.recovery` expose the fixed error code
`ponder_schema_identity_mismatch`, recovery time, previous and current schema,
and backup filename. `capabilityHealth.indexer` remains independently derived
from the live `/status` checkpoint and is never forced to `synced` by recovery
metadata.
