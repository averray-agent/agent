#!/usr/bin/env bash
#
# Redeploy the backend container with pre-flight pause + post-deploy health
# gating + automatic rollback on failure.
#
# Flow:
#   1. Pin the pre-deploy commit so we can roll back on failure.
#   2. Fetch + fast-forward to origin/<branch>.
#   3. Rebuild and `up -d` the backend container.
#   4. Poll the configured health URL. If it never returns 200 within the
#      timeout window, check out the pre-deploy commit and rebuild to restore
#      the previous version.
#
# Environment variables:
#   STACK_ROOT         parent dir containing docker-compose.yml (default: repo parent)
#   COMPOSE_FILE       path to docker-compose.yml
#   BRANCH             branch to pull (default: main)
#   HEALTH_URL         URL to poll for readiness (default: https://api.averray.com/health)
#   HEALTH_TIMEOUT_SEC max seconds to wait for health (default: 120)
#   HEALTH_INTERVAL_SEC seconds between health polls (default: 5)
#   SKIP_GIT_UPDATE=1  skip fetch/checkout/pull because caller already pinned the repo
#   PRE_DEPLOY_SHA     rollback target SHA when SKIP_GIT_UPDATE=1 — supplied by
#                      deploy-production.sh from the wrapper's pre-pull HEAD so
#                      rollback() doesn't checkout the SAME commit that just
#                      failed. Falls back to current HEAD if unset.
#   SKIP_ROLLBACK=1    disable auto-rollback (useful for staged canary tests)
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
BRANCH=${BRANCH:-main}
HEALTH_URL=${HEALTH_URL:-https://api.averray.com/health}
HEALTH_TIMEOUT_SEC=${HEALTH_TIMEOUT_SEC:-120}
HEALTH_INTERVAL_SEC=${HEALTH_INTERVAL_SEC:-5}
SKIP_GIT_UPDATE=${SKIP_GIT_UPDATE:-0}

if [[ ! -d "$APP_ROOT/.git" ]]; then
  echo "Expected repo checkout at $APP_ROOT" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing docker-compose file at $COMPOSE_FILE" >&2
  exit 1
fi

for cmd in git docker curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

# Pin the pre-deploy SHA before changing anything so rollback has a concrete
# target. When the wrapper has already pulled origin/main, `rev-parse HEAD`
# is the NEW SHA — making rollback a no-op. Honour PRE_DEPLOY_SHA from the
# wrapper, fall back to HEAD when invoked directly.
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
    up -d --build backend
}

wait_for_health() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SEC ))
  local attempts=0
  while [[ $(date +%s) -lt $deadline ]]; do
    attempts=$(( attempts + 1 ))
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "Health check passed after ${attempts} attempt(s)."
      curl -fsS "$HEALTH_URL" || true
      echo
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SEC"
  done
  return 1
}

rollback() {
  if [[ "${SKIP_ROLLBACK:-}" == "1" ]]; then
    echo "SKIP_ROLLBACK=1 set; leaving the unhealthy deploy in place for inspection." >&2
    exit 1
  fi

  local now_head
  now_head=$(git -C "$APP_ROOT" rev-parse HEAD)
  if [[ "$PREVIOUS_SHA" == "$now_head" ]]; then
    echo "No usable rollback target: PREVIOUS_SHA ($PREVIOUS_SHA) matches current HEAD." >&2
    echo "Leaving the unhealthy backend in place for inspection. Manual intervention required." >&2
    exit 1
  fi

  echo "Health check failed; rolling back to $PREVIOUS_SHA" >&2
  if ! git -C "$APP_ROOT" checkout --quiet "$PREVIOUS_SHA"; then
    echo "Rollback: git checkout $PREVIOUS_SHA failed. Working tree may be dirty or the SHA may be unreachable." >&2
    echo "Manual intervention required: inspect $APP_ROOT for uncommitted changes or fetch the missing commit." >&2
    exit 1
  fi

  # Verify the checkout actually moved HEAD. The Phase 5a Stage 2C-3
  # rollback outage post-mortem (2026-05-21, PR #455) showed `git
  # rev-parse HEAD` still pointing at the failed-deploy SHA after this
  # function claimed to have rolled back — root cause never fully
  # isolated (suspected: silent checkout no-op when working tree state
  # interferes). This guard turns that class of failure into a loud
  # bail before the rollback's compose_up rebuilds with the still-
  # broken code.
  local checked_out_head
  checked_out_head=$(git -C "$APP_ROOT" rev-parse HEAD)
  if [[ "$checked_out_head" != "$PREVIOUS_SHA" ]]; then
    echo "Rollback checkout did NOT move HEAD: expected $PREVIOUS_SHA, got $checked_out_head." >&2
    echo "Manual intervention required: the working tree is still at the failed-deploy SHA." >&2
    exit 1
  fi
  echo "Working tree restored to $PREVIOUS_SHA"

  # Re-render /run/agent-stack/backend.env from the rolled-back
  # template. Without this step the rendered env on disk still
  # reflects the FAILED deploy's template — restoring just the code
  # while leaving the new env in place can produce mismatched runtime
  # state (env vars the rolled-back code still expects, or vice
  # versa). This is the gap that prevented the Phase 5a Stage 2C-3
  # rollback from restoring health: PR #455 removed static-key env
  # lines from backend.env.template; the wrapping deploy rendered the
  # new (smaller) env before container-restart; rollback then restored
  # the OLD code that read those env vars, but /run/agent-stack/
  # backend.env no longer carried them.
  local render_script="$APP_ROOT/scripts/ops/render-vps-env.sh"
  local template="$APP_ROOT/deploy/backend.env.template"
  local target="/run/agent-stack/backend.env"
  local token="/etc/agent-stack/op-backend.env"

  if [[ -x "$render_script" && -f "$template" && -f "$token" ]]; then
    echo "Re-rendering $target from $template @ $PREVIOUS_SHA"
    if ! sudo bash "$render_script" "$template" "$target" "$token"; then
      echo "Rollback env re-render failed; backend may boot with NEW-deploy env on OLD-deploy code." >&2
      echo "Manual intervention required: inspect $target vs $template at $PREVIOUS_SHA." >&2
      exit 1
    fi
  else
    # On a freshly-bootstrapped VPS the render path may not be fully
    # installed yet — log the skip but don't fail, mirroring the
    # forward-deploy render step's skip-clean conditions in
    # deploy-production.sh::render_runtime_envs.
    echo "Rollback skipping env re-render: render-vps-env.sh ($render_script), template ($template), or op token ($token) not present." >&2
    echo "  This is OK on a not-yet-bootstrapped VPS but suspicious on a deployed one." >&2
  fi

  compose_up
  if wait_for_health; then
    echo "Rollback succeeded; service is serving the previous build."
  else
    echo "Rollback failed to restore health. Manual intervention required." >&2
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

echo "Rebuilding backend container"
compose_up

echo "Waiting for health at $HEALTH_URL (timeout ${HEALTH_TIMEOUT_SEC}s)"
if ! wait_for_health; then
  rollback
fi

echo "Backend redeployed successfully."
