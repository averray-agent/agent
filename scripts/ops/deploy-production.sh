#!/usr/bin/env bash
#
# Single production deploy entrypoint for merges to main.
#
# Intended caller:
#   - GitHub Actions after CI passes on main
#   - a human on the VPS when needed
#
# The component deploy scripts still own their health gates and rollbacks. This
# script owns serialization, pulling, path-based routing, and final smoke checks.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
BRANCH=${BRANCH:-main}
DEPLOY_LOCK_FILE=${DEPLOY_LOCK_FILE:-/tmp/averray-production-deploy.lock}
DEPLOY_AUTOSTASH=${DEPLOY_AUTOSTASH:-1}
DEPLOY_OLD_SHA=${DEPLOY_OLD_SHA:-}
DEPLOY_NEW_SHA=${DEPLOY_NEW_SHA:-}
DEPLOY_STATE_DIR=${DEPLOY_STATE_DIR:-"$STACK_ROOT/.deploy-state"}

RUN_BACKEND=${RUN_BACKEND:-auto}
RUN_FRONTEND=${RUN_FRONTEND:-auto}
RUN_INDEXER=${RUN_INDEXER:-auto}
RUN_SITE=${RUN_SITE:-auto}
RUN_CADDY=${RUN_CADDY:-auto}
RUN_SMOKE=${RUN_SMOKE:-1}
SMOKE_CHECK_INDEXER=${SMOKE_CHECK_INDEXER:-auto}
SMOKE_CHECK_BOOTSTRAP_INSTRUMENTATION=${SMOKE_CHECK_BOOTSTRAP_INSTRUMENTATION:-0}
SMOKE_CHECK_BOOTSTRAP_SELF_REPORT_SENT=${SMOKE_CHECK_BOOTSTRAP_SELF_REPORT_SENT:-0}
SMOKE_CHECK_PRODUCT_PROOF_GATE=${SMOKE_CHECK_PRODUCT_PROOF_GATE:-0}
INDEXER_DATABASE_SCHEMA=${INDEXER_DATABASE_SCHEMA:-}
INDEXER_FRESH_SCHEMA=${INDEXER_FRESH_SCHEMA:-0}
INDEXER_ENV_FILE=${INDEXER_ENV_FILE:-"$STACK_ROOT/indexer.env"}
BACKEND_ENV_FILE=${BACKEND_ENV_FILE:-"$STACK_ROOT/backend.env"}

SITE_BUILD_RUNNER=${SITE_BUILD_RUNNER:-auto}
SITE_NODE_IMAGE=${SITE_NODE_IMAGE:-node:22-bookworm-slim}
BOOTSTRAP_INSTRUMENTATION_ENV_UPDATED=0

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command git
require_command docker
require_command curl
require_command flock

if [[ ! -d "$APP_ROOT/.git" ]]; then
  echo "Expected repo checkout at $APP_ROOT" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing docker-compose file at $COMPOSE_FILE" >&2
  exit 1
fi

with_lock() {
  flock -n 9 || {
    echo "Another production deploy is already running." >&2
    exit 1
  }
  deploy
}

changed_matches() {
  local pattern="$1"
  if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
    return 1
  fi
  git -C "$APP_ROOT" diff --name-only "$OLD_SHA" "$NEW_SHA" | grep -Eq "$pattern"
}

component_state_file() {
  local component="$1"
  printf '%s/%s.last-good\n' "$DEPLOY_STATE_DIR" "$component"
}

write_component_sha() {
  local component="$1"
  local sha="$2"
  local file
  file=$(component_state_file "$component")
  mkdir -p "$DEPLOY_STATE_DIR"
  local tmp="${file}.tmp.$$"
  printf '%s\n' "$sha" > "$tmp"
  mv "$tmp" "$file"
}

read_component_sha() {
  local component="$1"
  local file
  file=$(component_state_file "$component")
  if [[ ! -f "$file" ]]; then
    echo "$OLD_SHA"
    return
  fi

  local sha
  sha=$(head -n 1 "$file" | tr -d '[:space:]')
  if git -C "$APP_ROOT" cat-file -e "${sha}^{commit}" >/dev/null 2>&1; then
    echo "$sha"
    return
  fi

  echo "Ignoring invalid deploy state for $component: $sha" >&2
  echo "$OLD_SHA"
}

