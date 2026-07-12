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
#   INDEXER_SCHEMA_SELF_HEAL=0
#                         disable the exact-match Ponder build-identity recovery
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
INDEXER_SCHEMA_SELF_HEAL=${INDEXER_SCHEMA_SELF_HEAL:-1}
INDEXER_ENV_FILE=${INDEXER_ENV_FILE:-/run/agent-stack/indexer.env}
DEPLOY_STATE_DIR=${DEPLOY_STATE_DIR:-"$STACK_ROOT/.deploy-state"}
INDEXER_SCHEMA_STATE_FILE=${INDEXER_SCHEMA_STATE_FILE:-"$DEPLOY_STATE_DIR/indexer.database-schema"}
INDEXER_RECOVERY_STATE_FILE=${INDEXER_RECOVERY_STATE_FILE:-"$DEPLOY_STATE_DIR/indexer.recovery.env"}
INDEXER_SCHEMA_BACKUP_DIR=${INDEXER_SCHEMA_BACKUP_DIR:-"$STACK_ROOT/backups/postgres"}
LAST_INDEXER_LOG=""

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
  LAST_INDEXER_LOG=$(
    docker compose \
      --project-directory "$STACK_ROOT" \
      -f "$COMPOSE_FILE" \
      logs --tail="$INDEXER_LOG_TAIL" indexer 2>&1 || true
  )
  printf '%s\n' "$LAST_INDEXER_LOG"

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
    printf '%s\n' "$LAST_INDEXER_LOG" \
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

