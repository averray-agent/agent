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
#   FRONTEND_BUILD_RUNNER     auto, host, or docker (default: auto)
#   FRONTEND_NODE_IMAGE       Docker image used when runner=docker (default: node:22-bookworm-slim)
#   DEPLOY_AUTOSTASH=0        disable auto-stashing local server build artifacts before pull
#   RESTART_CADDY=1           restart caddy after sync (not normally needed)
#   STACK_ROOT                parent dir containing docker-compose.yml (default: repo parent)
#   COMPOSE_FILE              path to docker-compose.yml
#   SKIP_GIT_UPDATE=1         skip fetch/checkout/pull because caller already pinned the repo
#   PRE_DEPLOY_SHA            rollback target SHA when SKIP_GIT_UPDATE=1 — supplied by
#                             deploy-production.sh from the wrapper's pre-pull HEAD so
#                             rollback() doesn't checkout the SAME commit that just
#                             failed. Falls back to current HEAD if unset.
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
FRONTEND_BUILD_RUNNER=${FRONTEND_BUILD_RUNNER:-auto}
FRONTEND_NODE_IMAGE=${FRONTEND_NODE_IMAGE:-node:22-bookworm-slim}
DEPLOY_AUTOSTASH=${DEPLOY_AUTOSTASH:-1}
RESTART_CADDY=${RESTART_CADDY:-0}
SKIP_GIT_UPDATE=${SKIP_GIT_UPDATE:-0}

if [[ ! -d "$APP_ROOT/.git" ]]; then
  echo "Expected repo checkout at $APP_ROOT" >&2
  exit 1
fi

for cmd in git curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

case "$FRONTEND_BUILD_RUNNER" in
  auto)
    if command -v npm >/dev/null 2>&1; then
      FRONTEND_BUILD_RUNNER=host
    else
      FRONTEND_BUILD_RUNNER=docker
    fi
    ;;
  host|docker)
    ;;
  *)
    echo "FRONTEND_BUILD_RUNNER must be auto, host, or docker" >&2
    exit 1
    ;;
esac

if [[ "$FRONTEND_BUILD_RUNNER" == "host" ]] && ! command -v npm >/dev/null 2>&1; then
  echo "Missing required command: npm. Set FRONTEND_BUILD_RUNNER=docker to build in a Node container." >&2
  exit 1
fi

if [[ "$FRONTEND_BUILD_RUNNER" == "docker" ]] && ! command -v docker >/dev/null 2>&1; then
  echo "Missing required command: docker. Install npm or set up Docker before deploying the frontend." >&2
  exit 1
fi

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

# Pin the pre-deploy SHA. When the wrapper has already pulled origin/main,
# `rev-parse HEAD` is the NEW SHA, so rollback would re-deploy the same code
# that just failed. Honour PRE_DEPLOY_SHA from the wrapper.
CURRENT_HEAD=$(git -C "$APP_ROOT" rev-parse HEAD)
PREVIOUS_SHA=${PRE_DEPLOY_SHA:-$CURRENT_HEAD}
echo "Pre-deploy SHA: $PREVIOUS_SHA"
if [[ "$PREVIOUS_SHA" == "$CURRENT_HEAD" && "${SKIP_GIT_UPDATE:-0}" == "1" ]]; then
  echo "Note: PRE_DEPLOY_SHA matches current HEAD; rollback would re-deploy the same SHA." >&2
fi

autostash_if_needed() {
  if [[ "$DEPLOY_AUTOSTASH" != "1" ]]; then
    return 0
  fi

  if [[ -z "$(git -C "$APP_ROOT" status --porcelain)" ]]; then
    return 0
  fi

  local stamp
  stamp=$(date -u +"%Y%m%dT%H%M%SZ")
  echo "Stashing local server build artifacts before pulling ($stamp)."
  git -C "$APP_ROOT" stash push -u -m "auto-stash before frontend deploy $stamp" >/dev/null
}

build_frontend() {
  if [[ "$FRONTEND_BUILD_RUNNER" == "host" ]]; then
    npm --prefix "$APP_ROOT" run build:frontend
    return
  fi

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e npm_config_cache=/tmp/.npm \
    -v "$APP_ROOT:/workspace" \
    -w /workspace \
    "$FRONTEND_NODE_IMAGE" \
    sh -lc "npm ci && npm run build:frontend"
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

  local now_head
  now_head=$(git -C "$APP_ROOT" rev-parse HEAD)
  if [[ "$PREVIOUS_SHA" == "$now_head" ]]; then
    echo "No usable rollback target: PREVIOUS_SHA ($PREVIOUS_SHA) matches current HEAD." >&2
    echo "Leaving the failed frontend in place for inspection. Manual intervention required." >&2
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
if [[ "$SKIP_GIT_UPDATE" == "1" ]]; then
  echo "SKIP_GIT_UPDATE=1 set; using current checkout."
else
  git -C "$APP_ROOT" fetch origin "$BRANCH"
  git -C "$APP_ROOT" checkout "$BRANCH"
  autostash_if_needed
  git -C "$APP_ROOT" pull --ff-only origin "$BRANCH"
fi

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