initialize_component_state() {
  local component
  for component in backend indexer frontend site caddy; do
    local file
    file=$(component_state_file "$component")
    if [[ ! -f "$file" ]]; then
      write_component_sha "$component" "$OLD_SHA"
      echo "Initialized $component deploy pointer at $OLD_SHA"
    fi
  done
}

quote_env_value() {
  local value="$1"
  value=${value//$'\n'/}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

upsert_env_values() {
  local env_file="$1"
  shift
  mkdir -p "$(dirname "$env_file")"
  touch "$env_file"

  local key_pattern=""
  local pair key
  for pair in "$@"; do
    key="${pair%%=*}"
    if [[ -z "$key_pattern" ]]; then
      key_pattern="$key"
    else
      key_pattern="$key_pattern|$key"
    fi
  done

  local tmp="${env_file}.tmp.$$"
  grep -Ev "^(${key_pattern})=" "$env_file" > "$tmp" || true
  for pair in "$@"; do
    key="${pair%%=*}"
    printf '%s=%s\n' "$key" "$(quote_env_value "${pair#*=}")" >> "$tmp"
  done
  mv "$tmp" "$env_file"
}

configure_bootstrap_instrumentation_env() {
  if [[ -z "${RESEND_API_KEY:-}" || -z "${BOOTSTRAP_SELF_REPORT_TO:-}" ]]; then
    echo "Bootstrap self-report secrets are incomplete; leaving backend.env instrumentation settings unchanged."
    return
  fi

  local send_on_start="false"
  case "${BOOTSTRAP_SELF_REPORT_SEND_ON_START:-0}" in
    1|true|yes) send_on_start="true" ;;
    0|false|no|"") send_on_start="false" ;;
    *)
      echo "Invalid BOOTSTRAP_SELF_REPORT_SEND_ON_START toggle: $BOOTSTRAP_SELF_REPORT_SEND_ON_START" >&2
      exit 1
      ;;
  esac

  echo "Writing bootstrap instrumentation settings to $BACKEND_ENV_FILE"
  upsert_env_values "$BACKEND_ENV_FILE" \
    "UPSTREAM_STATUS_POLLER_ENABLED=true" \
    "UPSTREAM_STATUS_POLLER_INTERVAL_MS=86400000" \
    "UPSTREAM_STATUS_POLLER_BATCH_SIZE=50" \
    "BOOTSTRAP_SELF_REPORT_ENABLED=true" \
    "BOOTSTRAP_SELF_REPORT_INTERVAL_MS=604800000" \
    "BOOTSTRAP_SELF_REPORT_SEND_ON_START=$send_on_start" \
    "BOOTSTRAP_SELF_REPORT_FROM=${BOOTSTRAP_SELF_REPORT_FROM:-ops@averray.com}" \
    "BOOTSTRAP_SELF_REPORT_TO=$BOOTSTRAP_SELF_REPORT_TO" \
    "BOOTSTRAP_SELF_REPORT_SUBJECT_PREFIX=Averray bootstrap self-report" \
    "RESEND_API_KEY=$RESEND_API_KEY" \
    "RESEND_API_BASE_URL=https://api.resend.com"
  BOOTSTRAP_INSTRUMENTATION_ENV_UPDATED=1
}

backend_env_requires_deploy() {
  if [[ "$BOOTSTRAP_INSTRUMENTATION_ENV_UPDATED" != "1" ]]; then
    return 1
  fi
  case "$RUN_BACKEND" in
    0|false|no) return 1 ;;
    *) return 0 ;;
  esac
}

component_changed_matches() {
  local component="$1"
  local pattern="$2"
  local base_sha
  base_sha=$(read_component_sha "$component")
  if [[ "$base_sha" == "$NEW_SHA" ]]; then
    return 1
  fi
  git -C "$APP_ROOT" diff --name-only "$base_sha" "$NEW_SHA" | grep -Eq "$pattern"
}

mark_component_deployed() {
  local component="$1"
  write_component_sha "$component" "$NEW_SHA"
  echo "Recorded $component deploy pointer: $NEW_SHA"
}

