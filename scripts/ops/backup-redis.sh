#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
ENV_FILE=${ENV_FILE:-"$STACK_ROOT/.env"}
BACKEND_ENV_FILE=${BACKEND_ENV_FILE:-"$STACK_ROOT/backend.env"}
BACKUP_DIR=${BACKUP_DIR:-"$STACK_ROOT/backups/redis"}
REDIS_SERVICE=${REDIS_SERVICE:-redis}
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing docker-compose file at $COMPOSE_FILE" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if [[ -f "$BACKEND_ENV_FILE" ]]; then
  set -a
  source "$BACKEND_ENV_FILE"
  set +a
fi

mkdir -p "$BACKUP_DIR"

redis_password_from_url() {
  local url="$1"
  if [[ "$url" != *"@"* ]]; then
    return 0
  fi
  local auth_part="${url#*://}"
  auth_part="${auth_part%%@*}"
  if [[ "$auth_part" == *":"* ]]; then
    printf '%s\n' "${auth_part#*:}"
  fi
}

declare -a REDIS_AUTH_ARGS=()
if [[ -n "${REDIS_PASSWORD:-}" ]]; then
  REDIS_AUTH_ARGS=(--no-auth-warning --pass "$REDIS_PASSWORD")
elif [[ -n "${REDIS_URL:-}" ]]; then
  parsed_password="$(redis_password_from_url "$REDIS_URL")"
  if [[ -n "$parsed_password" ]]; then
    REDIS_AUTH_ARGS=(--no-auth-warning --pass "$parsed_password")
  fi
fi

redis_cli() {
  docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    exec -T "$REDIS_SERVICE" redis-cli "${REDIS_AUTH_ARGS[@]}" "$@" </dev/null
}

read_redis_config_value() {
  local key="$1"
  mapfile -t lines < <(redis_cli --raw CONFIG GET "$key")
  if [[ "${#lines[@]}" -ge 2 ]]; then
    printf '%s\n' "${lines[1]}"
    return 0
  fi
  return 1
}

REDIS_DIR="$(read_redis_config_value dir || true)"
REDIS_DB_FILENAME="$(read_redis_config_value dbfilename || true)"

if [[ -z "$REDIS_DIR" || -z "$REDIS_DB_FILENAME" ]]; then
  echo "Unable to resolve Redis snapshot path via CONFIG GET dir/dbfilename" >&2
  exit 1
fi

SNAPSHOT_PATH="${REDIS_DIR%/}/${REDIS_DB_FILENAME}"
OUTPUT_FILE="$BACKUP_DIR/redis-${TIMESTAMP}.rdb.gz"

echo "Forcing Redis SAVE before backup"
redis_cli SAVE >/dev/null

echo "Creating Redis backup from $SNAPSHOT_PATH"
docker compose \
  --project-directory "$STACK_ROOT" \
  -f "$COMPOSE_FILE" \
  exec -T "$REDIS_SERVICE" cat "$SNAPSHOT_PATH" </dev/null | gzip > "$OUTPUT_FILE"

echo "Backup complete: $OUTPUT_FILE"