validate_schema_name() {
  local schema="$1"
  [[ ${#schema} -le 63 && "$schema" =~ ^[a-z_][a-z0-9_]*$ ]]
}

configured_indexer_schema() {
  [[ -f "$INDEXER_ENV_FILE" ]] || return 1
  awk -F= '/^DATABASE_SCHEMA=/{value=$0; sub(/^[^=]*=/, "", value)} END{print value}' "$INDEXER_ENV_FILE"
}

identity_mismatch_schema() {
  printf '%s\n' "$LAST_INDEXER_LOG" \
    | sed -n 's/.*MigrationError: Schema "\([a-z_][a-z0-9_]*\)" was previously used by a different Ponder app\. Drop the schema first, or use a different schema\..*/\1/p' \
    | sort -u
}

backup_indexer_schema() {
  local schema="$1"
  local stamp="$2"
  local backup="$INDEXER_SCHEMA_BACKUP_DIR/indexer-schema-${schema}-${stamp}.dump"
  local tmp="${backup}.tmp.$$"

  mkdir -p "$INDEXER_SCHEMA_BACKUP_DIR" || return 1
  [[ ! -e "$backup" ]] || return 1
  if ! docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --schema="$1"' sh "$schema" \
    > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if [[ ! -s "$tmp" ]] || ! docker compose \
    --project-directory "$STACK_ROOT" \
    -f "$COMPOSE_FILE" \
    exec -T postgres pg_restore --list < "$tmp" >/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$backup"
  printf '%s\n' "$backup"
}

write_self_heal_state() {
  local previous_schema="$1"
  local fresh_schema="$2"
  local recovered_at="$3"
  local backup_file="$4"

  [[ -f "$INDEXER_ENV_FILE" ]] || return 1
  validate_schema_name "$previous_schema" || return 1
  validate_schema_name "$fresh_schema" || return 1
  [[ "$recovered_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  [[ "$(basename "$backup_file")" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  mkdir -p "$DEPLOY_STATE_DIR" || return 1

  local state_tmp="${INDEXER_RECOVERY_STATE_FILE}.tmp.$$"
  local schema_tmp="${INDEXER_SCHEMA_STATE_FILE}.tmp.$$"
  {
    printf 'INDEXER_LAST_STARTUP_ERROR=ponder_schema_identity_mismatch\n'
    printf 'INDEXER_LAST_RECOVERY_AT=%s\n' "$recovered_at"
    printf 'INDEXER_LAST_RECOVERY_FROM_SCHEMA=%s\n' "$previous_schema"
    printf 'INDEXER_LAST_RECOVERY_TO_SCHEMA=%s\n' "$fresh_schema"
    printf 'INDEXER_LAST_RECOVERY_BACKUP=%s\n' "$(basename "$backup_file")"
  } > "$state_tmp"
  printf '%s\n' "$fresh_schema" > "$schema_tmp"
  mv "$schema_tmp" "$INDEXER_SCHEMA_STATE_FILE"
  mv "$state_tmp" "$INDEXER_RECOVERY_STATE_FILE"

  local env_tmp
  env_tmp=$(mktemp)
  awk '!/^(DATABASE_SCHEMA|INDEXER_LAST_STARTUP_ERROR|INDEXER_LAST_RECOVERY_AT|INDEXER_LAST_RECOVERY_FROM_SCHEMA|INDEXER_LAST_RECOVERY_TO_SCHEMA|INDEXER_LAST_RECOVERY_BACKUP)=/' \
    "$INDEXER_ENV_FILE" > "$env_tmp"
  printf 'DATABASE_SCHEMA=%s\n' "$fresh_schema" >> "$env_tmp"
  cat "$INDEXER_RECOVERY_STATE_FILE" >> "$env_tmp"

  local mode owner_group
  mode=$(stat -c '%a' "$INDEXER_ENV_FILE")
  owner_group=$(stat -c '%U:%G' "$INDEXER_ENV_FILE")
  chmod "$mode" "$env_tmp"
  sudo chown "$owner_group" "$env_tmp"
  sudo mv "$env_tmp" "$INDEXER_ENV_FILE"

}

reapply_persisted_self_heal_state() {
  [[ -f "$INDEXER_RECOVERY_STATE_FILE" && -f "$INDEXER_SCHEMA_STATE_FILE" ]] || return 0

  local previous_schema fresh_schema metadata_schema recovered_at backup_file error_code
  error_code=$(awk -F= '$1=="INDEXER_LAST_STARTUP_ERROR"{print substr($0, index($0,"=")+1)}' "$INDEXER_RECOVERY_STATE_FILE")
  recovered_at=$(awk -F= '$1=="INDEXER_LAST_RECOVERY_AT"{print substr($0, index($0,"=")+1)}' "$INDEXER_RECOVERY_STATE_FILE")
  previous_schema=$(awk -F= '$1=="INDEXER_LAST_RECOVERY_FROM_SCHEMA"{print substr($0, index($0,"=")+1)}' "$INDEXER_RECOVERY_STATE_FILE")
  metadata_schema=$(awk -F= '$1=="INDEXER_LAST_RECOVERY_TO_SCHEMA"{print substr($0, index($0,"=")+1)}' "$INDEXER_RECOVERY_STATE_FILE")
  fresh_schema=$(tr -d '[:space:]' < "$INDEXER_SCHEMA_STATE_FILE")
  backup_file=$(awk -F= '$1=="INDEXER_LAST_RECOVERY_BACKUP"{print substr($0, index($0,"=")+1)}' "$INDEXER_RECOVERY_STATE_FILE")

  [[ "$error_code" == "ponder_schema_identity_mismatch" ]] || return 1
  validate_schema_name "$previous_schema" || return 1
  validate_schema_name "$fresh_schema" || return 1
  [[ "$metadata_schema" == "$fresh_schema" ]] || return 1
  [[ "$recovered_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  [[ "$backup_file" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  write_self_heal_state "$previous_schema" "$fresh_schema" "$recovered_at" "$backup_file"
}

try_schema_identity_self_heal() {
  [[ "$INDEXER_SCHEMA_SELF_HEAL" == "1" ]] || return 1

  local configured_schema mismatch_schema mismatch_count
  configured_schema=$(configured_indexer_schema) || return 1
  mismatch_schema=$(identity_mismatch_schema)
  mismatch_count=$(printf '%s\n' "$mismatch_schema" | awk 'NF{count++} END{print count+0}')
  if [[ "$mismatch_count" != "1" || "$mismatch_schema" != "$configured_schema" ]]; then
    return 1
  fi
  if ! validate_schema_name "$configured_schema"; then
    echo "Refusing indexer schema self-heal: invalid configured schema name: $configured_schema" >&2
    return 1
  fi

  local stamp recovered_at fresh_schema backup_file
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  recovered_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  fresh_schema="agent_indexer_$(date -u +%Y%m%d%H%M%S)"
  validate_schema_name "$fresh_schema" || return 1

  echo "Exact Ponder build-identity mismatch detected for $configured_schema."
  echo "Creating schema-only backup before self-heal; the old schema will not be modified or dropped."
  backup_file=$(backup_indexer_schema "$configured_schema" "$stamp") || {
    echo "Indexer schema self-heal refused: schema-only backup failed validation." >&2
    return 1
  }
  write_self_heal_state "$configured_schema" "$fresh_schema" "$recovered_at" "$backup_file" || {
    echo "Indexer schema self-heal refused: could not persist the fresh schema and recovery metadata." >&2
    return 1
  }

  echo "Indexer schema self-heal prepared:"
  echo "  previous_schema=$configured_schema (preserved)"
  echo "  fresh_schema=$fresh_schema"
  echo "  backup=$backup_file"
  compose_up
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
  if ! git -C "$APP_ROOT" checkout --quiet "$PREVIOUS_SHA"; then
    echo "Rollback: git checkout $PREVIOUS_SHA failed. Working tree may be dirty or the SHA may be unreachable." >&2
    echo "Manual intervention required: inspect $APP_ROOT for uncommitted changes or fetch the missing commit." >&2
    exit 1
  fi

  # Verify the checkout actually moved HEAD. Mirrors the guard added to
  # redeploy-backend.sh::rollback in #467 after the Phase 5a Stage 2C-3
  # outage post-mortem (2026-05-21) showed `git rev-parse HEAD` still
  # pointing at the failed-deploy SHA after the backend rollback claimed
  # to have run. The indexer has the same shape of rollback flow, so it
  # gets the same shape of guard.
  local checked_out_head
  checked_out_head=$(git -C "$APP_ROOT" rev-parse HEAD)
  if [[ "$checked_out_head" != "$PREVIOUS_SHA" ]]; then
    echo "Rollback checkout did NOT move HEAD: expected $PREVIOUS_SHA, got $checked_out_head." >&2
    echo "Manual intervention required: the working tree is still at the failed-deploy SHA." >&2
    exit 1
  fi
  echo "Working tree restored to $PREVIOUS_SHA"

  # Re-render /run/agent-stack/indexer.env from the rolled-back template.
  # Without this step the rendered env on disk still reflects the FAILED
  # deploy's template — restoring just the code while leaving the new env
  # in place can produce mismatched runtime state (e.g. an
  # INDEXER_DATABASE_SCHEMA that points at a fresh-mint schema the rolled-
  # back code doesn't know about, or env vars the rolled-back code still
  # expects). Same class of gap that bit the backend in #455/#456 and was
  # closed for the backend in #467; this PR closes the symmetric gap for
  # the indexer.
  local render_script="$APP_ROOT/scripts/ops/render-vps-env.sh"
  local template="$APP_ROOT/deploy/indexer.env.template"
  local target="/run/agent-stack/indexer.env"
  local token="/etc/agent-stack/op-indexer.env"

  if [[ -x "$render_script" && -f "$template" && -f "$token" ]]; then
    echo "Re-rendering $target from $template @ $PREVIOUS_SHA"
    if ! sudo bash "$render_script" "$template" "$target" "$token"; then
      echo "Rollback env re-render failed; indexer may boot with NEW-deploy env on OLD-deploy code." >&2
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

  if ! reapply_persisted_self_heal_state; then
    echo "Rollback could not restore persisted indexer schema-recovery metadata." >&2
    exit 1
  fi

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
  if try_schema_identity_self_heal; then
    echo "Waiting for indexer health after isolated-schema self-heal."
    if ! wait_for_ok "$HEALTH_URL" "$HEALTH_TIMEOUT_SEC" "Self-heal health check"; then
      dump_indexer_diagnostics
      rollback
    fi
  else
    rollback
  fi
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
