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
# Honour APP_ROOT from the environment if the caller has set one (used by the
# regression tests which source this file from a fixture repo); otherwise
# resolve relative to the script's own location, the production behaviour.
APP_ROOT=${APP_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
BRANCH=${BRANCH:-main}
DEPLOY_LOCK_FILE=${DEPLOY_LOCK_FILE:-/tmp/averray-production-deploy.lock}
DEPLOY_AUTOSTASH=${DEPLOY_AUTOSTASH:-1}
DEPLOY_OLD_SHA=${DEPLOY_OLD_SHA:-}
DEPLOY_NEW_SHA=${DEPLOY_NEW_SHA:-}

RUN_BACKEND=${RUN_BACKEND:-auto}
RUN_FRONTEND=${RUN_FRONTEND:-auto}
RUN_INDEXER=${RUN_INDEXER:-auto}
RUN_SITE=${RUN_SITE:-auto}
RUN_CADDY=${RUN_CADDY:-auto}
RUN_SMOKE=${RUN_SMOKE:-1}
SMOKE_CHECK_INDEXER=${SMOKE_CHECK_INDEXER:-auto}
INDEXER_DATABASE_SCHEMA=${INDEXER_DATABASE_SCHEMA:-}
INDEXER_FRESH_SCHEMA=${INDEXER_FRESH_SCHEMA:-0}
INDEXER_ENV_FILE=${INDEXER_ENV_FILE:-"$STACK_ROOT/indexer.env"}
# Per-component "last-good SHA" markers. Each component (backend, indexer,
# operator-frontend, public-site, caddy) records the SHA at which it last
# deployed cleanly. This is the *lower bound* of the diff range used to decide
# whether the component needs to redeploy on the next run, decoupling per-
# component routing from the wrapper-wide OLD_SHA → NEW_SHA range. Without
# this, a failed deploy that bumps the wrapper-wide pointer past commits a
# *later* component would have wanted to ship causes those commits to be
# silently skipped forever (issue #124). Default location is alongside
# indexer.env so all deploy state lives in one place.
COMPONENT_STATE_DIR=${COMPONENT_STATE_DIR:-"$STACK_ROOT"}

SITE_BUILD_RUNNER=${SITE_BUILD_RUNNER:-auto}
SITE_NODE_IMAGE=${SITE_NODE_IMAGE:-node:22-bookworm-slim}

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

should_run() {
  local setting="$1"
  local pattern="$2"
  case "$setting" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
    auto) changed_matches "$pattern" ;;
    *)
      echo "Invalid deploy toggle: $setting" >&2
      exit 1
      ;;
  esac
}

# Return the SHA at which $1 last deployed cleanly, or empty string if no
# marker has been written yet. The caller treats "empty" as "fall back to
# wrapper-wide OLD_SHA" so we don't accidentally redeploy years of history
# on the first run after this feature ships.
read_component_last_good() {
  local component="$1"
  local marker="$COMPONENT_STATE_DIR/$component.last-good-sha"
  if [[ -f "$marker" ]]; then
    # tr -d '\n' so trailing newlines from `printf '%s\n' ... > marker` don't
    # leak into git ref comparisons later.
    tr -d '\n' < "$marker"
  fi
}

