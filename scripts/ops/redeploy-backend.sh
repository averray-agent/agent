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
#   BACKEND_LOG_TAIL   failed-container log lines emitted before rollback (default: 200)
#   WITNESS_RUNNER_SERVICE / WITNESS_PROXY_SERVICE
#                       optional isolated Verify services (mainnet only)
#   WITNESS_RUNTIME_ROOT host path shared with sandbox bind mounts
#   WITNESS_SANDBOX_IMAGE exact prebuilt Witness execution image tag
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
COMPOSE_PROJECT_DIRECTORY=${COMPOSE_PROJECT_DIRECTORY:-"$STACK_ROOT"}
BACKEND_SERVICE=${BACKEND_SERVICE:-backend}
BACKEND_CONTAINER=${BACKEND_CONTAINER:-agent-backend}
BACKEND_ENV_TEMPLATE=${BACKEND_ENV_TEMPLATE:-"$APP_ROOT/deploy/backend.env.template"}
BACKEND_ENV_TARGET=${BACKEND_ENV_TARGET:-/run/agent-stack/backend.env}
BACKEND_ENV_TOKEN=${BACKEND_ENV_TOKEN:-/etc/agent-stack/op-backend.env}
AWS_CONFIG_PATH=${AWS_CONFIG_PATH:-/etc/agent-stack/aws-config}
BADGE_RECEIPT_CERT_PATH=${BADGE_RECEIPT_CERT_PATH:-/etc/agent-stack/roles-anywhere/badge-receipt-signer-cert.pem}
BADGE_RECEIPT_KEY_PATH=${BADGE_RECEIPT_KEY_PATH:-/etc/agent-stack/roles-anywhere/badge-receipt-signer-key.pem}
# Declaration the preflight compares against the mounted aws-config. The
# default is the testnet profile; mainnet deploys must pass the mainnet
# declaration (deploy-production.sh selects it from LIVE_NETWORK) because
# mainnet has its own Roles Anywhere trust anchor, profile, and role.
BADGE_RECEIPT_PROFILE_DECLARATION=${BADGE_RECEIPT_PROFILE_DECLARATION:-}
BRANCH=${BRANCH:-main}
HEALTH_URL=${HEALTH_URL:-https://api.averray.com/health}
HEALTH_TIMEOUT_SEC=${HEALTH_TIMEOUT_SEC:-120}
HEALTH_INTERVAL_SEC=${HEALTH_INTERVAL_SEC:-5}
BACKEND_LOG_TAIL=${BACKEND_LOG_TAIL:-200}
WITNESS_RUNNER_SERVICE=${WITNESS_RUNNER_SERVICE:-}
WITNESS_PROXY_SERVICE=${WITNESS_PROXY_SERVICE:-}
WITNESS_RUNNER_CONTAINER=${WITNESS_RUNNER_CONTAINER:-}
WITNESS_PROXY_CONTAINER=${WITNESS_PROXY_CONTAINER:-}
WITNESS_RUNTIME_ROOT=${WITNESS_RUNTIME_ROOT:-/srv/agent-stack-mainnet/witness-runtime}
WITNESS_SANDBOX_IMAGE=${WITNESS_SANDBOX_IMAGE:-averray-witness-preflight:phase1-uv-0.12.5-python-3.12.12-uv-build-0.9.27}
SKIP_GIT_UPDATE=${SKIP_GIT_UPDATE:-0}

if ! [[ "$BACKEND_LOG_TAIL" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKEND_LOG_TAIL must be a positive integer; got '$BACKEND_LOG_TAIL'" >&2
  exit 1
fi

if [[ ! -d "$APP_ROOT/.git" ]]; then
  echo "Expected repo checkout at $APP_ROOT" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing docker-compose file at $COMPOSE_FILE" >&2
  exit 1
fi

for cmd in git docker curl jq sudo; do
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
  local deployed_sha="$1"
  local services=("$BACKEND_SERVICE")
  docker compose \
    --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
    -f "$COMPOSE_FILE" \
    build --build-arg "DEPLOYED_SHA=$deployed_sha" "$BACKEND_SERVICE"

  if [[ -n "$WITNESS_RUNNER_SERVICE" && -n "$WITNESS_PROXY_SERVICE" ]] \
    && compose_has_service "$WITNESS_RUNNER_SERVICE" \
    && compose_has_service "$WITNESS_PROXY_SERVICE"; then
    echo "Preparing isolated Witness runtime and pinned sandbox image"
    sudo install -d -m 0700 -o 65532 -g 65532 "$WITNESS_RUNTIME_ROOT"
    export WITNESS_RUNTIME_ROOT
    docker build -t "$WITNESS_SANDBOX_IMAGE" "$APP_ROOT/witness/sandbox"
    docker compose \
      --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
      -f "$COMPOSE_FILE" \
      build "$WITNESS_PROXY_SERVICE" "$WITNESS_RUNNER_SERVICE"
    services+=("$WITNESS_PROXY_SERVICE" "$WITNESS_RUNNER_SERVICE")
  elif [[ -n "$WITNESS_RUNNER_SERVICE" || -n "$WITNESS_PROXY_SERVICE" ]]; then
    if [[ "$deployed_sha" != "$PREVIOUS_SHA" ]]; then
      echo "Configured Witness services are missing from $COMPOSE_FILE at $deployed_sha." >&2
      return 1
    fi
    echo "Rollback target predates isolated Witness services; removing only their known containers."
    for container in "$WITNESS_RUNNER_CONTAINER" "$WITNESS_PROXY_CONTAINER"; do
      if [[ -n "$container" ]]; then
        docker container rm --force "$container" >/dev/null 2>&1 || true
      fi
    done
  fi
  docker compose \
    --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
    -f "$COMPOSE_FILE" \
    up -d --no-build "${services[@]}"
}

compose_has_service() {
  local target="$1"
  local service
  while IFS= read -r service; do
    [[ "$service" == "$target" ]] && return 0
  done < <(docker compose \
    --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
    -f "$COMPOSE_FILE" \
    config --services)
  return 1
}

wait_for_health() {
  local expected_sha="$1"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SEC ))
  local attempts=0
  local observed_sha="unavailable"
  while [[ $(date +%s) -lt $deadline ]]; do
    attempts=$(( attempts + 1 ))
    local health_json
    if health_json=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null); then
      observed_sha=$(printf '%s' "$health_json" | jq -er '.deployedSha | strings' 2>/dev/null || echo "missing")
      if [[ "$observed_sha" == "$expected_sha" ]]; then
        echo "Health and serving-SHA checks passed after ${attempts} attempt(s): deployedSha $observed_sha"
        printf '%s\n' "$health_json"
        return 0
      fi
    fi
    sleep "$HEALTH_INTERVAL_SEC"
  done
  echo "Backend health did not prove deployedSha $expected_sha (last observed: $observed_sha)." >&2
  return 1
}

