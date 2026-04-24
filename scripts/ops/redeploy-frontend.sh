#!/usr/bin/env bash
#
# Redeploy the static operator frontend served by Caddy.
#
# Flow:
#   1. Pin the pre-deploy SHA so rollback has a concrete target.
#   2. Fetch + fast-forward to origin/<branch>.
#   3. Build the static Next export and sync it into frontend/ in place.
#   4. Poll app.averray.com for the operator shell.
#   5. Roll back to the previous SHA, rebuild, and re-sync if the gate fails.
#
# Environment variables:
#   BRANCH                    branch to pull (default: main)
#   APP_URL                   URL to poll (default: https://app.averray.com/)
#   HEALTH_TIMEOUT_SEC        max seconds to wait for the app shell (default: 120)
#   HEALTH_INTERVAL_SEC       seconds between health polls (default: 5)
#   APP_BASIC_AUTH_USER       optional browser basic-auth username
#   APP_BASIC_AUTH_PASSWORD   optional browser basic-auth password
#   APP_EXPECTED_MARKER       expected HTML marker (default: Opening the operator control room.)
#   RESTART_CADDY=1           restart caddy after sync (not normally needed)
#   STACK_ROOT                parent dir containing docker-compose.yml (default: repo parent)
#   COMPOSE_FILE              path to docker-compose.yml
#   SKIP_ROLLBACK=1           disable auto-rollback
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
BRANCH=${BRANCH:-main}
APP_URL=${APP_URL:-https://app.averray.com/}
HEALTH_TIMEOUT_SEC=${HEALTH_TIMEOUT_SEC:-120}
HEALTH_INTERVAL_SEC=${HEALTH_INTERVAL_SEC:-5}
APP_EXPECTED_MARKER=${APP_EXPECTED_MARKER:-"Opening the operator control room."}
APP_BASIC_AUTH_USER=${APP_BASIC_AUTH_USER:-}
APP_BASIC_AUTH_PASSWORD=${APP_BASIC_AUTH_PASSWORD:-}
RESTART_CADDY=${RESTART_CADDY:-0}

if [[ ! -d "$APP_ROOT/.git" ]]; then
  echo "Expected repo checkout at $APP_ROOT" >&2
  exit 1
fi

for cmd in git npm curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

if [[ "$RESTART_CADDY" == "1" ]]; then
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "Missing docker-compose file at $COMPOSE_FILE" >&2
    exit 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "Missing required command: docker" >&2
    exit 1
  fi
fi

PREVIOUS_SHA=$(git -C "$APP_ROOT" rev-parse HEAD)
echo "Pre-deploy SHA: $PREVIOUS_SHA"

build_frontend() {
  npm --prefix "$APP_ROOT" run build:frontend
}

restart_caddy_if_requested() {
  if [[ "$RESTART_CADDY" != "1" ]]; then
    return 0
  fi
  docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    restart caddy
}

curl_app() {
  local curl_args=(-fsS --max-time 5)
  if [[ -n "$APP_BASIC_AUTH_USER" && -n "$APP_BASIC_AUTH_PASSWORD" ]]; then
    curl_args+=(-u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD")
  fi
  curl "${curl_args[@]}" "$APP_URL"
}

wait_for_app() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SEC ))
  local attempts=0
  while [[ $(date +%s) -lt $deadline ]]; do
    attempts=$(( attempts + 1 ))
    if html="$(curl_app 2>/dev/null)" && grep -Fq "$APP_EXPECTED_MARKER" <<<"$html"; then
      echo "Operator app check passed after ${attempts} attempt(s)."
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SEC"
  done
  return 1
}

rollback() {
  if [[ "${SKIP_ROLLBACK:-}" == "1" ]]; then
    echo "SKIP_ROLLBACK=1 set; leaving the failed frontend deploy in place for inspection." >&2
    exit 1
  fi
  echo "Operator app check failed; rolling back to $PREVIOUS_SHA" >&2
  git -C "$APP_ROOT" checkout --quiet "$PREVIOUS_SHA"
  build_frontend
  restart_caddy_if_requested
  if wait_for_app; then
    echo "Rollback succeeded; operator app is serving the previous build."
  else
    echo "Rollback failed to restore the operator app. Manual intervention required." >&2
  fi
  exit 1
}

echo "Updating repo in $APP_ROOT"
git -C "$APP_ROOT" fetch origin "$BRANCH"
git -C "$APP_ROOT" checkout "$BRANCH"
git -C "$APP_ROOT" pull --ff-only origin "$BRANCH"

NEW_SHA=$(git -C "$APP_ROOT" rev-parse HEAD)
echo "Deploying SHA: $NEW_SHA"

echo "Building and syncing operator frontend"
build_frontend
restart_caddy_if_requested

echo "Waiting for operator app at $APP_URL (timeout ${HEALTH_TIMEOUT_SEC}s)"
if ! wait_for_app; then
  rollback
fi

echo "Frontend redeployed successfully."