write_component_last_good() {
  local component="$1"
  local sha="$2"
  local marker="$COMPONENT_STATE_DIR/$component.last-good-sha"
  if [[ -z "$sha" || ! "$sha" =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "Refusing to write invalid SHA to $marker: '$sha'" >&2
    return 1
  fi
  printf '%s\n' "$sha" > "$marker"
  chmod 600 "$marker" || true
  echo "Marked $component last-good-sha = $sha"
}

# Decide whether $component needs to redeploy. Lower bound is the component's
# last-good SHA (or wrapper-wide OLD_SHA if no marker), upper bound is
# wrapper-wide NEW_SHA. This is the core fix for issue #124: when a previous
# deploy failed at component step N, components N+1..end were skipped, so
# those components' last-good markers stayed put — meaning their next-deploy
# diff range still includes the changes the failed run would have shipped.
component_changed_matches() {
  local component="$1"
  local pattern="$2"
  local lower
  lower=$(read_component_last_good "$component")
  if [[ -z "$lower" ]]; then
    lower="$OLD_SHA"
  fi
  if [[ "$lower" == "$NEW_SHA" ]]; then
    return 1
  fi
  # If the lower bound isn't reachable from NEW_SHA (e.g. force-push,
  # squash-merge that rewrote history, or operator deleted/recreated the repo
  # checkout), fall back to OLD_SHA so we don't error out on the diff. The
  # operator can always force a deploy via RUN_<COMPONENT>=1.
  if ! git -C "$APP_ROOT" merge-base --is-ancestor "$lower" "$NEW_SHA" 2>/dev/null; then
    echo "Note: $component last-good-sha ($lower) not reachable from NEW_SHA ($NEW_SHA); falling back to wrapper-wide OLD_SHA." >&2
    lower="$OLD_SHA"
    if [[ "$lower" == "$NEW_SHA" ]]; then
      return 1
    fi
  fi
  git -C "$APP_ROOT" diff --name-only "$lower" "$NEW_SHA" | grep -Eq "$pattern"
}

should_run_component() {
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

print_component_state() {
  local component
  for component in backend indexer operator-frontend public-site caddy; do
    local last
    last=$(read_component_last_good "$component")
    if [[ -n "$last" ]]; then
      printf '  %-18s last-good = %s\n' "$component" "$last"
    else
      printf '  %-18s last-good = (none — will use wrapper-wide OLD_SHA)\n' "$component"
    fi
  done
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

  apply_indexer_database_schema

  local run_backend=0
  local run_indexer=0
  local run_frontend=0
  local run_site=0
  local run_caddy=0

  echo "Per-component last-good SHAs at start of deploy:"
  print_component_state

  # Each component is wrapped in `if SCRIPT; then write_marker; else exit 1`.
  # The script itself uses `set -e` so component failures already halt the
  # wrapper at the first failing step. We keep that behaviour here — this PR
  # is about making the *diff range used for routing* per-component, not
  # about changing what happens on failure. The marker is written only on
  # full success of that component, so a future failed deploy that skips
  # later components will leave their last-good markers untouched and the
  # *next* deploy will still see those components' overdue commits in their
  # per-component diff range.
  if should_run_component "backend" "$RUN_BACKEND" '^(mcp-server/|sdk/|examples/|docs/schemas/|package(-lock)?\.json|scripts/ops/redeploy-backend\.sh)'; then
    run_backend=1
    echo "Deploying backend"
    if SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-backend.sh"; then
      write_component_last_good "backend" "$NEW_SHA"
    else
      echo "Backend deploy step exited non-zero; not updating last-good marker." >&2
      exit 1
    fi
  else
    echo "Skipping backend deploy"
  fi

  if should_run_component "indexer" "$RUN_INDEXER" '^(indexer/|package(-lock)?\.json|scripts/ops/redeploy-indexer\.sh)'; then
    run_indexer=1
    echo "Deploying indexer"
    if SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-indexer.sh"; then
      write_component_last_good "indexer" "$NEW_SHA"
    else
      echo "Indexer deploy step exited non-zero; not updating last-good marker." >&2
      exit 1
    fi
  else
    echo "Skipping indexer deploy"
  fi

  if should_run_component "operator-frontend" "$RUN_FRONTEND" '^(app/|frontend/|scripts/sync-operator-frontend\.mjs|scripts/ops/redeploy-frontend\.sh|scripts/ops/deploy-production\.sh|package(-lock)?\.json)'; then
    run_frontend=1
    echo "Deploying operator frontend"
    if SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-frontend.sh"; then
      write_component_last_good "operator-frontend" "$NEW_SHA"
    else
      echo "Operator frontend deploy step exited non-zero; not updating last-good marker." >&2
      exit 1
    fi
  else
    echo "Skipping operator frontend deploy"
  fi

  if should_run_component "public-site" "$RUN_SITE" '^(marketing/|site/|scripts/sync-marketing-site\.mjs|package(-lock)?\.json)'; then
    run_site=1
    echo "Building public site"
    if build_site; then
      write_component_last_good "public-site" "$NEW_SHA"
    else
      echo "Public site build step exited non-zero; not updating last-good marker." >&2
      exit 1
    fi
  else
    echo "Skipping public site build"
  fi

  if should_run_component "caddy" "$RUN_CADDY" '^(deploy/Caddyfile\.averray|scripts/ops/render-caddyfile\.sh)'; then
    run_caddy=1
    echo "Applying Caddy config"
    if apply_caddy; then
      write_component_last_good "caddy" "$NEW_SHA"
    else
      echo "Caddy apply step exited non-zero; not updating last-good marker." >&2
      exit 1
    fi
  else
    echo "Skipping Caddy config"
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
    CHECK_INDEXER="$check_indexer" "$APP_ROOT/scripts/ops/check-hosted-stack.sh"
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

# Only run the locked deploy when this file is invoked as a script (not when
# sourced by the test runner). `BASH_SOURCE[0] == $0` is true exactly when
# bash has executed the file directly. When sourced, `$0` is the parent
# shell's name (e.g. "bash", "node"), and $BASH_SOURCE[0] is this file's
# path — so the strings differ.
if [[ "${BASH_SOURCE[0]:-}" == "${0:-}" ]]; then
  exec 9>"$DEPLOY_LOCK_FILE"
  with_lock
fi
