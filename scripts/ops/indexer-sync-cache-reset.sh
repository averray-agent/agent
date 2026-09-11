#!/usr/bin/env bash
set -euo pipefail

# Operator-only, mainnet-only full raw-cache reset. No app schema is dropped.
# INDEXER_FRESH_SCHEMA=1 is the operator's commitment to use the same flag on
# the NEXT deploy; this script neither dispatches nor restarts the indexer.
# See docs/INCIDENT_RESPONSE.md for backup, stop, reset, and dispatch order.
if [[ "${INDEXER_FRESH_SCHEMA:-0}" != "1" ]]; then
  echo "Refusing cache reset: commit to INDEXER_FRESH_SCHEMA=1 on the next indexer deploy (workflow input indexer_fresh_schema=1)." >&2
  exit 1
fi
if [[ "$#" != "0" ]]; then
  echo "Usage: INDEXER_FRESH_SCHEMA=1 $0 (full mainnet ponder_sync reset; no arguments)" >&2
  exit 1
fi
for command in docker flock; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

# Same locks/order as deploy-production.sh: no deploy may race this reset.
exec 9>"${DEPLOY_LOCK_FILE:-/tmp/averray-production-deploy.lock}"
flock -n 9 || { echo "Refusing cache reset: production deploy lock is held." >&2; exit 1; }
exec 8>"${INDEXER_SCHEMA_LOCK_FILE:-/tmp/averray-indexer-schema.lock}"
flock -n 8 || { echo "Refusing cache reset: indexer schema lock is held." >&2; exit 1; }

if ! running="$(docker inspect --format '{{.State.Running}}' agent-mainnet-indexer)" || [[ "$running" != "false" ]]; then
  echo "Refusing cache reset: stop agent-mainnet-indexer first; it must remain stopped until the fresh-schema deploy." >&2
  exit 1
fi

echo "Reset target: agent-postgres / averray_mainnet / ponder_sync (raw chain cache only)."
# Fixed database/schema targets prevent accidentally resetting testnet or an
# app schema. A missing cache is an error: do not claim a second reset happened.
# -X ignores psqlrc; ON_ERROR_STOP prevents a failed DROP being reported as done.
if ! docker exec -i agent-postgres psql -X --set=ON_ERROR_STOP=1 --username=agent --dbname=averray_mainnet <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP SCHEMA ponder_sync CASCADE;
COMMIT;
SQL
then
  echo "Cache reset failed. Indexer remains stopped; inspect the error before proceeding. Do not restart the old app schema." >&2
  exit 1
fi

echo "Dropped averray_mainnet.ponder_sync and its cached objects; app schemas and deploy state were not changed."
echo "Indexer remains stopped. Next: dispatch run_indexer=1 indexer_fresh_schema=1 (see incident runbook)."
echo "This is a full RPC refetch, not a cached replay. Expect hours; do not restart the old app schema."