should_run() {
  local component="$1"
  local setting="$2"
  local pattern="$3"
  case "$setting" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
    auto) component_changed_matches "$component" "$pattern" ;;
    *)
      echo "Invalid deploy toggle: $setting" >&2
      exit 1
      ;;
  esac
}

pull_latest() {
  if git -C "$APP_ROOT" pull --ff-only origin "$BRANCH"; then
    return 0
  fi

  if [[ "$DEPLOY_AUTOSTASH" != "1" ]]; then
    echo "Pull failed and DEPLOY_AUTOSTASH is disabled." >&2
    exit 1
  fi

  if [[ -z "$(git -C "$APP_ROOT" status --porcelain)" ]]; then
    echo "Pull failed without local changes to stash." >&2
    exit 1
  fi

  local stamp
  stamp=$(date -u +"%Y%m%dT%H%M%SZ")
  echo "Fast-forward pull failed with local changes; stashing and retrying ($stamp)."
  git -C "$APP_ROOT" stash push -u -m "auto-stash before production deploy $stamp" >/dev/null
  git -C "$APP_ROOT" pull --ff-only origin "$BRANCH"
}

resolve_site_runner() {
  case "$SITE_BUILD_RUNNER" in
    auto)
      if command -v npm >/dev/null 2>&1; then
        SITE_BUILD_RUNNER=host
      else
        SITE_BUILD_RUNNER=docker
      fi
      ;;
    host|docker)
      ;;
    *)
      echo "SITE_BUILD_RUNNER must be auto, host, or docker" >&2
      exit 1
      ;;
  esac
}

build_site() {
  resolve_site_runner
  if [[ "$SITE_BUILD_RUNNER" == "host" ]]; then
    npm --prefix "$APP_ROOT" run build:site
    return
  fi

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e npm_config_cache=/tmp/.npm \
    -v "$APP_ROOT:/workspace" \
    -w /workspace \
    "$SITE_NODE_IMAGE" \
    sh -lc "npm ci && npm run build:site"
}

apply_caddy() {
  if [[ -z "${APP_BASIC_AUTH_USER:-}" ]]; then
    echo "Skipping Caddy render: APP_BASIC_AUTH_USER is not set." >&2
    echo "Set APP_BASIC_AUTH_USER plus APP_BASIC_AUTH_PASSWORD or APP_BASIC_AUTH_PASSWORD_HASH to deploy Caddy changes." >&2
    return 0
  fi

  if [[ -z "${APP_BASIC_AUTH_PASSWORD:-}" && -z "${APP_BASIC_AUTH_PASSWORD_HASH:-}" ]]; then
    echo "Skipping Caddy render: no app basic-auth password/hash set." >&2
    return 0
  fi

  "$APP_ROOT/scripts/ops/render-caddyfile.sh" "$STACK_ROOT/Caddyfile"
  docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    restart caddy
}

read_current_indexer_schema() {
  if [[ -f "$INDEXER_ENV_FILE" ]]; then
    awk -F= '/^DATABASE_SCHEMA=/{ sub(/^DATABASE_SCHEMA=/, ""); print; exit }' "$INDEXER_ENV_FILE" | tr -d '"'
  fi
}

