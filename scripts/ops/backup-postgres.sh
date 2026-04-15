#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
ENV_FILE=${ENV_FILE:-"$STACK_ROOT/.env"}
BACKUP_DIR=${BACKUP_DIR:-"$STACK_ROOT/backups/postgres"}
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing docker-compose file at $COMPOSE_FILE" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file at $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

if [[ -z "${POSTGRES_DB:-}" || -z "${POSTGRES_USER:-}" ]]; then
  echo "POSTGRES_DB and POSTGRES_USER must be set in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

OUTPUT_FILE="$BACKUP_DIR/${POSTGRES_DB}-${TIMESTAMP}.sql.gz"

echo "Creating Postgres backup at $OUTPUT_FILE"

docker compose \
  --project-directory "$STACK_ROOT" \
  -f "$COMPOSE_FILE" \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "$OUTPUT_FILE"

echo "Backup complete: $OUTPUT_FILE"
