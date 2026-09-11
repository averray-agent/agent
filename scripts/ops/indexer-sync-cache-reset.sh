#!/usr/bin/env bash
set -euo pipefail

# Operator-only, mainnet-only full raw-cache reset. No app schema is dropped.
# After SQL succeeds, clear the persisted app-schema claim under the same
# locks, so even an intervening automatic deploy must mint a fresh schema.
# See docs/INCIDENT_RESPONSE.md for backup, stop, reset, and dispatch order.
print_target=0
if [[ "$#" == "1" && "$1" == "--print-target" ]]; then
  print_target=1
elif [[ "$#" != "0" ]]; then
  echo "Usage: $0 [--print-target] (full mainnet ponder_sync reset; no target/range arguments)" >&2
  exit 1
fi
if [[ "$print_target" != "1" && "${INDEXER_FRESH_SCHEMA:-0}" != "1" ]]; then
  echo "Refusing cache reset: commit to INDEXER_FRESH_SCHEMA=1 on the next indexer deploy (workflow input indexer_fresh_schema=1)." >&2
  exit 1
fi
for required_command in docker node; do
  command -v "$required_command" >/dev/null || { echo "Missing required command: $required_command" >&2; exit 1; }
done
INDEXER_ENV_FILE=${INDEXER_ENV_FILE:-/run/agent-stack-mainnet/indexer.env}
DEPLOY_STATE_DIR=${DEPLOY_STATE_DIR:-/srv/agent-stack/.deploy-state}
schema_state_file="$DEPLOY_STATE_DIR/indexer.database-schema.mainnet"

if [[ "$print_target" != "1" ]]; then
  command -v flock >/dev/null || { echo "Missing required command: flock" >&2; exit 1; }
  # Same locks/order as deploy-production.sh; hold through DROP AND claim removal.
  exec 9>"${DEPLOY_LOCK_FILE:-/tmp/averray-production-deploy.lock}"
  flock -n 9 || { echo "Refusing cache reset: production deploy lock is held." >&2; exit 1; }
  exec 8>"${INDEXER_SCHEMA_LOCK_FILE:-/tmp/averray-indexer-schema.lock}"
  flock -n 8 || { echo "Refusing cache reset: indexer schema lock is held." >&2; exit 1; }

  if ! running="$(docker inspect --format '{{.State.Running}}' agent-mainnet-indexer)" || [[ "$running" != "false" ]]; then
    echo "Refusing cache reset: stop agent-mainnet-indexer first; it must remain stopped until the fresh-schema deploy." >&2
    exit 1
  fi
  # Fail before deleting cache if the subsequent claim removal cannot be safe.
  if [[ "$DEPLOY_STATE_DIR" != /* || ! -d "$DEPLOY_STATE_DIR" || ! -w "$DEPLOY_STATE_DIR" \
    || -L "$schema_state_file" || ( -e "$schema_state_file" && ! -f "$schema_state_file" ) ]]; then
    echo "Refusing cache reset: expected a writable absolute deploy-state directory and a regular mainnet schema claim." >&2
    exit 1
  fi
fi

# Read, never source, the rendered env. Only validated non-secret target fields
# leave Node: never put the DATABASE_URL/password in output, argv, or shell env.
target="$(node --input-type=module - "$INDEXER_ENV_FILE" <<'NODE'
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';

function refuse(message) {
  console.error(`Refusing cache reset: ${message}`);
  process.exit(1);
}
try {
  const env = parseEnv(readFileSync(process.argv[2], 'utf8'));
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) {
    refuse('DATABASE_URL must be a PostgreSQL URL without a fragment.');
  }
  if ([...url.searchParams.keys()].some(key => ['host', 'hostaddr', 'port', 'user', 'dbname', 'database', 'service'].includes(key))) {
    refuse('DATABASE_URL must not override target fields via query parameters.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  const port = url.port || '5432';
  // Reject conninfo/URI-shaped dbnames: psql otherwise interprets them as a
  // new connection string. Also keep printed fields single-line and unambiguous.
  if (!/^[a-zA-Z0-9_.-]+$/.test(user) || !/^[a-zA-Z0-9_.-]+$/.test(database)
    || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    refuse('DATABASE_URL requires a simple explicit user/dbname and a valid port.');
  }
  const networks = execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}',
    'agent-postgres', 'agent-mainnet-indexer'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().split('\n').map(line => JSON.parse(line));
  const [postgres, indexer] = networks;
  if (networks.length !== 2 || !postgres || !indexer) refuse('cannot inspect container networks.');
  const matches = Object.entries(postgres).some(([network, endpoint]) => indexer[network]
    && ['agent-postgres', endpoint.IPAddress, endpoint.GlobalIPv6Address, ...(endpoint.Aliases || []), ...(endpoint.DNSNames || [])]
      .filter(Boolean).some(alias => alias.toLowerCase() === host));
  if (!host || !matches) refuse('DATABASE_URL host is not agent-postgres on a shared indexer network.');
  console.log([host, user, database, port].join('\t'));
} catch {
  // URL/JSON/IO errors can contain secret input: never print the caught error.
  refuse('cannot read/parse the rendered DATABASE_URL or inspect container networks (credentials withheld).');
}
NODE
)"
IFS=$'\t' read -r db_host db_user db_name db_port <<<"$target"
echo "Reset target: host=$db_host container=agent-postgres user=$db_user dbname=$db_name port=$db_port schema=ponder_sync (from $INDEXER_ENV_FILE)."
if [[ "$print_target" == "1" ]]; then
  echo "Print-target only: no SQL, schema-claim change, stop, or deploy performed."
  exit 0
fi

# Only the raw-cache schema is fixed. A missing cache is an error, not success.
# -X ignores psqlrc; ON_ERROR_STOP prevents a failed DROP being reported as done.
if ! docker exec -i agent-postgres psql -X --set=ON_ERROR_STOP=1 --username="$db_user" --dbname="$db_name" --port="$db_port" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP SCHEMA ponder_sync CASCADE;
COMMIT;
SQL
then
  echo "Cache reset failed. Indexer remains stopped; inspect the error before proceeding. Do not restart the old app schema." >&2
  exit 1
fi

echo "Dropped $db_name.ponder_sync and its cached objects; app schemas were not dropped."
if ! rm -f -- "$schema_state_file"; then
  echo "Cache DROP succeeded but schema-claim removal FAILED: $schema_state_file. Keep the indexer stopped and clear this claim before any deploy." >&2
  exit 1
fi
echo "Removed persisted mainnet schema claim: $schema_state_file. Any next normal deploy now mints a fresh app schema."
echo "Indexer remains stopped. Next: dispatch run_indexer=1 indexer_fresh_schema=1 (see incident runbook)."
echo "This is a full RPC refetch, not a cached replay. Expect hours; do not restart the old app schema."