validate_indexer_schema() {
  local schema="$1"
  if [[ ${#schema} -gt 63 || ! "$schema" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "Indexer DATABASE_SCHEMA must be a lowercase PostgreSQL identifier up to 63 characters: $schema" >&2
    exit 1
  fi
}

write_indexer_schema() {
  local schema="$1"

  if [[ ! -f "$INDEXER_ENV_FILE" ]]; then
    echo "Missing indexer env file at $INDEXER_ENV_FILE; cannot set DATABASE_SCHEMA." >&2
    exit 1
  fi

  local tmp
  tmp=$(mktemp)
  awk '!/^DATABASE_SCHEMA=/' "$INDEXER_ENV_FILE" > "$tmp"
  printf 'DATABASE_SCHEMA=%s\n' "$schema" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$INDEXER_ENV_FILE"

  echo "Updated indexer DATABASE_SCHEMA in $INDEXER_ENV_FILE: $schema"
  RUN_INDEXER=1
}

apply_indexer_database_schema() {
  local current_schema=""
  current_schema=$(read_current_indexer_schema)
  if [[ -n "$current_schema" ]]; then
    echo "Current indexer DATABASE_SCHEMA in $INDEXER_ENV_FILE: $current_schema"
  else
    echo "No DATABASE_SCHEMA set in $INDEXER_ENV_FILE; indexer will use Ponder's default."
  fi

  case "$INDEXER_FRESH_SCHEMA" in
    1|true|yes) ;;
    0|false|no|"") INDEXER_FRESH_SCHEMA=0 ;;
    *)
      echo "Invalid INDEXER_FRESH_SCHEMA toggle: $INDEXER_FRESH_SCHEMA (expected 0 or 1)" >&2
      exit 1
      ;;
  esac

  if [[ -n "$INDEXER_DATABASE_SCHEMA" && "$INDEXER_FRESH_SCHEMA" == "1" ]]; then
    echo "INDEXER_DATABASE_SCHEMA and INDEXER_FRESH_SCHEMA=1 are mutually exclusive." >&2
    echo "Pass either an explicit schema name OR set INDEXER_FRESH_SCHEMA=1, not both." >&2
    exit 1
  fi

  local target_schema=""
  if [[ -n "$INDEXER_DATABASE_SCHEMA" ]]; then
    validate_indexer_schema "$INDEXER_DATABASE_SCHEMA"
    target_schema="$INDEXER_DATABASE_SCHEMA"
    echo "Operator pinned indexer DATABASE_SCHEMA: $target_schema"
  elif [[ "$INDEXER_FRESH_SCHEMA" == "1" ]]; then
    target_schema="agent_indexer_$(date -u +%Y%m%d%H%M%S)"
    validate_indexer_schema "$target_schema"
    echo "INDEXER_FRESH_SCHEMA=1 — minting fresh DATABASE_SCHEMA: $target_schema"
  else
    return 0
  fi

  if [[ -n "$current_schema" && "$current_schema" != "$target_schema" ]]; then
    echo "Replacing existing DATABASE_SCHEMA ($current_schema) with $target_schema."
  fi

  write_indexer_schema "$target_schema"
}

