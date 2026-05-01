#!/usr/bin/env bash
#
# Redeploy the indexer container with post-deploy health gating and optional
# readiness gating once historical indexing has completed.
#
# Flow:
#   1. Pin the pre-deploy commit so rollback has a concrete target.
#   2. Fetch + fast-forward to origin/<branch>.
#   3. Rebuild and `up -d` the indexer container.
#   4. Poll /health until the process is listening.
#   5. Optionally poll /ready until historical indexing completes.
#   6. Roll back to the previous SHA if either gate times out.
#
# Environment variables:
#   STACK_ROOT            parent dir containing docker-compose.yml (default: repo parent)
#   COMPOSE_FILE          path to docker-compose.yml
#   BRANCH                branch to pull (default: main)
#   HEALTH_URL            URL to poll for liveness (default: https://index.averray.com/health)
#   READY_URL             URL to poll for readiness (default: https://index.averray.com/ready)
#   HEALTH_TIMEOUT_SEC    max seconds to wait for /health (default: 120)
#   HEALTH_STABILITY_SEC  seconds to re-check /health after first pass (default: 0)
#   READY_TIMEOUT_SEC     max seconds to wait for /ready (default: 900)
#   POLL_INTERVAL_SEC     seconds between polls (default: 5)
#   INDEXER_LOG_TAIL      lines of indexer/Caddy logs to print on failure (default: 120)
#   WAIT_FOR_READY=0      skip the /ready gate (useful during long backfills)
#   ROLLBACK_WAIT_FOR_READY=1
#                         also wait for /ready after rollback (default: 0)
#   SKIP_GIT_UPDATE=1     skip fetch/checkout/pull because caller already pinned the repo
#   PRE_DEPLOY_SHA        rollback target SHA when SKIP_GIT_UPDATE=1 — provided by
#                         deploy-production.sh from the wrapper's pre-pull HEAD so
#                         that rollback() doesn't checkout the SAME commit that just
#                         failed. Falls back to current HEAD if unset.
#   SKIP_ROLLBACK=1       disable auto-rollback
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
BRANCH=${BRANCH:-main}
HEALTH_URL=${HEALTH_URL:-https://index.averray.com/health}
READY_URL=${READY_URL:-https://index.averray.com/ready}
HEALTH_TIMEOUT_SEC=${HEALTH_TIMEOUT_SEC:-120}
HEALTH_STABILITY_SEC=${HEALTH_STABILITY_SEC:-0}
READY_TIMEOUT_SEC=${READY_TIMEOUT_SEC:-900}
POLL_INTERVAL_SEC=${POLL_INTERVAL_SEC:-5}
INDEXER_LOG_TAIL=${INDEXER_LOG_TAIL:-120}
WAIT_FOR_READY=${WAIT_FOR_READY:-1}
ROLLBACK_WAIT_FOR_READY=${ROLLBACK_WAIT_FOR_READY:-0}
SKIP_GIT_UPDATE=${SKIP_GIT_UPDATE:-0}

if [[ ! -d "$APP_ROOT/.git" ]]; then
  echo "Expected repo checkout at $APP_ROOT" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing docker-compose file at $COMPOSE_FILE" >&2
  exit 1
fi

for numeric_var in HEALTH_TIMEOUT_SEC HEALTH_STABILITY_SEC READY_TIMEOUT_SEC POLL_INTERVAL_SEC INDEXER_LOG_TAIL; do
  if [[ ! "${!numeric_var}" =~ ^[0-9]+$ ]]; then
    echo "$numeric_var must be a non-negative integer." >&2
    exit 1
  fi
done

for cmd in git docker curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

# When the wrapper has already pulled origin/main, `git rev-parse HEAD` is the
# NEW SHA, not the pre-deploy one — making rollback a structural no-op. The
# wrapper passes the real pre-deploy SHA via PRE_DEPLOY_SHA. Fall back to HEAD
# only when this script is invoked directly without the wrapper.
CURRENT_HEAD=$(git -C "$APP_ROOT" rev-parse HEAD)
PREVIOUS_SHA=${PRE_DEPLOY_SHA:-$CURRENT_HEAD}
echo "Pre-deploy SHA: $PREVIOUS_SHA"
if [[ "$PREVIOUS_SHA" == "$CURRENT_HEAD" && "${SKIP_GIT_UPDATE:-0}" == "1" ]]; then
  echo "Note: PRE_DEPLOY_SHA matches current HEAD; rollback would re-deploy the same SHA." >&2
fi

compose_up() {
  docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    up -d --build indexer
}

dump_indexer_diagnostics() {
  echo "Indexer diagnostics: docker compose ps indexer"
  docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    ps indexer || true

  echo "Indexer diagnostics: last ${INDEXER_LOG_TAIL} indexer log lines"
  local indexer_log
  indexer_log=$(
    docker compose \
      --project-directory "$STACK_ROOT" \
      -f "$COMPOSE_FILE" \
      logs --tail="$INDEXER_LOG_TAIL" indexer 2>&1 || true
  )
  printf '%s\n' "$indexer_log"

  echo "Indexer diagnostics: last ${INDEXER_LOG_TAIL} Caddy log lines"
  docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    logs --tail="$INDEXER_LOG_TAIL" caddy || true

  # Skim the indexer log for known fatal-startup patterns and surface a one-line
  # summary. This is the user-visible answer to "why didn't /health bind?" so it
  # belongs ahead of the raw log dump in scrollback. Patterns are derived from
  # incidents that have actually wedged this stack:
  #   MigrationError       — Ponder schema build_id mismatch (issue #120)
  #   TypeError            — indexing-function bug (e.g. oldLegacy iterable family)
  #   uncaughtException    — generic Node fatal that exits the process
  #   unhandledRejection   — async fatal Ponder treats as unrecoverable
  #   ECONNREFUSED.*postgres / postgres.*ECONNREFUSED — Postgres unreachable
  #   Cannot find module   — image built without expected dep
  #   start_block.*greater than head — config/RPC drift
  echo "::group::Indexer fatal-pattern summary"
  local matches
  matches=$(
    printf '%s\n' "$indexer_log" \
      | grep -E 'MigrationError|TypeError|uncaughtException|unhandledRejection|FATAL|Cannot find module|ECONNREFUSED.*postgres|postgres.*ECONNREFUSED|start_block.*greater than head' \
      | head -20 \
      || true
  )
  if [[ -n "$matches" ]]; then
    printf '%s\n' "$matches"
    echo "(scroll up for full context)"
  else
    echo "(no known fatal-startup patterns matched in the last ${INDEXER_LOG_TAIL} indexer log lines)"
  fi
  echo "::endgroup::"
}

wait_for_ok() {
  local url="$1"
  local timeout="$2"
  local label="$3"
  local deadline=$(( $(date +%s) + timeout ))
  local attempts=0
  while [[ $(date +%s) -lt $deadline ]]; do
    attempts=$(( attempts + 1 ))
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      echo "$label passed after ${attempts} attempt(s)."
      curl -fsS "$url" || true
      echo
      return 0
    fi
    echo "$label still waiting after ${attempts} attempt(s)."
    sleep "$POLL_INTERVAL_SEC"
  done
  return 1
}

check_once() {
  local url="$1"
  curl -fsS --max-time 5 "$url" >/dev/null 2>&1
}

rollback() {
  if [[ "${SKIP_ROLLBACK:-}" == "1" ]]; then
    echo "SKIP_ROLLBACK=1 set; leaving the unhealthy indexer deploy in place for inspection." >&2
    exit 1
  fi

  local now_head
  now_head=$(git -C "$APP_ROOT" rev-parse HEAD)
  if [[ "$PREVIOUS_SHA" == "$now_head" ]]; then
    # Nothing earlier to roll back to — checking out the same SHA and rebuilding
    # would just waste another 120s health-wait on the same broken code. Bail
    # explicitly so the operator sees the right next step.
    echo "No usable rollback target: PREVIOUS_SHA ($PREVIOUS_SHA) matches current HEAD." >&2
    echo "Leaving the unhealthy indexer in place for inspection. Manual intervention required." >&2
    exit 1
  fi

  echo "Indexer gate failed; rolling back to $PREVIOUS_SHA" >&2
  git -C "$APP_ROOT" checkout --quiet "$PREVIOUS_SHA"
  compose_up
  if wait_for_ok "$HEALTH_URL" "$HEALTH_TIMEOUT_SEC" "Health check"; then
    if [[ "$ROLLBACK_WAIT_FOR_READY" == "1" ]]; then
      wait_for_ok "$READY_URL" "$READY_TIMEOUT_SEC" "Readiness check" || true
    else
      echo "ROLLBACK_WAIT_FOR_READY=0 set; rollback verified /health only."
    fi
    echo "Rollback succeeded; indexer is serving the previous build."
  else
    echo "Rollback failed to restore indexer health. Manual intervention required." >&2
  fi
  exit 1
}

echo "Updating repo in $APP_ROOT"
if [[ "$SKIP_GIT_UPDATE" == "1" ]]; then
  echo "SKIP_GIT_UPDATE=1 set; using current checkout."
else
  git -C "$APP_ROOT" fetch origin "$BRANCH"
  git -C "$APP_ROOT" checkout "$BRANCH"
  git -C "$APP_ROOT" pull --ff-only origin "$BRANCH"
fi

NEW_SHA=$(git -C "$APP_ROOT" rev-parse HEAD)
echo "Deploying SHA: $NEW_SHA"

echo "Rebuilding indexer container"
compose_up

echo "Waiting for indexer health at $HEALTH_URL (timeout ${HEALTH_TIMEOUT_SEC}s)"
if ! wait_for_ok "$HEALTH_URL" "$HEALTH_TIMEOUT_SEC" "Health check"; then
  dump_indexer_diagnostics
  rollback
fi

if [[ "$HEALTH_STABILITY_SEC" != "0" ]]; then
  echo "Waiting ${HEALTH_STABILITY_SEC}s to confirm indexer health stays stable."
  sleep "$HEALTH_STABILITY_SEC"
  if ! check_once "$HEALTH_URL"; then
    echo "Health check failed after stability window." >&2
    dump_indexer_diagnostics
    rollback
  fi
  echo "Health remained stable after ${HEALTH_STABILITY_SEC}s."
fi

if [[ "$WAIT_FOR_READY" == "1" ]]; then
  echo "Waiting for indexer readiness at $READY_URL (timeout ${READY_TIMEOUT_SEC}s)"
  if ! wait_for_ok "$READY_URL" "$READY_TIMEOUT_SEC" "Readiness check"; then
    dump_indexer_diagnostics
    rollback
  fi
else
  echo "WAIT_FOR_READY=0 set; skipping /ready gate."
fi

echo "Indexer redeployed successfully."