emit_failed_backend_logs() {
  echo "Backend health gate failed; emitting the last $BACKEND_LOG_TAIL startup log lines before rollback." >&2
  if ! docker compose \
    --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
    -f "$COMPOSE_FILE" \
    logs --no-color --tail "$BACKEND_LOG_TAIL" "$BACKEND_SERVICE" >&2; then
    echo "WARNING: docker compose could not read failed backend logs; trying the container name directly." >&2
    if ! docker logs --tail "$BACKEND_LOG_TAIL" "$BACKEND_CONTAINER" >&2; then
      echo "WARNING: failed backend startup logs were unavailable from compose and $BACKEND_CONTAINER." >&2
    fi
  fi
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
  local template="$BACKEND_ENV_TEMPLATE"
  local target="$BACKEND_ENV_TARGET"
  local token="$BACKEND_ENV_TOKEN"

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

  compose_up "$PREVIOUS_SHA"
  if wait_for_health "$PREVIOUS_SHA"; then
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

echo "Preflighting dedicated badge receipt signer consumer paths"
env -u PREFLIGHT_NO_SUDO -u PREFLIGHT_EXPECTED_OWNER_MODE \
  "$APP_ROOT/scripts/ops/preflight-badge-receipt-signer.sh" \
  "${BADGE_RECEIPT_PROFILE_DECLARATION:-$APP_ROOT/deploy/aws-config.badge-receipt-profile}" \
  "$AWS_CONFIG_PATH" \
  "$BADGE_RECEIPT_CERT_PATH" \
  "$BADGE_RECEIPT_KEY_PATH"

echo "Rebuilding backend container"
compose_up "$NEW_SHA"

echo "Waiting for health and deployedSha=$NEW_SHA at $HEALTH_URL (timeout ${HEALTH_TIMEOUT_SEC}s)"
if ! wait_for_health "$NEW_SHA"; then
  emit_failed_backend_logs
  rollback
fi

echo "Backend redeployed successfully."