deploy() {
  echo "Production deploy lock acquired: $DEPLOY_LOCK_FILE"
  echo "Updating repo in $APP_ROOT"
  if [[ -n "$DEPLOY_OLD_SHA" || -n "$DEPLOY_NEW_SHA" ]]; then
    if [[ -z "$DEPLOY_OLD_SHA" || -z "$DEPLOY_NEW_SHA" ]]; then
      echo "DEPLOY_OLD_SHA and DEPLOY_NEW_SHA must be set together." >&2
      exit 1
    fi
    OLD_SHA="$DEPLOY_OLD_SHA"
    NEW_SHA=$(git -C "$APP_ROOT" rev-parse HEAD)
    if [[ "$NEW_SHA" != "$DEPLOY_NEW_SHA" ]]; then
      echo "Checkout SHA $NEW_SHA does not match DEPLOY_NEW_SHA $DEPLOY_NEW_SHA." >&2
      exit 1
    fi
    echo "Using pre-updated checkout from workflow wrapper."
  else
    OLD_SHA=$(git -C "$APP_ROOT" rev-parse HEAD)
    git -C "$APP_ROOT" fetch origin "$BRANCH"
    git -C "$APP_ROOT" checkout "$BRANCH"
    pull_latest
    NEW_SHA=$(git -C "$APP_ROOT" rev-parse HEAD)
  fi
  echo "Deploy range: $OLD_SHA -> $NEW_SHA"

  if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
    echo "No new commits. Running smoke check only."
  fi

  initialize_component_state
  apply_indexer_database_schema
  configure_bootstrap_instrumentation_env

  local run_backend=0
  local run_indexer=0
  local run_frontend=0
  local run_site=0
  local run_caddy=0

  if backend_env_requires_deploy || should_run backend "$RUN_BACKEND" '^(mcp-server/|sdk/|examples/|docs/schemas/|package(-lock)?\.json|scripts/ops/redeploy-backend\.sh)'; then
    run_backend=1
    echo "Deploying backend"
    SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-backend.sh"
    mark_component_deployed backend
  else
    echo "Skipping backend deploy"
    if [[ "$RUN_BACKEND" == "auto" ]]; then
      mark_component_deployed backend
    fi
  fi

  if should_run indexer "$RUN_INDEXER" '^(indexer/|package(-lock)?\.json|scripts/ops/redeploy-indexer\.sh)'; then
    run_indexer=1
    echo "Deploying indexer"
    SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-indexer.sh"
    mark_component_deployed indexer
  else
    echo "Skipping indexer deploy"
    if [[ "$RUN_INDEXER" == "auto" ]]; then
      mark_component_deployed indexer
    fi
  fi

  if should_run frontend "$RUN_FRONTEND" '^(app/|frontend/|scripts/sync-operator-frontend\.mjs|scripts/ops/redeploy-frontend\.sh|scripts/ops/deploy-production\.sh|package(-lock)?\.json)'; then
    run_frontend=1
    echo "Deploying operator frontend"
    SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-frontend.sh"
    mark_component_deployed frontend
  else
    echo "Skipping operator frontend deploy"
    if [[ "$RUN_FRONTEND" == "auto" ]]; then
      mark_component_deployed frontend
    fi
  fi

  if should_run site "$RUN_SITE" '^(marketing/|site/|scripts/sync-marketing-site\.mjs|package(-lock)?\.json)'; then
    run_site=1
    echo "Building public site"
    build_site
    mark_component_deployed site
  else
    echo "Skipping public site build"
    if [[ "$RUN_SITE" == "auto" ]]; then
      mark_component_deployed site
    fi
  fi

  if should_run caddy "$RUN_CADDY" '^(deploy/Caddyfile\.averray|scripts/ops/render-caddyfile\.sh)'; then
    run_caddy=1
    echo "Applying Caddy config"
    apply_caddy
    mark_component_deployed caddy
  else
    echo "Skipping Caddy config"
    if [[ "$RUN_CADDY" == "auto" ]]; then
      mark_component_deployed caddy
    fi
  fi

  if changed_matches '^(contracts/|script/|foundry\.toml|remappings\.txt)'; then
    echo "Contract-related files changed. Smart contracts still require an explicit contract deployment flow." >&2
  fi

  if [[ "$RUN_SMOKE" == "1" ]]; then
    echo "Running hosted stack smoke check"
    local check_indexer
    check_indexer=$(resolve_smoke_check_indexer "$run_indexer" "$run_caddy")
    if [[ "$check_indexer" != "1" ]]; then
      echo "Skipping indexer smoke checks because this deploy did not change indexer or Caddy."
    fi
    CHECK_INDEXER="$check_indexer" \
      CHECK_BOOTSTRAP_INSTRUMENTATION="$SMOKE_CHECK_BOOTSTRAP_INSTRUMENTATION" \
      CHECK_BOOTSTRAP_SELF_REPORT_SENT="$SMOKE_CHECK_BOOTSTRAP_SELF_REPORT_SENT" \
      CHECK_PRODUCT_PROOF_GATE="$SMOKE_CHECK_PRODUCT_PROOF_GATE" \
      "$APP_ROOT/scripts/ops/check-hosted-stack.sh"
  else
    echo "RUN_SMOKE=0 set; skipping hosted smoke check."
  fi

  echo "Production deploy completed."
}

resolve_smoke_check_indexer() {
  local ran_indexer="$1"
  local ran_caddy="$2"
  case "$SMOKE_CHECK_INDEXER" in
    1|true|yes) echo 1 ;;
    0|false|no) echo 0 ;;
    auto)
      if [[ "$OLD_SHA" == "$NEW_SHA" || "$ran_indexer" == "1" || "$ran_caddy" == "1" ]]; then
        echo 1
      else
        echo 0
      fi
      ;;
    *)
      echo "Invalid SMOKE_CHECK_INDEXER toggle: $SMOKE_CHECK_INDEXER" >&2
      exit 1
      ;;
  esac
}

exec 9>"$DEPLOY_LOCK_FILE"
with_lock
