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
INDEXER_SCHEMA_STATE_FILE=${INDEXER_SCHEMA_STATE_FILE:-"$DEPLOY_STATE_DIR/indexer.database-schema"}

RUN_BACKEND=${RUN_BACKEND:-auto}
RUN_FRONTEND=${RUN_FRONTEND:-auto}
RUN_INDEXER=${RUN_INDEXER:-auto}
RUN_SITE=${RUN_SITE:-auto}
RUN_CADDY=${RUN_CADDY:-auto}
RUN_SMOKE=${RUN_SMOKE:-1}
SMOKE_CHECK_INDEXER=${SMOKE_CHECK_INDEXER:-auto}
SMOKE_CHECK_BOOTSTRAP_INSTRUMENTATION=${SMOKE_CHECK_BOOTSTRAP_INSTRUMENTATION:-0}
SMOKE_CHECK_BOOTSTRAP_SELF_REPORT_SENT=${SMOKE_CHECK_BOOTSTRAP_SELF_REPORT_SENT:-0}
BOOTSTRAP_SELF_REPORT_SEND_NOW=${BOOTSTRAP_SELF_REPORT_SEND_NOW:-0}
BOOTSTRAP_SELF_REPORT_IDEMPOTENCY_KEY=${BOOTSTRAP_SELF_REPORT_IDEMPOTENCY_KEY:-}
SMOKE_CHECK_PRODUCT_PROOF_GATE=${SMOKE_CHECK_PRODUCT_PROOF_GATE:-0}
PRODUCT_PROOF_REQUIRE_WORKER_LOOP=${PRODUCT_PROOF_REQUIRE_WORKER_LOOP:-0}
# Optional override for the hosted worker-loop's reward asset symbol. Empty
# string keeps run-hosted-worker-loop.mjs on the canonical v1 USDC settlement
# path; non-USDC values fail closed before mutation.
PRODUCT_PROOF_REWARD_ASSET=${PRODUCT_PROOF_REWARD_ASSET:-}
PRODUCT_PROOF_EVIDENCE_FILE=${PRODUCT_PROOF_EVIDENCE_FILE:-"$STACK_ROOT/product-proof-worker-loop-evidence.json"}
if [[ "$PRODUCT_PROOF_EVIDENCE_FILE" != /* ]]; then
  PRODUCT_PROOF_EVIDENCE_FILE="$APP_ROOT/$PRODUCT_PROOF_EVIDENCE_FILE"
fi
PRODUCT_PROOF_NODE_IMAGE=${PRODUCT_PROOF_NODE_IMAGE:-node:22-bookworm-slim}
INDEXER_DATABASE_SCHEMA=${INDEXER_DATABASE_SCHEMA:-}
INDEXER_FRESH_SCHEMA=${INDEXER_FRESH_SCHEMA:-0}
INDEXER_ENV_FILE=${INDEXER_ENV_FILE:-/run/agent-stack/indexer.env}
# BACKEND_ENV_FILE: removed in PR 2.6 — backend env now rendered to
# /run/agent-stack/backend.env by render_runtime_envs (1Password →
# op inject → /run); /srv/agent-stack/backend.env is no longer written.

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
require_command jq

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

# quote_env_value / upsert_env_values / upsert_env_values_if_changed /
# configure_settlement_env / configure_bootstrap_instrumentation_env /
# backend_env_requires_deploy: all retired in Phase 2 PR 2.6.
#
# Why: these wrote derived settlement (RPC URLs, contract addresses,
# SUPPORTED_ASSETS_JSON) and bootstrap instrumentation (RESEND_API_KEY,
# BOOTSTRAP_SELF_REPORT_*, UPSTREAM_STATUS_POLLER_*) to
# /srv/agent-stack/backend.env using shell-escape format (`KEY="\""val\""..."`).
# That format round-trips fine through `set -a; . file; set +a` but
# breaks docker-compose's env_file: parser, which takes the value
# literally after stripping surrounding quotes. With PR 2.5's cutover
# making /run/agent-stack/backend.env the authoritative compose source,
# the /srv writes were both redundant (the template has the same values
# byte-for-byte) AND dangerous (a copy-paste from /srv into the template
# leaked the broken escape format and caused the 19:33Z outage on
# 2026-05-12 — see PR #249).
#
# The template (deploy/backend.env.template) is now the single source
# of truth for settlement + instrumentation values. CI guards against
# drift between deployments/testnet.json and the template via
# scripts/ops/check-template-matches-manifest.mjs.
#
# Caller-side change: backend_env_requires_deploy was a redeploy
# trigger when /srv/backend.env got rewritten. Without those writes,
# the trigger now is: deploy/backend.env.template or
# deployments/testnet.json changed since the last good backend deploy.
# See should_run backend below.

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

# Phase 2 PR 2.7d.1 follow-up: wait for backend /health to return 200
# after a force-recreate (the PR 2.7d.1 fast-path that only re-renders
# /run/agent-stack/backend.env without going through redeploy-backend.sh).
#
# Why this exists: when the trigger for backend redeploy is JUST an env
# content change (no code path changed), deploy-production.sh skips
# redeploy-backend.sh and does `docker compose up -d --force-recreate
# backend` inline. That gets the container restarted quickly, but the
# script then continues straight to `check-hosted-stack.sh`, which
# probes https://api.averray.com/health. The 14:30Z deploy on 2026-05-13
# was the canary: smoke check hit /health 1 second after `Container
# agent-backend Started`, got 502 (backend was still bootstrapping),
# and the deploy was marked failure even though the recreate succeeded.
# redeploy-backend.sh has its own wait_for_health for the full-deploy
# path; this helper mirrors that for the force-recreate fast-path.
#
# Returns 0 on health, non-zero (and emits an error) on timeout.
wait_for_backend_health() {
  local health_url="${HEALTH_URL:-https://api.averray.com/health}"
  local timeout="${HEALTH_TIMEOUT_SEC:-60}"
  local interval="${HEALTH_INTERVAL_SEC:-3}"
  local deadline=$(( $(date +%s) + timeout ))
  local attempts=0
  echo "Phase 2 PR 2.7d.1: waiting for backend health at $health_url (timeout ${timeout}s)"
  while [[ $(date +%s) -lt $deadline ]]; do
    attempts=$(( attempts + 1 ))
    if curl -fsS --max-time 5 "$health_url" >/dev/null 2>&1; then
      echo "Backend health check passed after ${attempts} attempt(s)."
      return 0
    fi
    sleep "$interval"
  done
  echo "ERROR: backend /health did not return 200 within ${timeout}s after force-recreate." >&2
  echo "       Container recreate likely succeeded but bootstrap is failing." >&2
  echo "       Check 'sudo docker logs agent-backend --tail 100' on the VPS." >&2
  return 1
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

run_node_script() {
  local script="$1"
  shift

  if command -v node >/dev/null 2>&1; then
    node "$script" "$@"
    return
  fi

  local relative_script="${script#$APP_ROOT/}"
  local product_proof_evidence_dir
  product_proof_evidence_dir="$(dirname "$PRODUCT_PROOF_EVIDENCE_FILE")"
  mkdir -p "$product_proof_evidence_dir"
  docker run --rm \
    -v "$APP_ROOT:/workspace" \
    -v "$product_proof_evidence_dir:$product_proof_evidence_dir" \
    -w /workspace \
    -e API_BASE_URL="${API_BASE_URL:-https://api.averray.com}" \
    -e ADMIN_JWT="${ADMIN_JWT:-}" \
    -e AVERRAY_TOKEN="${AVERRAY_TOKEN:-}" \
    -e PRODUCT_PROOF_WORKER_TOKEN="${PRODUCT_PROOF_WORKER_TOKEN:-}" \
    -e PRODUCT_PROOF_EVIDENCE_FILE="$PRODUCT_PROOF_EVIDENCE_FILE" \
    -e PRODUCT_PROOF_REWARD_ASSET="${PRODUCT_PROOF_REWARD_ASSET:-}" \
    -e PRODUCT_PROOF_REWARD_AMOUNT="${PRODUCT_PROOF_REWARD_AMOUNT:-}" \
    -e PRODUCT_PROOF_JOB_ID="${PRODUCT_PROOF_JOB_ID:-}" \
    -e PRODUCT_PROOF_IDEMPOTENCY_KEY="${PRODUCT_PROOF_IDEMPOTENCY_KEY:-}" \
    -e PRODUCT_PROOF_SUBMISSION="${PRODUCT_PROOF_SUBMISSION:-}" \
    "$PRODUCT_PROOF_NODE_IMAGE" \
    node "$relative_script" "$@"
}

run_product_proof_worker_loop() {
  case "$PRODUCT_PROOF_REQUIRE_WORKER_LOOP" in
    1|true|yes) ;;
    0|false|no|"") return 0 ;;
    *)
      echo "Invalid PRODUCT_PROOF_REQUIRE_WORKER_LOOP toggle: $PRODUCT_PROOF_REQUIRE_WORKER_LOOP" >&2
      exit 1
      ;;
  esac

  if [[ -z "${PRODUCT_PROOF_WORKER_TOKEN:-}" && -z "${AVERRAY_TOKEN:-}" && -z "${ADMIN_JWT:-}" ]]; then
    echo "PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1 requires PRODUCT_PROOF_WORKER_TOKEN, AVERRAY_TOKEN, or ADMIN_JWT." >&2
    exit 1
  fi

  echo "Running hosted product-proof worker loop"
  API_BASE_URL="${API_BASE_URL:-https://api.averray.com}" \
    run_node_script "$APP_ROOT/scripts/ops/run-hosted-worker-loop.mjs"
}

run_bootstrap_self_report_once() {
  case "$BOOTSTRAP_SELF_REPORT_SEND_NOW" in
    1|true|yes) ;;
    0|false|no|"") return 0 ;;
    *)
      echo "Invalid BOOTSTRAP_SELF_REPORT_SEND_NOW toggle: $BOOTSTRAP_SELF_REPORT_SEND_NOW" >&2
      exit 1
      ;;
  esac

  if [[ -z "${ADMIN_JWT:-}" ]]; then
    echo "BOOTSTRAP_SELF_REPORT_SEND_NOW=1 requires ADMIN_JWT." >&2
    exit 1
  fi

  local api_base
  api_base="${API_BASE_URL:-https://api.averray.com}"
  local idempotency_key
  idempotency_key="${BOOTSTRAP_SELF_REPORT_IDEMPOTENCY_KEY:-bootstrap-self-report-${NEW_SHA:-manual}-$(date -u +%Y%m%dT%H%M%SZ)}"

  echo "Sending bootstrap self-report once"
  local payload
  payload="$(jq -cn --arg idempotencyKey "$idempotency_key" '{idempotencyKey: $idempotencyKey}')"
  local result
  result="$(
    curl -fsS --max-time 60 \
      -X POST "$api_base/admin/bootstrap-self-report/send" \
      -H "accept: application/json" \
      -H "content-type: application/json" \
      -H "authorization: Bearer $ADMIN_JWT" \
      --data "$payload"
  )"
  jq -e '
    .ok == true and
    .result.status == "sent" and
    (.result.email.providerId | type) == "string" and
    (.result.email.providerId | length) > 0 and
    (.bootstrapSelfReport.lastSuccessfulAt | type) == "string"
  ' >/dev/null <<<"$result" || {
    echo "Bootstrap self-report send did not return sent evidence." >&2
    echo "$result" | jq '{ok, status: .result.status, skipped: .result.skipped, errors: .result.errors, lastFailureReason: .bootstrapSelfReport.lastFailureReason}' >&2
    exit 1
  }
  echo "Bootstrap self-report send confirmed."
}

# Phase 2 PR 2.4: render runtime env files via 1Password and check parity.
#
# At every deploy this function uses scripts/ops/render-vps-env.sh to write
# /run/agent-stack/{backend,indexer}.env from the in-repo templates, then
# compares against the legacy /srv/agent-stack/*.env. The compose env_file
# directive is NOT yet flipped — that's PR 2.5. This step exists to:
#
#   1. Prove the render works end-to-end on every deploy (not just the
#      manual smoke we did in PR 2.3 acceptance).
#   2. Surface drift between the in-repo template and the live env file
#      as a workflow `::warning::` annotation before the cutover, so we
#      catch operator-side edits that diverged from the template.
#
# Failure semantics are NON-BLOCKING for this PR. If render fails, log a
# warning and continue — the existing /srv path is still authoritative.
# PR 2.5's cutover will flip this to fail-closed once compose uses /run.
#
# Uses sudo because:
#   • /etc/agent-stack/op-*.env is mode 0400 root
#   • /run/agent-stack/ is mode 0700 root
#   • the deploy runs as the `ubuntu` user (passwordless sudo expected)
render_runtime_envs() {
  # Phase 2 PR 2.5: this function is now FAIL-CLOSED. As of the PR 2.5
  # compose env_file: flip on the VPS, /run/agent-stack/*.env is the
  # authoritative source consumed by docker-compose. A render failure
  # MUST abort the deploy before containers restart — otherwise the
  # backend would either consume a stale /run file from a previous
  # successful render, or fail to start when env_file is missing.
  #
  # Skip-clean conditions (deploy continues on legacy /srv path) only
  # apply during the bootstrap window — i.e., when the operator hasn't
  # yet installed op CLI / dropped service-account tokens / configured
  # tmpfiles. Once the bootstrap is complete on this VPS (which it is),
  # the script no longer hits the skip branches; render must succeed.
  local render_script="$APP_ROOT/scripts/ops/render-vps-env.sh"

  if [[ ! -x "$render_script" ]]; then
    echo "Phase 2 PR 2.5: render-vps-env.sh not present, skipping render"
    echo "  (this should only happen on a fresh VPS that hasn't been bootstrapped)"
    return 0
  fi

  if [[ ! -f /etc/agent-stack/op-backend.env ]] || [[ ! -f /etc/agent-stack/op-indexer.env ]]; then
    echo "Phase 2 PR 2.5: /etc/agent-stack/op-*.env not present, skipping render"
    echo "  (run scripts/ops/install-op-vps.sh and drop the service-account tokens to enable)"
    return 0
  fi

  if [[ ! -d /run/agent-stack ]]; then
    echo "Phase 2 PR 2.5: /run/agent-stack not present, skipping render"
    echo "  (install /etc/tmpfiles.d/agent-stack.conf and run systemd-tmpfiles --create)"
    return 0
  fi

  echo "Phase 2 PR 2.5: rendering runtime env files via op inject (fail-closed)"

  # Phase 2 PR 2.7d.1: track per-runtime env-content changes so the
  # caller can force-recreate the container even when no code path
  # changed. Without this, a pure 1Password value rotation updates
  # /run/agent-stack/<runtime>.env but the container keeps running
  # with the env it loaded at start — compose's env_file: handling
  # detects path changes but not content changes. The
  # RUNTIME_ENV_CHANGED_BACKEND / RUNTIME_ENV_CHANGED_INDEXER flags
  # below feed into deploy()'s should_run decisions further down.
  #
  # We use sha256 (not just timestamp) so a render that produces the
  # same content as before is a no-op signal — docker compose isn't
  # asked to recreate when nothing meaningful changed. /run files are
  # mode 0400 ubuntu:ubuntu, so the hash needs sudo to read them.
  RUNTIME_ENV_CHANGED_BACKEND=0
  RUNTIME_ENV_CHANGED_INDEXER=0

  local runtime
  for runtime in backend indexer; do
    local template="$APP_ROOT/deploy/${runtime}.env.template"
    local target="/run/agent-stack/${runtime}.env"
    local token="/etc/agent-stack/op-${runtime}.env"
    local legacy="$STACK_ROOT/${runtime}.env"

    if [[ ! -f "$template" ]]; then
      echo "ERROR: Phase 2 PR 2.5: $template missing — cannot render $runtime env" >&2
      return 1
    fi

    # Capture the pre-render content hash (if the file exists). Used
    # below to detect whether the render produced different content.
    local before_hash=""
    if sudo test -f "$target"; then
      before_hash=$(sudo sha256sum "$target" | awk '{print $1}')
    fi

    if ! sudo bash "$render_script" "$template" "$target" "$token"; then
      echo "ERROR: Phase 2 PR 2.5: render of $runtime failed — aborting deploy before container restart" >&2
      echo "       Containers consume /run/agent-stack/${runtime}.env via compose env_file:; stale or missing env would cause hard-to-diagnose failures downstream." >&2
      echo "       To roll back: edit /srv/agent-stack/docker-compose.yml to set env_file: back to /srv/agent-stack/${runtime}.env, then redeploy." >&2
      return 1
    fi

    # Compute post-render hash and compare. If different (or if there
    # was no prior file), flag the runtime for compose-level
    # force-recreate in deploy(). Hash prefixes are logged for
    # observability — they're not secrets (sha256 of the rendered
    # env file leaks the same bit of information as docker compose's
    # config hash already does in logs, and prefixes don't help an
    # attacker reverse the contents).
    local after_hash
    after_hash=$(sudo sha256sum "$target" | awk '{print $1}')
    if [[ "$before_hash" != "$after_hash" ]]; then
      local before_label="${before_hash:0:8}"
      [[ -z "$before_hash" ]] && before_label="(none)"
      echo "Phase 2 PR 2.7d.1: $runtime /run env content changed (before=$before_label, after=${after_hash:0:8}) — will force-recreate"
      case "$runtime" in
        backend) RUNTIME_ENV_CHANGED_BACKEND=1 ;;
        indexer) RUNTIME_ENV_CHANGED_INDEXER=1 ;;
      esac
    fi

    if [[ ! -f "$legacy" ]]; then
      echo "Phase 2 PR 2.5: $legacy missing — skipping parity check for $runtime"
      echo "  (this is expected once PR 2.6's cleanup deletes the legacy /srv files)"
      continue
    fi

    # Parity check (informational, non-blocking): compare the freshly
    # rendered /run file against the legacy /srv file. After PR 2.5's
    # compose flip, /run is authoritative; /srv lingers on disk for 24h
    # as a manual rollback option (PR 2.6 deletes it). Drift here means
    # the legacy file is stale — that's fine because nothing reads it
    # anymore. We log the warning so operators notice if something
    # weird happens (e.g., the legacy file mysteriously updating itself).
    #
    # Quote-strip normalization: the live /srv file uses `KEY="value"`,
    # the rendered template uses `KEY=value`. Docker Compose's env_file:
    # parser strips surrounding quotes from values — both forms produce
    # the same runtime value. Without normalizing here, every quoted
    # legacy line shows as drift even when the underlying value is
    # identical (this is what PR 2.4's first deploy logged as
    # "58 lines differ" — pure cosmetic noise).
    #
    # The normalizer:
    #   1. Filters to KEY=value lines (skips blanks, comments)
    #   2. Strips a single pair of surrounding double or single quotes
    #   3. Stores last-wins per key in awk map
    #   4. Emits KEY=value lines (no quotes)
    #
    # Run as one `sudo bash -c` so the process-substitutions and the read
    # of the 0400 /run/*.env file all happen as root.
    if sudo bash -c "
      normalize() {
        awk -F= '/^[A-Z][A-Z0-9_]*=/ {
          key = \$1
          # Everything after the first \"=\"
          val = substr(\$0, length(key) + 2)
          # Strip a single pair of surrounding quotes (\" or single-quote)
          if (length(val) >= 2) {
            first = substr(val, 1, 1)
            last  = substr(val, length(val), 1)
            if ((first == \"\\\"\" && last == \"\\\"\") || (first == \"'\\''\" && last == \"'\\''\")) {
              val = substr(val, 2, length(val) - 2)
            }
          }
          out[key] = key \"=\" val
        } END {
          for (k in out) print out[k]
        }' \"\$1\"
      }
      diff_output=\$(diff \
        <(normalize '$legacy' | sort) \
        <(normalize '$target' | sort))
      if [[ -z \"\$diff_output\" ]]; then
        echo 'Phase 2 PR 2.5: $runtime parity OK — /run matches legacy /srv (last-wins dedup, quote-normalized)'
        exit 0
      else
        line_count=\$(printf '%s\n' \"\$diff_output\" | wc -l | tr -d ' ')
        echo \"::warning:: Phase 2 PR 2.5: $runtime parity diff — \$line_count line(s) differ between /run/agent-stack/${runtime}.env (authoritative) and /srv/agent-stack/${runtime}.env (legacy, retained for 24h rollback)\"
        echo \"  Informational only — compose now reads /run. Legacy /srv file gets deleted in PR 2.6.\"
        # Print only KEY names, not values, so secrets never enter the log.
        printf '%s\n' \"\$diff_output\" | awk -F= '/^[<>] [A-Z]/ { print \"    \" \$1 \"=\" }' | sort -u | head -20
        exit 0
      fi
    "; then
      :
    fi
  done
}

apply_caddy() {
  if [[ -z "${APP_BASIC_AUTH_USER:-}" ]]; then
    echo "Skipping Caddy render: APP_BASIC_AUTH_USER is not set." >&2
    echo "Set APP_BASIC_AUTH_USER plus APP_BASIC_AUTH_PASSWORD_HASH to deploy Caddy changes." >&2
    return 0
  fi

  if [[ -z "${APP_BASIC_AUTH_PASSWORD_HASH:-}" ]]; then
    echo "Skipping Caddy render: APP_BASIC_AUTH_PASSWORD_HASH is not set." >&2
    echo "PR 2.2 removed the raw-password code path; pass the bcrypt hash only." >&2
    return 0
  fi

  # Render the new Caddyfile atomically: write to a tmp file alongside
  # the target, validate via `caddy validate` inside the running caddy
  # container, then move into place. If validate fails, the live
  # Caddyfile is untouched and the deploy aborts.
  local rendered_tmp
  rendered_tmp=$(mktemp "$STACK_ROOT/Caddyfile.XXXXXX")
  trap 'rm -f "$rendered_tmp"' RETURN

  "$APP_ROOT/scripts/ops/render-caddyfile.sh" "$rendered_tmp"

  # caddy validate inside the running caddy container. The container's
  # Caddyfile path is /etc/caddy/Caddyfile; we mount the rendered tmp
  # over that path with `-v` for the validate call only. If the
  # validate fails, caddy returns non-zero and `set -e` aborts the
  # deploy before we touch the live config.
  echo "Validating rendered Caddyfile via caddy validate (PR 2.2)..."
  if ! docker compose \
        --project-directory "$STACK_ROOT" \
        -f "$COMPOSE_FILE" \
        run --rm \
          -v "$rendered_tmp:/etc/caddy/Caddyfile:ro" \
          --no-deps \
          --entrypoint caddy \
          caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo "ERROR: caddy validate rejected the rendered Caddyfile; aborting before reload." >&2
    rm -f "$rendered_tmp"
    return 1
  fi

  # Phase 2 PR 2.7d.2: content-aware install + restart. Without this
  # check, the basic-auth-hash rotation that landed in PR 2.7d only
  # propagated to /run via the OP-injected template render — but
  # apply_caddy was gated by path-based should_run on Caddyfile.averray
  # / render-caddyfile.sh and was SKIPPED. The new hash sat in the
  # workflow env but Caddy kept serving the old hash from disk until
  # the operator manually re-rendered the Caddyfile on the VPS.
  #
  # Now: compare hash of live Caddyfile against hash of the newly
  # rendered (and validated) tmp file. If they match, the render was
  # a noop — skip the mv + restart (cheap restart at ~2s, but
  # skipping is cleaner and surfaces "no change" in logs).
  # If they differ, install + restart as before.
  local before_hash=""
  if [[ -f "$STACK_ROOT/Caddyfile" ]]; then
    before_hash=$(sha256sum "$STACK_ROOT/Caddyfile" | awk '{print $1}')
  fi
  local after_hash
  after_hash=$(sha256sum "$rendered_tmp" | awk '{print $1}')

  if [[ "$before_hash" == "$after_hash" ]]; then
    echo "Phase 2 PR 2.7d.2: Caddyfile content unchanged (hash=${before_hash:0:8}) — skipping install + restart"
    rm -f "$rendered_tmp"
    trap - RETURN
    return 0
  fi

  local before_label="${before_hash:0:8}"
  [[ -z "$before_hash" ]] && before_label="(none)"
  echo "Phase 2 PR 2.7d.2: Caddyfile content changed (before=$before_label, after=${after_hash:0:8}) — installing + restarting caddy"

  # Atomic install of the validated Caddyfile.
  chmod 0644 "$rendered_tmp"
  mv "$rendered_tmp" "$STACK_ROOT/Caddyfile"
  trap - RETURN

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

read_persisted_indexer_schema() {
  if [[ -f "$INDEXER_SCHEMA_STATE_FILE" ]]; then
    awk 'NF { print; exit }' "$INDEXER_SCHEMA_STATE_FILE" | tr -d '"'
  fi
}

write_persisted_indexer_schema() {
  local schema="$1"
  local dir
  dir=$(dirname "$INDEXER_SCHEMA_STATE_FILE")
  mkdir -p "$dir"

  local tmp="${INDEXER_SCHEMA_STATE_FILE}.tmp.$$"
  printf '%s\n' "$schema" > "$tmp"
  mv "$tmp" "$INDEXER_SCHEMA_STATE_FILE"
  echo "Persisted indexer DATABASE_SCHEMA override in $INDEXER_SCHEMA_STATE_FILE: $schema"
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
    echo "Runtime env files are rendered before schema overrides; check render_runtime_envs output above." >&2
    exit 1
  fi

  local tmp
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' RETURN
  awk '!/^DATABASE_SCHEMA=/' "$INDEXER_ENV_FILE" > "$tmp"
  printf 'DATABASE_SCHEMA=%s\n' "$schema" >> "$tmp"

  local mode owner_group
  mode=$(stat -c '%a' "$INDEXER_ENV_FILE")
  owner_group=$(stat -c '%U:%G' "$INDEXER_ENV_FILE")
  chmod "$mode" "$tmp"

  case "$INDEXER_ENV_FILE" in
    /run/agent-stack/*)
      sudo chown "$owner_group" "$tmp"
      sudo mv "$tmp" "$INDEXER_ENV_FILE"
      ;;
    *)
      chown "$owner_group" "$tmp" 2>/dev/null || true
      mv "$tmp" "$INDEXER_ENV_FILE"
      ;;
  esac
  trap - RETURN

  echo "Updated indexer DATABASE_SCHEMA in $INDEXER_ENV_FILE: $schema"
  RUN_INDEXER=1
  RUNTIME_ENV_CHANGED_INDEXER=1
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
  local persist_schema=0
  if [[ -n "$INDEXER_DATABASE_SCHEMA" ]]; then
    validate_indexer_schema "$INDEXER_DATABASE_SCHEMA"
    target_schema="$INDEXER_DATABASE_SCHEMA"
    persist_schema=1
    echo "Operator pinned indexer DATABASE_SCHEMA: $target_schema"
  elif [[ "$INDEXER_FRESH_SCHEMA" == "1" ]]; then
    target_schema="agent_indexer_$(date -u +%Y%m%d%H%M%S)"
    validate_indexer_schema "$target_schema"
    persist_schema=1
    echo "INDEXER_FRESH_SCHEMA=1 — minting fresh DATABASE_SCHEMA: $target_schema"
  else
    local persisted_schema=""
    persisted_schema=$(read_persisted_indexer_schema)
    if [[ -n "$persisted_schema" ]]; then
      validate_indexer_schema "$persisted_schema"
      target_schema="$persisted_schema"
      echo "Reapplying persisted indexer DATABASE_SCHEMA override: $target_schema"
    else
      return 0
    fi
  fi

  if [[ -n "$current_schema" && "$current_schema" == "$target_schema" ]]; then
    echo "Indexer DATABASE_SCHEMA already current: $target_schema"
  elif [[ -n "$current_schema" ]]; then
    echo "Replacing existing DATABASE_SCHEMA ($current_schema) with $target_schema."
    write_indexer_schema "$target_schema"
  else
    write_indexer_schema "$target_schema"
  fi

  if [[ "$persist_schema" == "1" ]]; then
    write_persisted_indexer_schema "$target_schema"
  fi
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

  # Phase 2 PR 2.5: render /run/agent-stack/*.env from 1Password.
  # FAIL-CLOSED — render failure aborts the deploy before containers
  # restart. Compose's env_file: now points at /run, so a stale or
  # missing render would be operationally bad. Parity check against
  # the legacy /srv file is informational only (no longer authoritative).
  #
  # Phase 2 PR 2.6: removed configure_settlement_env and
  # configure_bootstrap_instrumentation_env calls — those wrote to
  # /srv/backend.env in shell-escape format, which broke
  # docker-compose's env_file: parser at PR 2.5 cutover. All values
  # they wrote are now in deploy/backend.env.template (verified
  # byte-for-byte) and CI enforces drift via
  # check-template-matches-manifest.mjs.
  render_runtime_envs
  apply_indexer_database_schema

  local run_backend=0
  local run_indexer=0
  local run_frontend=0
  local run_site=0
  local run_caddy=0

  # Phase 2 PR 2.6: the trigger for backend redeploy is now path-based
  # only — we added deploy/backend.env.template and
  # deployments/testnet.json to the regex because changes there can
  # affect rendered /run/backend.env content even without code changes
  # (the manifest feeds the template via the CI parity guard).
  #
  # Phase 2 PR 2.7d.1: ALSO trigger on /run env content change. When
  # the trigger is JUST the env content (no code path changed),
  # redeploy-backend.sh would be overkill — it rebuilds the image and
  # does a full deploy cycle. Instead, fall back to a direct
  # `docker compose up -d --force-recreate <service>` which is the
  # minimum needed to make compose re-read env_file: into a fresh
  # container. This is the path a pure-rotation deploy takes: update
  # 1Password item → trigger workflow_dispatch → render produces new
  # /run env → hash differs → force-recreate. No SSH+rm dance needed.
  local backend_code_changed=0
  if should_run backend "$RUN_BACKEND" '^(mcp-server/|sdk/|examples/|docs/schemas/|package(-lock)?\.json|scripts/ops/redeploy-backend\.sh|deploy/backend\.env\.template|deployments/testnet\.json)'; then
    backend_code_changed=1
  fi
  if [[ "$backend_code_changed" == "1" || "${RUNTIME_ENV_CHANGED_BACKEND:-0}" == "1" ]]; then
    run_backend=1
    if [[ "$backend_code_changed" == "1" ]]; then
      echo "Deploying backend (reason: code path changed)"
      SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-backend.sh"
    else
      echo "Deploying backend (reason: /run/agent-stack/backend.env content changed; image unchanged — force-recreating container only)"
      sudo docker compose --project-directory "$STACK_ROOT" -f "$COMPOSE_FILE" up -d --force-recreate backend
      # Don't continue to downstream smoke checks until /health is 200
      # — see wait_for_backend_health() comment for the 2026-05-13 14:30Z
      # incident that motivated this.
      if ! wait_for_backend_health; then
        exit 1
      fi
    fi
    mark_component_deployed backend
  else
    echo "Skipping backend deploy"
    if [[ "$RUN_BACKEND" == "auto" ]]; then
      mark_component_deployed backend
    fi
  fi

  local indexer_code_changed=0
  if should_run indexer "$RUN_INDEXER" '^(indexer/|package(-lock)?\.json|scripts/ops/redeploy-indexer\.sh)'; then
    indexer_code_changed=1
  fi
  if [[ "$indexer_code_changed" == "1" || "${RUNTIME_ENV_CHANGED_INDEXER:-0}" == "1" ]]; then
    run_indexer=1
    if [[ "$indexer_code_changed" == "1" ]]; then
      echo "Deploying indexer (reason: code path changed)"
      SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-indexer.sh"
    else
      echo "Deploying indexer (reason: /run/agent-stack/indexer.env content changed; image unchanged — force-recreating container only)"
      sudo docker compose --project-directory "$STACK_ROOT" -f "$COMPOSE_FILE" up -d --force-recreate indexer
    fi
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

  # Phase 2 PR 2.7d.2: always run apply_caddy unless explicitly
  # disabled (RUN_CADDY=0). The old path-based `should_run caddy`
  # gate missed pure 1Password value changes (basic-auth hash
  # rotation) because no code file in the repo changed — only the
  # OP item — and the gate skipped the render entirely. apply_caddy
  # is now responsible for its own change detection: it always
  # renders to a tmp file, hash-compares against the live Caddyfile,
  # and only does mv + restart if the content actually differs.
  # Cost: an extra render + caddy-validate (~3s) on every deploy,
  # even when nothing changed. Benefit: rotations don't need a
  # code-path trigger; the OP value change auto-propagates.
  case "$RUN_CADDY" in
    0|false|no)
      echo "Skipping Caddy (RUN_CADDY=$RUN_CADDY)"
      ;;
    *)
      echo "Applying Caddy config (render → validate → hash-compare → install if changed)"
      apply_caddy
      run_caddy=1
      mark_component_deployed caddy
      ;;
  esac

  if changed_matches '^(contracts/|script/|foundry\.toml|remappings\.txt)'; then
    echo "Contract-related files changed. Smart contracts still require an explicit contract deployment flow." >&2
  fi

  if [[ "$RUN_SMOKE" == "1" ]]; then
    if [[ "$SMOKE_CHECK_PRODUCT_PROOF_GATE" == "1" || "$SMOKE_CHECK_PRODUCT_PROOF_GATE" == "true" || "$SMOKE_CHECK_PRODUCT_PROOF_GATE" == "yes" ]]; then
      run_product_proof_worker_loop
    fi
    run_bootstrap_self_report_once

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
      PRODUCT_PROOF_REQUIRE_WORKER_LOOP="$PRODUCT_PROOF_REQUIRE_WORKER_LOOP" \
      PRODUCT_PROOF_EVIDENCE_FILE="$PRODUCT_PROOF_EVIDENCE_FILE" \
      PRODUCT_PROOF_NODE_IMAGE="$PRODUCT_PROOF_NODE_IMAGE" \
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
