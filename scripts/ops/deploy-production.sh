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
COMPOSE_FILE_OVERRIDE=${COMPOSE_FILE:-}
COMPOSE_FILE=""
COMPOSE_PROJECT_DIRECTORY=""
BACKEND_SERVICE=""
BACKEND_CONTAINER=""
INDEXER_SERVICE=""
CADDY_COMPOSE_FILE=${CADDY_COMPOSE_FILE:-"$STACK_ROOT/docker-compose.yml"}
CADDY_PROJECT_DIRECTORY=${CADDY_PROJECT_DIRECTORY:-"$STACK_ROOT"}
# Caddy is addressed by container name, NOT through docker compose.
#
# Caddy lives in the host-side legacy compose project, whose file still declares
# the pre-cutover backend with `env_file: /run/agent-stack/backend.env`. Since
# the 2026-07-27 mainnet cutover that path is no longer rendered (mainnet renders
# to /run/agent-stack-mainnet/), so ANY `docker compose -f <that file> ...` call
# now dies while parsing the file — before Caddy is even reached:
#
#   env file /run/agent-stack/backend.env not found
#
# The bug was latent because the Caddyfile is only reloaded when its content
# changes, and nothing changed it between the cutover and 2026-08-18 (#1158,
# which added the public /receipts/:id route). Caddy itself was fine throughout:
# it printed "Valid configuration" and the compose layer failed around it.
#
# `docker exec` against the container needs no compose file and therefore cannot
# be broken by an unrelated stale service definition. This mirrors what
# flip-caddy-network.sh — the mainnet cutover tool — has always done.
CADDY_CONTAINER=${CADDY_CONTAINER:-agent-caddy}
BRANCH=${BRANCH:-main}
DEPLOY_LOCK_FILE=${DEPLOY_LOCK_FILE:-/tmp/averray-production-deploy.lock}
DEPLOY_AUTOSTASH=${DEPLOY_AUTOSTASH:-1}
DEPLOY_OLD_SHA=${DEPLOY_OLD_SHA:-}
DEPLOY_NEW_SHA=${DEPLOY_NEW_SHA:-}
DEPLOY_STATE_DIR=${DEPLOY_STATE_DIR:-"$STACK_ROOT/.deploy-state"}
# An explicit INDEXER_SCHEMA_STATE_FILE is honored verbatim. The default is
# per-network and resolved lazily (indexer_schema_state_file) because
# LIVE_NETWORK is only known after resolve_deploy_target. The pre-cutover
# unscoped file is testnet-era state: testnet still reads it as a fallback,
# but it must never leak a testnet schema pin onto the mainnet indexer.
INDEXER_SCHEMA_STATE_FILE=${INDEXER_SCHEMA_STATE_FILE:-}
LEGACY_INDEXER_SCHEMA_STATE_FILE="$DEPLOY_STATE_DIR/indexer.database-schema"
INDEXER_IDENTITY_STATE_FILE=${INDEXER_IDENTITY_STATE_FILE:-}
INDEXER_RESYNC_STATE_FILE=${INDEXER_RESYNC_STATE_FILE:-}
INDEXER_SCHEMA_LOCK_FILE=${INDEXER_SCHEMA_LOCK_FILE:-}
FRONTEND_TREE_HASH_FILE=${FRONTEND_TREE_HASH_FILE:-"$DEPLOY_STATE_DIR/frontend.built-tree-hash"}
CADDY_NETWORK_STATE_FILE=${CADDY_NETWORK_STATE_FILE:-"$DEPLOY_STATE_DIR/caddy-network-selection.json"}
DEPLOY_ACTOR=${DEPLOY_ACTOR:-"deploy-production:${SUDO_USER:-${USER:-unknown}}"}

RUN_BACKEND=${RUN_BACKEND:-auto}
RUN_FRONTEND=${RUN_FRONTEND:-auto}
RUN_INDEXER=${RUN_INDEXER:-auto}
RUN_SITE=${RUN_SITE:-auto}
RUN_CADDY=${RUN_CADDY:-auto}
RUN_SMOKE=${RUN_SMOKE:-1}
SITE_SOURCE_PATTERN='^(marketing/|site/|mcp-server/src/core/discovery-manifest\.js|scripts/sync-marketing-site\.mjs|scripts/ops/discovery-manifest-file\.mjs|package(-lock)?\.json)'
# Runtime outcome, not intent: apply_caddy sets this only after a changed
# configuration is installed and the Caddy restart succeeds.
CADDY_RESTARTED=0
SMOKE_CHECK_INDEXER=${SMOKE_CHECK_INDEXER:-auto}
SMOKE_CHECK_BOOTSTRAP_INSTRUMENTATION=${SMOKE_CHECK_BOOTSTRAP_INSTRUMENTATION:-0}
SMOKE_CHECK_BOOTSTRAP_SELF_REPORT_SENT=${SMOKE_CHECK_BOOTSTRAP_SELF_REPORT_SENT:-0}
BOOTSTRAP_SELF_REPORT_SEND_NOW=${BOOTSTRAP_SELF_REPORT_SEND_NOW:-0}
BOOTSTRAP_SELF_REPORT_IDEMPOTENCY_KEY=${BOOTSTRAP_SELF_REPORT_IDEMPOTENCY_KEY:-}
SMOKE_CHECK_PRODUCT_PROOF_GATE=${SMOKE_CHECK_PRODUCT_PROOF_GATE:-1}
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
# D-03 provenance checks run in the same Node toolchain image as product
# proof. The production host intentionally has no Node.js installation.
CONTRACT_PROVENANCE_NODE_IMAGE=${CONTRACT_PROVENANCE_NODE_IMAGE:-$PRODUCT_PROOF_NODE_IMAGE}
# D-03 Tier 3 compiles the candidate contract tree even though the production
# host intentionally has no Foundry installation. Pin the OCI index digest so
# both amd64 production and arm64 operator hosts resolve immutable platform
# images. Resolved 2026-08-03: Foundry 1.5.1-stable, commit b0a9dd9c.
# Refresh deliberately with:
#   docker buildx imagetools inspect ghcr.io/foundry-rs/foundry:stable
readonly CONTRACT_PROVENANCE_FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46
INDEXER_DATABASE_SCHEMA=${INDEXER_DATABASE_SCHEMA:-}
INDEXER_FRESH_SCHEMA=${INDEXER_FRESH_SCHEMA:-0}
WAIT_FOR_READY=${WAIT_FOR_READY:-1}
HEALTH_STABILITY_SEC=${HEALTH_STABILITY_SEC:-0}
INDEXER_ENV_FILE_OVERRIDE=${INDEXER_ENV_FILE:-}
INDEXER_ENV_FILE=""
INDEXER_SCHEMA_LOCK_ACQUIRED=0
INDEXER_SCHEMA_ROTATED=0
INDEXER_SCHEMA_ROTATION_REASON=""
INDEXER_PREVIOUS_SCHEMA=""
INDEXER_TARGET_SCHEMA=""
INDEXER_PREVIOUS_IDENTITY=""
INDEXER_TARGET_IDENTITY=""
INDEXER_OWNERSHIP_STATE_PENDING=0
DEPLOY_CONTRACT_COMPAT_FREEZE=${DEPLOY_CONTRACT_COMPAT_FREEZE:-1}
DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=${DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT:-0}
DEPLOY_VERIFY_CONTRACT_SOURCE=${DEPLOY_VERIFY_CONTRACT_SOURCE:-0}
DEPLOY_CONTRACT_COMPAT_PROFILE=${DEPLOY_CONTRACT_COMPAT_PROFILE:-}
# BACKEND_ENV_FILE: removed in PR 2.6 — backend env now rendered to
# /run/agent-stack/backend.env by render_runtime_envs (1Password →
# op inject → /run); /srv/agent-stack/backend.env is no longer written.

SITE_BUILD_RUNNER=${SITE_BUILD_RUNNER:-auto}
SITE_NODE_IMAGE=${SITE_NODE_IMAGE:-node:22-bookworm-slim}
PUBLIC_SITE_URL=${PUBLIC_SITE_URL:-https://averray.com}
SITE_SERVE_CHECK_ATTEMPTS=${SITE_SERVE_CHECK_ATTEMPTS:-3}
SITE_SERVE_CHECK_INTERVAL_SEC=${SITE_SERVE_CHECK_INTERVAL_SEC:-5}

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

with_lock() {
  flock -n 9 || {
    echo "Another production deploy is already running." >&2
    exit 1
  }
  deploy
}

resolve_deploy_target() {
  local selector="$APP_ROOT/scripts/ops/run-caddy-network-selection.sh"
  local live_caddy="$STACK_ROOT/Caddyfile"

  # Production has carried this durable selector since the mainnet cutover.
  # Bootstrap is retained only for a host migrating from the pre-selector
  # layout, and derives from the validated live Caddy route.
  if [[ ! -f "$CADDY_NETWORK_STATE_FILE" && -x "$selector" && -f "$live_caddy" ]]; then
    local execution_user deploy_host operation_id
    execution_user=$(id -un)
    deploy_host=$(hostname -f 2>/dev/null || hostname)
    operation_id="deploy-bootstrap-${NEW_SHA:0:12}-$(date -u +%Y%m%d-%H%M%S)"
    STACK_ROOT="$STACK_ROOT" "$selector" bootstrap \
      --state "$CADDY_NETWORK_STATE_FILE" \
      --live-caddy "$live_caddy" \
      --selected-by "$DEPLOY_ACTOR" \
      --execution-user "$execution_user" \
      --host "$deploy_host" \
      --source-revision "$NEW_SHA" \
      --operation-id "$operation_id"
  fi

  if [[ -f "$CADDY_NETWORK_STATE_FILE" && -x "$selector" ]]; then
    if [[ ! -f "$live_caddy" ]]; then
      echo "Durable network selection exists but live Caddyfile is missing at $live_caddy." >&2
      return 1
    fi

    local status target selected_compose
    status=$(STACK_ROOT="$STACK_ROOT" "$selector" status \
      --state "$CADDY_NETWORK_STATE_FILE" \
      --live-caddy "$live_caddy")
    if ! printf '%s' "$status" | jq -e '.consistent == true' >/dev/null; then
      echo "Durable network selection disagrees with the live Caddy route; refusing to choose a deploy target." >&2
      return 1
    fi

    target=$(STACK_ROOT="$STACK_ROOT" "$selector" deploy-target \
      --state "$CADDY_NETWORK_STATE_FILE" \
      --stack-root "$STACK_ROOT" \
      --app-root "$APP_ROOT")
    selected_compose=$(printf '%s' "$target" | jq -er '.composeFile')
    if [[ -n "$COMPOSE_FILE_OVERRIDE" && "$COMPOSE_FILE_OVERRIDE" != "$selected_compose" ]]; then
      echo "COMPOSE_FILE override $COMPOSE_FILE_OVERRIDE disagrees with durable network target $selected_compose." >&2
      return 1
    fi

    LIVE_NETWORK=$(printf '%s' "$target" | jq -er '.network')
    COMPOSE_FILE="$selected_compose"
    COMPOSE_PROJECT_DIRECTORY=$(printf '%s' "$target" | jq -er '.projectDirectory')
    BACKEND_SERVICE=$(printf '%s' "$target" | jq -er '.backendService')
    BACKEND_CONTAINER=$(printf '%s' "$target" | jq -er '.backendContainer')
    INDEXER_SERVICE=$(printf '%s' "$target" | jq -er '.indexerService')
    RUNTIME_ROOT=$(printf '%s' "$target" | jq -er '.runtimeRoot')
    CREDENTIALS_ROOT=$(printf '%s' "$target" | jq -er '.credentialsRoot')
    BACKEND_ENV_TEMPLATE=$(printf '%s' "$target" | jq -er '.backendTemplate')
    INDEXER_ENV_TEMPLATE=$(printf '%s' "$target" | jq -er '.indexerTemplate')
  elif [[ -n "$COMPOSE_FILE_OVERRIDE" ]]; then
    # Isolated regression fixtures and pre-selector development hosts may
    # provide the legacy testnet compose explicitly. A production host has a
    # live Caddyfile and selector script, so it takes the fail-closed path
    # above and cannot use this compatibility branch.
    LIVE_NETWORK=testnet
    COMPOSE_FILE="$COMPOSE_FILE_OVERRIDE"
    COMPOSE_PROJECT_DIRECTORY="$STACK_ROOT"
    BACKEND_SERVICE=backend
    BACKEND_CONTAINER=agent-backend
    INDEXER_SERVICE=indexer
    RUNTIME_ROOT=/run/agent-stack
    CREDENTIALS_ROOT=/etc/agent-stack
    BACKEND_ENV_TEMPLATE="$APP_ROOT/deploy/backend.env.template"
    INDEXER_ENV_TEMPLATE="$APP_ROOT/deploy/indexer.env.template"
  else
    echo "Cannot resolve deploy target: durable network selection is unavailable and COMPOSE_FILE was not explicitly supplied." >&2
    return 1
  fi

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "Missing selected docker-compose file at $COMPOSE_FILE" >&2
    return 1
  fi
  INDEXER_ENV_FILE=${INDEXER_ENV_FILE_OVERRIDE:-"$RUNTIME_ROOT/indexer.env"}
  DEPLOY_CONTRACT_COMPAT_PROFILE=${DEPLOY_CONTRACT_COMPAT_PROFILE:-"$LIVE_NETWORK"}

  echo "Live deploy target: network=$LIVE_NETWORK compose=$COMPOSE_FILE project=$COMPOSE_PROJECT_DIRECTORY backend=$BACKEND_SERVICE indexer=$INDEXER_SERVICE"
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

deploy_range_changed_files() {
  local base="${1:-$OLD_SHA}"
  if [[ "$base" == "$NEW_SHA" ]]; then
    return 0
  fi
  git -C "$APP_ROOT" diff --name-only "$base" "$NEW_SHA"
}

# D-03 sticky freeze marker (2026-07-27, deploy run 30312416198): the checkout
# fast-forwards even when a deploy FAILS at this gate — the workflow wrapper
# pre-updates the checkout before invoking us, and the self-pull path pulls
# before gating. The next merge's OLD_SHA..NEW_SHA range then no longer
# contains the flagged files, so a range-only gate silently passes while the
# durable per-component pointers still deploy the flagged change. Persist the
# refused baseline per contract-compat profile (scoped like the per-network
# indexer schema state) so every later run re-evaluates the whole undeployed
# range until the compiled runtime matches deployed provenance, the manifest
# pairs with it, the source change is reverted, or an operator dispatch clears
# it. Tier 2 live chain verification never writes this marker.
contract_freeze_marker_file() {
  printf '%s/contract-surface.frozen-at.%s\n' "$DEPLOY_STATE_DIR" "$DEPLOY_CONTRACT_COMPAT_PROFILE"
}

read_contract_freeze_baseline() {
  local file
  file=$(contract_freeze_marker_file)
  [[ -f "$file" ]] || return 1
  awk -F= '$1 == "baseline_sha" { print $2; exit }' "$file" | tr -d '[:space:]'
}

write_contract_freeze_marker() {
  local baseline="$1"
  local flagged_sha="$2"
  local manifest_path="$3"
  local surface_changes="$4"
  local file
  file=$(contract_freeze_marker_file)
  mkdir -p "$DEPLOY_STATE_DIR"
  local tmp="${file}.tmp.$$"
  {
    echo "# D-03 contract-surface freeze. Deploys for profile ${DEPLOY_CONTRACT_COMPAT_PROFILE}"
    echo "# stay frozen until ${manifest_path} changes alongside these files, the drift"
    echo "# is reverted, or a manual dispatch with DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=1"
    echo "# clears this marker after an operator records the compatibility rationale."
    printf 'baseline_sha=%s\n' "$baseline"
    printf 'flagged_sha=%s\n' "$flagged_sha"
    printf 'manifest=%s\n' "$manifest_path"
    printf 'frozen_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "flagged_files:"
    printf '%s\n' "$surface_changes"
  } > "$tmp"
  mv "$tmp" "$file"
}

clear_contract_freeze_marker() {
  local reason="$1"
  local file
  file=$(contract_freeze_marker_file)
  [[ -f "$file" ]] || return 0
  echo "D-03 contract compatibility freeze: clearing persisted freeze marker at $file ($reason). Marker contents:"
  sed 's/^/  /' "$file"
  rm -f "$file"
}

contract_surface_drift_override_set() {
  case "$DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
    *)
      echo "Invalid DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT: $DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT" >&2
      exit 1
      ;;
  esac
}

preflight_contract_provenance_runtime() {
  local output=""
  local status=0
  set +e
  output=$(docker run --rm "$CONTRACT_PROVENANCE_NODE_IMAGE" node --version 2>&1)
  status=$?
  set -e

  if [[ "$status" != "0" ]]; then
    {
      echo "D-03 Tier 2 environment error: containerized Node runtime '$CONTRACT_PROVENANCE_NODE_IMAGE' is not runnable (exit $status); provenance checker did not run."
      printf '%s\n' "$output"
      echo "Refusing production deploy. Restore the deploy toolchain image/runtime; do not treat this as contract drift or skip the gate."
    } >&2
    return 127
  fi

  echo "D-03 Tier 2 runtime: using containerized Node $output from $CONTRACT_PROVENANCE_NODE_IMAGE (host node is not required)."
}

run_contract_provenance_checker() {
  local checker="$1"
  local artifacts_mount="$2"
  shift 2

  local relative_checker="${checker#$APP_ROOT/}"
  local docker_args=(
    run --rm
    -v "$APP_ROOT:/workspace:ro"
    -w /workspace
  )
  if [[ -n "$artifacts_mount" ]]; then
    docker_args+=(-v "$artifacts_mount:$artifacts_mount:ro")
  fi

  docker "${docker_args[@]}" \
    "$CONTRACT_PROVENANCE_NODE_IMAGE" \
    node "$relative_checker" "$@"
}

verify_live_contract_provenance() {
  local checker="$APP_ROOT/scripts/ops/check-contract-provenance.mjs"
  if [[ ! -r "$checker" ]]; then
    echo "D-03 Tier 2: contract provenance checker is unreadable at $checker; refusing production deploy." >&2
    return 1
  fi
  if ! preflight_contract_provenance_runtime; then
    return 1
  fi

  local output=""
  local status=0
  set +e
  output=$(run_contract_provenance_checker \
    "$checker" \
    "" \
    --profile "$DEPLOY_CONTRACT_COMPAT_PROFILE" 2>&1)
  status=$?
  set -e

  if [[ "$status" == "0" ]]; then
    printf '%s\n' "$output"
    echo "D-03 Tier 2: live chain runtime matches deployments/${DEPLOY_CONTRACT_COMPAT_PROFILE}.json provenance."
    return 0
  fi

  if [[ "$status" == "1" ]]; then
    if contract_surface_drift_override_set; then
      {
        echo "::warning::D-03 Tier 2 override set; live chain runtime does not match the deployment manifest."
        printf '%s\n' "$output"
      } >&2
      return 0
    fi
    {
      echo "D-03 Tier 2: live chain runtime does not match deployments/${DEPLOY_CONTRACT_COMPAT_PROFILE}.json provenance; refusing production deploy."
      printf '%s\n' "$output"
    } >&2
    return 1
  fi

  if [[ "$status" != "2" ]]; then
    {
      echo "D-03 Tier 2 environment error: provenance checker runtime failed (exit $status); checker did not return a drift or config/RPC verdict."
      printf '%s\n' "$output"
      echo "Refusing production deploy. Restore the containerized Node/checker runtime; do not skip the gate."
    } >&2
    return 1
  fi

  # Exit 2 is the provenance checker's usage/config/RPC class. An override may
  # accept known semantic drift, but it must never turn an unreadable manifest
  # or unreachable RPC into a pass.
  {
    echo "D-03 Tier 2: could not verify live contract provenance (checker exit $status); refusing production deploy."
    printf '%s\n' "$output"
  } >&2
  return 1
}

preflight_contract_foundry_runtime() {
  local output=""
  local status=0
  set +e
  output=$(docker run --rm \
    --entrypoint forge \
    "$CONTRACT_PROVENANCE_FOUNDRY_IMAGE" \
    --version 2>&1)
  status=$?
  set -e

  if [[ "$status" != "0" ]]; then
    {
      echo "D-03 Tier 3 environment error: digest-pinned Foundry runtime '$CONTRACT_PROVENANCE_FOUNDRY_IMAGE' is not runnable (exit $status); candidate build and comparison did not run."
      printf '%s\n' "$output"
      echo "Refusing production deploy. Restore the pinned Foundry image/runtime; do not skip the gate."
    } >&2
    return 127
  fi

  local version="${output%%$'\n'*}"
  echo "D-03 Tier 3 runtime: using containerized $version from $CONTRACT_PROVENANCE_FOUNDRY_IMAGE (host forge is not required)."
}

run_contract_candidate_build() {
  local build_root="$1"

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/foundry-home \
    --entrypoint forge \
    -v "$APP_ROOT:/workspace:ro" \
    -v "$build_root:/build" \
    -w /workspace \
    "$CONTRACT_PROVENANCE_FOUNDRY_IMAGE" \
    build \
    --root /workspace \
    --out /build/out \
    --cache-path /build/cache \
    --skip test
}

check_compiled_contract_provenance() {
  local source_checker="$APP_ROOT/scripts/ops/check-contract-source-drift.mjs"
  if [[ ! -r "$source_checker" ]]; then
    echo "D-03 Tier 1: compiled-runtime checker is unreadable at $source_checker; refusing production deploy." >&2
    return 2
  fi
  if ! preflight_contract_foundry_runtime; then
    return 2
  fi

  local build_root
  build_root=$(mktemp -d "${TMPDIR:-/tmp}/averray-contract-source.XXXXXX")
  local artifacts="$build_root/out"

  if ! run_contract_candidate_build "$build_root"; then
    rm -rf -- "$build_root"
    echo "D-03 Tier 3: containerized candidate contract build failed; refusing production deploy without writing a sticky drift marker." >&2
    return 2
  fi

  local output=""
  local status=0
  set +e
  output=$(run_contract_provenance_checker \
    "$source_checker" \
    "$artifacts" \
    --profile "$DEPLOY_CONTRACT_COMPAT_PROFILE" \
    --artifacts "$artifacts" 2>&1)
  status=$?
  set -e
  rm -rf -- "$build_root"

  printf '%s\n' "$output"
  if [[ "$status" == "0" ]]; then
    echo "D-03 Tier 3: candidate build and immutable-masked provenance comparison passed."
  fi
  return "$status"
}

enforce_contract_compat_freeze() {
  case "$DEPLOY_CONTRACT_COMPAT_FREEZE" in
    1|true|yes) ;;
    0|false|no)
      # Skips evaluation for this run only; a persisted freeze marker (if
      # any) stays in place and re-arms on the next enabled run.
      echo "D-03 contract compatibility freeze disabled by DEPLOY_CONTRACT_COMPAT_FREEZE=$DEPLOY_CONTRACT_COMPAT_FREEZE"
      return 0
      ;;
    *)
      echo "Invalid DEPLOY_CONTRACT_COMPAT_FREEZE: $DEPLOY_CONTRACT_COMPAT_FREEZE" >&2
      exit 1
      ;;
  esac

  local manifest_path="deployments/${DEPLOY_CONTRACT_COMPAT_PROFILE}.json"
  local marker_file
  marker_file=$(contract_freeze_marker_file)

  local baseline="$OLD_SHA"
  local sticky=0
  if [[ -f "$marker_file" ]]; then
    local recorded=""
    recorded=$(read_contract_freeze_baseline || true)
    if [[ -z "$recorded" ]] || ! git -C "$APP_ROOT" cat-file -e "${recorded}^{commit}" >/dev/null 2>&1; then
      # An unreadable baseline cannot be re-verified; falling back to OLD_SHA
      # would reopen the exact fast-forward hole the marker exists to close.
      if contract_surface_drift_override_set; then
        clear_contract_freeze_marker "baseline '$recorded' is unreadable; cleared by explicit DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT dispatch"
      else
        {
          echo "D-03 contract compatibility freeze: refusing production deploy."
          echo
          echo "The persisted freeze marker at $marker_file has an unreadable baseline ('$recorded'), so the frozen contract-surface range cannot be re-verified."
          echo "Run a manual dispatch with DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=1 to clear it after an operator records the compatibility rationale."
        } >&2
        exit 1
      fi
    else
      baseline="$recorded"
      sticky=1
      echo "D-03 contract compatibility freeze: enforcing persisted freeze from $marker_file (baseline $baseline)."
    fi
  fi

  # Tier 2 is deliberately unconditional. Besides verifying every path that
  # the old heuristic matched, this catches out-of-band chain drift on a
  # same-SHA re-dispatch. A real hash mismatch can use the explicit drift
  # override; config, manifest, and RPC failures always fail closed.
  if ! verify_live_contract_provenance; then
    exit 1
  fi

  local source_check_passed=0
  case "$DEPLOY_VERIFY_CONTRACT_SOURCE" in
    1|true|yes)
      echo "D-03 Tier 3: manual verification requested; running the candidate build and immutable-masked comparison regardless of changed paths."
      if ! check_compiled_contract_provenance; then
        echo "D-03 Tier 3: manual verification failed; refusing production deploy." >&2
        exit 1
      fi
      source_check_passed=1
      ;;
    0|false|no) ;;
    *)
      echo "Invalid DEPLOY_VERIFY_CONTRACT_SOURCE: $DEPLOY_VERIFY_CONTRACT_SOURCE" >&2
      exit 1
      ;;
  esac

  local changed
  changed=$(deploy_range_changed_files "$baseline")

  local contract_changes
  contract_changes=$(printf '%s\n' "$changed" | grep -E '^contracts/' || true)
  if [[ -z "$contract_changes" ]]; then
    if [[ "$sticky" == "1" ]]; then
      clear_contract_freeze_marker "no contract source changes remain in $baseline -> $NEW_SHA; the old marker was heuristic-only or the source drift was reverted"
    fi
    echo "D-03 Tier 1: no contract source changes; no sticky freeze."
    return 0
  fi

  if printf '%s\n' "$changed" | grep -Fxq "$manifest_path"; then
    if [[ "$sticky" == "1" ]]; then
      clear_contract_freeze_marker "contract-surface changes are now paired with $manifest_path in $baseline -> $NEW_SHA"
    fi
    echo "D-03 Tier 1: contract source changes are paired with $manifest_path; no sticky freeze."
    return 0
  fi

  local source_status=0
  if [[ "$source_check_passed" == "1" ]]; then
    source_status=0
  elif check_compiled_contract_provenance; then
    source_status=0
  else
    source_status=$?
  fi

  if [[ "$source_status" == "0" ]]; then
    if [[ "$sticky" == "1" ]]; then
      clear_contract_freeze_marker "compiled runtimes match deployed provenance or an exact known-unshipped manifest entry"
    fi
    echo "D-03 Tier 1: compiled runtimes match deployed provenance or an exact known-unshipped manifest entry; no sticky freeze."
    return 0
  fi

  if [[ "$source_status" != "1" ]]; then
    # Build/config/checker failures are uncertainty, not proof of semantic
    # drift. Fail closed, but do not create a sticky marker whose stated cause
    # would be false.
    exit 1
  fi

  if contract_surface_drift_override_set; then
    echo "::warning::D-03 contract compatibility freeze override set; deploying changed contract runtime without a $manifest_path update."
    printf 'Changed contract source files:\n%s\n' "$contract_changes"
    if [[ "$sticky" == "1" ]]; then
      clear_contract_freeze_marker "explicit DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT dispatch accepted the drift"
    fi
    return 0
  fi

  write_contract_freeze_marker "$baseline" "$NEW_SHA" "$manifest_path" "$contract_changes"

  {
    echo "D-03 contract compatibility freeze: refusing production deploy."
    echo
    echo "This deploy range changes contract source, its immutable-masked compiled runtime differs from deployed provenance, and $manifest_path did not change."
    echo "Evaluated range: $baseline -> $NEW_SHA"
    echo "A normal production deploy updates backend/indexer/app containers; it does not deploy or rewire smart contracts."
    echo "Deploying this range can put backend ABI/settlement expectations ahead of the live contracts and red the Hosted Worker Canary."
    echo
    echo "Changed contract source files:"
    while IFS= read -r file; do
      [[ -n "$file" ]] && printf '  %s\n' "$file"
    done <<< "$contract_changes"
    echo
    echo "This refusal is persisted at $marker_file: the checkout advances past refused deploys, so later runs keep evaluating from baseline $baseline until the freeze clears."
    echo "To proceed intentionally, first deploy/rewire contracts and commit the updated $manifest_path, add an exact known-unshipped runtime hash plus reason to the manifest, or run a manual dispatch with DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=1 after an operator records the compatibility rationale."
  } >&2
  exit 1
}

mark_component_deployed() {
  local component="$1"
  write_component_sha "$component" "$NEW_SHA"
  echo "Recorded $component deploy pointer: $NEW_SHA"
}

# 2026-06-28 stash regression, frontend edition (PR #754 follow-up). Like
# site/, the operator app Caddy serves at app.averray.com is UNCOMMITTED
# `npm run build:frontend` output layered over stale committed frontend/
# copies, and the same un-popped `git stash push -u` that reverted the
# homepage also reverted frontend/ (it self-healed sooner only because the
# frontend path gate fires on many more paths). The path gate tracks
# commits, not disk state, so it cannot see a working-tree revert.
#
# Fix: after every deploy-driven frontend build, record a sha256 tree hash
# of frontend/ in $DEPLOY_STATE_DIR — OUTSIDE the checkout, where a stash
# cannot sweep it. When the path gate would skip, compare disk against the
# recorded hash and force a rebuild on mismatch (or when no hash was ever
# recorded). This also self-heals in the same run when pull_latest's own
# DEPLOY_AUTOSTASH sweeps the previous build output.
#
# Hash the working-tree content of every tracked or untracked-but-not-
# ignored file under frontend/ (git's ls-files does the listing so
# frontend/node_modules/ stays excluded via .gitignore). A file listed but
# missing on disk makes xargs/sha256sum complain — the output still covers
# the surviving files, so the final hash differs and drift is detected;
# `|| true` keeps set -e/pipefail from turning that signal into an abort.
frontend_tree_hash() {
  (
    cd "$APP_ROOT"
    git ls-files -z --cached --others --exclude-standard -- frontend/ \
      | xargs -0 sha256sum 2>/dev/null \
      | sha256sum \
      | awk '{print $1}'
  ) || true
}

# Prints a human-readable drift reason and returns 0 when frontend/ on disk
# no longer matches the recorded last-build tree hash; returns 1 (prints
# nothing) when they match.
frontend_tree_drift_reason() {
  if [[ ! -f "$FRONTEND_TREE_HASH_FILE" ]]; then
    echo "no recorded frontend build tree hash at $FRONTEND_TREE_HASH_FILE — rebuilding to seed it"
    return 0
  fi

  local want have
  want=$(head -n 1 "$FRONTEND_TREE_HASH_FILE" | tr -d '[:space:]')
  have=$(frontend_tree_hash)
  if [[ ! "$have" =~ ^[0-9a-f]{64}$ ]]; then
    echo "could not compute the frontend tree hash (got '${have}') — rebuilding fail-safe instead of trusting the recorded hash"
    return 0
  fi
  if [[ "$have" != "$want" ]]; then
    echo "frontend/ working tree (sha256 ${have:0:8}) no longer matches the recorded last-build tree hash (${want:0:8}) — build output was likely reverted, e.g. by an un-popped git stash"
    return 0
  fi
  return 1
}

record_frontend_tree_hash() {
  local hash
  hash=$(frontend_tree_hash)
  # Fail closed on a malformed hash (empty when sha256sum/xargs break):
  # recording it would make every later deploy report "frontend/ matches
  # the last recorded build tree hash" by comparing empty to empty — a
  # green claim with no evidence behind it.
  if [[ ! "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: computed frontend tree hash is malformed ('${hash}') — refusing to record it." >&2
    echo "       The frontend deploy itself succeeded, but the staleness detector cannot produce evidence; fix the hash tooling (git/xargs/sha256sum) before the next deploy." >&2
    return 1
  fi
  mkdir -p "$DEPLOY_STATE_DIR"
  local tmp="${FRONTEND_TREE_HASH_FILE}.tmp.$$"
  printf '%s\n' "$hash" > "$tmp"
  mv "$tmp" "$FRONTEND_TREE_HASH_FILE"
  echo "Recorded frontend build tree hash: ${hash:0:8}"
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
  echo "       Check 'sudo docker logs $BACKEND_CONTAINER --tail 100' on the VPS." >&2
  return 1
}

verify_public_caddy_network_selection() {
  local expected_chain_id
  expected_chain_id=$(jq -er '.expectedChainId | tostring' "$CADDY_NETWORK_STATE_FILE")

  local health_url="${PUBLIC_API_HEALTH_URL:-https://api.averray.com/health}"
  local health_json
  echo "Verifying public API matches durable Caddy selection: chainId $expected_chain_id"
  if ! health_json=$(curl -fsS --retry 4 --retry-delay 1 --max-time 10 "$health_url"); then
    echo "ERROR: public API health is unreachable at $health_url." >&2
    return 1
  fi

  if ! printf '%s' "$health_json" | jq -e --arg chain "$expected_chain_id" \
      '[.. | objects | .chainId? // empty | tostring] | index($chain) != null' >/dev/null; then
    echo "ERROR: public API health does not report the selected chainId $expected_chain_id." >&2
    return 1
  fi

  echo "Durable Caddy selection verified publicly: chainId $expected_chain_id"
}

verify_public_deployed_sha() {
  local expected_sha="$1"
  local health_url="${HEALTH_URL:-https://api.averray.com/health}"
  local health_json actual_sha

  echo "Verifying public backend serves deployedSha $expected_sha"
  if ! health_json=$(curl -fsS --retry 4 --retry-delay 1 --max-time 10 "$health_url"); then
    echo "ERROR: cannot fetch public backend health at $health_url for deployedSha verification." >&2
    return 1
  fi
  if ! actual_sha=$(printf '%s' "$health_json" | jq -er '.deployedSha | strings'); then
    echo "ERROR: public /health does not expose deployedSha; refusing to record this deploy as landed." >&2
    return 1
  fi
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "ERROR: public /health deployedSha mismatch: expected $expected_sha, got $actual_sha." >&2
    echo "       The selected container may have started while public traffic still routes to another backend." >&2
    return 1
  fi
  echo "Public backend serving proof passed: deployedSha $actual_sha"
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
    sh -lc "npm ci --omit=dev && npm run build:site"
}

# Hash the bytes Caddy can serve, not the fact that the site build command ran.
# The site is rebuilt on every deploy to repair stale generated output, but a
# byte-identical rebuild is not a running-system change and must not trigger a
# paid worker canary.
site_content_hash() {
  local site_root="$APP_ROOT/site"
  if [[ ! -d "$site_root" ]]; then
    printf 'missing\n'
    return
  fi

  (
    cd "$site_root"
    find . -type f -print \
      | LC_ALL=C sort \
      | while IFS= read -r relative; do
          printf 'path=%s\n' "$relative"
          sha256sum "$relative"
        done
  ) | sha256sum | awk '{print $1}'
}

# 2026-06-28 → 2026-07-08 marketing-staleness incident: verify that the
# public homepage Caddy actually serves is byte-identical to the build
# just synced into $APP_ROOT/site. Caddy serves site/ from the checkout
# via a bind mount, so served-vs-built drift means the served directory
# is not the one we built into (stale bind mount after a directory
# replace, wrong Caddy root, or a cache in front). The old smoke check
# only grepped for "<title>Averray" — a 7-week-old page passed it.
verify_site_served() {
  local base_url="${PUBLIC_SITE_URL%/}"
  local entry
  for entry in "index.html /" "console-stream.js /console-stream.js"; do
    local file="${entry%% *}"
    local url_path="${entry#* }"
    local local_file="$APP_ROOT/site/$file"
    if [[ ! -f "$local_file" ]]; then
      echo "ERROR: built site file missing: $local_file — build:site did not produce it." >&2
      return 1
    fi

    local want have="" attempt ok=0
    want=$(sha256sum "$local_file" | awk '{print $1}')
    local tmp
    tmp=$(mktemp)
    for (( attempt=1; attempt<=SITE_SERVE_CHECK_ATTEMPTS; attempt++ )); do
      if curl -fsS --max-time 10 -H 'Cache-Control: no-cache' -o "$tmp" "$base_url$url_path"; then
        have=$(sha256sum "$tmp" | awk '{print $1}')
        if [[ "$have" == "$want" ]]; then
          ok=1
          break
        fi
      else
        have="fetch-failed"
      fi
      if (( attempt < SITE_SERVE_CHECK_ATTEMPTS )); then
        sleep "$SITE_SERVE_CHECK_INTERVAL_SEC"
      fi
    done
    rm -f "$tmp"

    if [[ "$ok" != "1" ]]; then
      {
        echo "ERROR: $base_url$url_path does not match the freshly built site/$file"
        echo "       (want sha256=$want, got ${have:-unknown})."
        echo "       Caddy serves site/ from the checkout bind mount; a mismatch means the served"
        echo "       directory is not the one just built. Check 'sudo docker inspect agent-caddy'"
        echo "       mounts, 'git -C $APP_ROOT status site/', and any cache/CDN in front."
      } >&2
      return 1
    fi
    echo "Served $base_url$url_path matches built site/$file (sha256 ${want:0:8})."
  done
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
    -e ADMIN_JWT_OP="${ADMIN_JWT_OP:-}" \
    -e ADMIN_REFRESH_FLOW="${ADMIN_REFRESH_FLOW:-}" \
    -e ADMIN_REFRESH_TOKEN="${ADMIN_REFRESH_TOKEN:-}" \
    -e ADMIN_REFRESH_TOKEN_OP="${ADMIN_REFRESH_TOKEN_OP:-}" \
    -e ADMIN_REFRESH_TOKEN_WRITE_BACK="${ADMIN_REFRESH_TOKEN_WRITE_BACK:-}" \
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

  local has_admin_refresh_flow=0
  case "${ADMIN_REFRESH_FLOW:-}" in
    1|true|yes) has_admin_refresh_flow=1 ;;
  esac

  if [[ -z "${PRODUCT_PROOF_WORKER_TOKEN:-}" \
    && -z "${AVERRAY_TOKEN:-}" \
    && -z "${ADMIN_JWT:-}" \
    && -z "${ADMIN_JWT_OP:-}" \
    && -z "${ADMIN_REFRESH_TOKEN:-}" \
    && -z "${ADMIN_REFRESH_TOKEN_OP:-}" \
    && "$has_admin_refresh_flow" -ne 1 ]]; then
    echo "PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1 requires PRODUCT_PROOF_WORKER_TOKEN, AVERRAY_TOKEN, ADMIN_JWT, ADMIN_JWT_OP, ADMIN_REFRESH_TOKEN, ADMIN_REFRESH_TOKEN_OP, or ADMIN_REFRESH_FLOW=1." >&2
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

  if [[ ! -f "$CREDENTIALS_ROOT/op-backend.env" ]] || [[ ! -f "$CREDENTIALS_ROOT/op-indexer.env" ]]; then
    echo "Phase 2 PR 2.5: $CREDENTIALS_ROOT/op-*.env not present, skipping render"
    echo "  (run scripts/ops/install-op-vps.sh and drop the service-account tokens to enable)"
    return 0
  fi

  if [[ ! -d "$RUNTIME_ROOT" ]]; then
    echo "Phase 2 PR 2.5: $RUNTIME_ROOT not present, skipping render"
    echo "  (install /etc/tmpfiles.d/agent-stack.conf and run systemd-tmpfiles --create)"
    return 0
  fi

  echo "Phase 2 PR 2.5: rendering $LIVE_NETWORK runtime env files via op inject (fail-closed)"

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
    local template target token legacy
    case "$runtime" in
      backend) template="$BACKEND_ENV_TEMPLATE" ;;
      indexer) template="$INDEXER_ENV_TEMPLATE" ;;
    esac
    target="$RUNTIME_ROOT/${runtime}.env"
    token="$CREDENTIALS_ROOT/op-${runtime}.env"
    if [[ "$LIVE_NETWORK" == "mainnet" ]]; then
      legacy="/srv/agent-stack-mainnet/${runtime}.env"
    else
      legacy="$STACK_ROOT/${runtime}.env"
    fi

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
      echo "       Containers consume $RUNTIME_ROOT/${runtime}.env via compose env_file:; stale or missing env would cause hard-to-diagnose failures downstream." >&2
      echo "       To roll back: inspect $COMPOSE_FILE and restore the selected $LIVE_NETWORK runtime env source before redeploying." >&2
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
      echo "Phase 2 PR 2.7d.1: $LIVE_NETWORK $runtime runtime env content changed (before=$before_label, after=${after_hash:0:8}) — will force-recreate"
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
  # APP_PUBLIC_SHELL renders app.averray.com without the basic-auth gate, so
  # the credential guards below must not apply — skipping the render in that
  # mode would leave the live Caddyfile gated forever, since this is the only
  # thing that rewrites it. render-caddyfile.sh does the actual omitting.
  case "${APP_PUBLIC_SHELL:-0}" in
    1|true|yes)
      echo "APP_PUBLIC_SHELL is set — rendering Caddy with a public operator shell." >&2
      ;;
    *)
      if [[ -z "${APP_BASIC_AUTH_USER:-}" ]]; then
        echo "Skipping Caddy render: APP_BASIC_AUTH_USER is not set." >&2
        echo "Set APP_BASIC_AUTH_USER plus APP_BASIC_AUTH_PASSWORD_HASH to deploy Caddy changes, or APP_PUBLIC_SHELL=1 for a public shell." >&2
        return 0
      fi

      if [[ -z "${APP_BASIC_AUTH_PASSWORD_HASH:-}" ]]; then
        echo "Skipping Caddy render: APP_BASIC_AUTH_PASSWORD_HASH is not set." >&2
        echo "PR 2.2 removed the raw-password code path; pass the bcrypt hash only." >&2
        return 0
      fi
      ;;
  esac

  # Render the new Caddyfile to a temporary candidate, validate it via
  # `caddy validate` inside the running caddy container, then copy its
  # contents into the mounted file in place. The single-file bind mount
  # must keep its inode; replacing the pathname with mv(1) can leave the
  # running container attached to stale bytes.
  local rendered_tmp
  rendered_tmp=$(mktemp "$STACK_ROOT/Caddyfile.XXXXXX")
  trap 'rm -f "$rendered_tmp"' RETURN

  local execution_user
  execution_user=$(id -un)
  local deploy_host
  deploy_host=$(hostname -f 2>/dev/null || hostname)
  local selection_operation_id="deploy-bootstrap-${NEW_SHA:0:12}-$(date -u +%Y%m%d-%H%M%S)"
  STACK_ROOT="$STACK_ROOT" "$APP_ROOT/scripts/ops/run-caddy-network-selection.sh" bootstrap \
    --state "$CADDY_NETWORK_STATE_FILE" \
    --live-caddy "$STACK_ROOT/Caddyfile" \
    --selected-by "$DEPLOY_ACTOR" \
    --execution-user "$execution_user" \
    --host "$deploy_host" \
    --source-revision "$NEW_SHA" \
    --operation-id "$selection_operation_id"

  local selection_status
  selection_status=$(STACK_ROOT="$STACK_ROOT" "$APP_ROOT/scripts/ops/run-caddy-network-selection.sh" status \
    --state "$CADDY_NETWORK_STATE_FILE" \
    --live-caddy "$STACK_ROOT/Caddyfile")
  printf '%s\n' "$selection_status"
  if ! printf '%s' "$selection_status" | jq -e '.consistent == true' >/dev/null; then
    echo "Caddy live route disagrees with the durable network selection; refusing an unguarded route repair." >&2
    echo "Use flip-caddy-network.sh <mainnet|testnet> so chain assertion and auto-rollback remain active." >&2
    return 1
  fi

  CADDY_NETWORK_STATE_FILE="$CADDY_NETWORK_STATE_FILE" \
    "$APP_ROOT/scripts/ops/render-caddyfile.sh" "$rendered_tmp"

  # caddy validate inside the running caddy container. The container's
  # Caddyfile path is /etc/caddy/Caddyfile; we mount the rendered tmp
  # over that path with `-v` for the validate call only. If the
  # validate fails, caddy returns non-zero and `set -e` aborts the
  # deploy before we touch the live config.
  echo "Validating rendered Caddyfile via caddy validate (PR 2.2)..."
  local container_candidate
  container_candidate="/tmp/averray-caddy-deploy-$$"
  docker cp "$rendered_tmp" "$CADDY_CONTAINER:$container_candidate"
  if ! docker exec "$CADDY_CONTAINER" \
        caddy validate --config "$container_candidate" --adapter caddyfile; then
    docker exec "$CADDY_CONTAINER" rm -f "$container_candidate" >/dev/null 2>&1 || true
    echo "ERROR: caddy validate rejected the rendered Caddyfile; aborting before reload." >&2
    rm -f "$rendered_tmp"
    return 1
  fi
  docker exec "$CADDY_CONTAINER" rm -f "$container_candidate" >/dev/null 2>&1 || true

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
  echo "Phase 2 PR 2.7d.2: Caddyfile content changed (before=$before_label, after=${after_hash:0:8}) — installing in place + reloading caddy"

  local live_backup
  live_backup=$(mktemp "$STACK_ROOT/.Caddyfile.deploy-backup.XXXXXX")
  cp -p "$STACK_ROOT/Caddyfile" "$live_backup"

  # This copy is intentionally in-place (not atomic) because Caddy bind-mounts
  # this single file. The candidate is already validated above, and `caddy
  # reload` validates it again while retaining the old running config on
  # failure.
  cp "$rendered_tmp" "$STACK_ROOT/Caddyfile"
  chmod 0644 "$STACK_ROOT/Caddyfile"
  rm -f "$rendered_tmp"
  trap - RETURN

  if ! docker exec "$CADDY_CONTAINER" \
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cp -p "$live_backup" "$STACK_ROOT/Caddyfile"
    docker exec "$CADDY_CONTAINER" \
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    rm -f "$live_backup"
    echo "ERROR: Caddy reload rejected the installed file; original bytes restored in place." >&2
    return 1
  fi
  rm -f "$live_backup"
  CADDY_RESTARTED=1
}

read_current_indexer_schema() {
  if [[ -f "$INDEXER_ENV_FILE" ]]; then
    awk -F= '/^DATABASE_SCHEMA=/{ sub(/^DATABASE_SCHEMA=/, ""); print; exit }' "$INDEXER_ENV_FILE" | tr -d '"'
  fi
}

indexer_schema_state_file() {
  if [[ -n "$INDEXER_SCHEMA_STATE_FILE" ]]; then
    printf '%s\n' "$INDEXER_SCHEMA_STATE_FILE"
    return
  fi
  printf '%s\n' "$DEPLOY_STATE_DIR/indexer.database-schema.$LIVE_NETWORK"
}

read_persisted_indexer_schema() {
  local state_file
  state_file=$(indexer_schema_state_file)
  if [[ -f "$state_file" ]]; then
    awk 'NF { print; exit }' "$state_file" | tr -d '"'
    return
  fi
  if [[ -z "$INDEXER_SCHEMA_STATE_FILE" && -f "$LEGACY_INDEXER_SCHEMA_STATE_FILE" ]]; then
    if [[ "$LIVE_NETWORK" == "testnet" ]]; then
      awk 'NF { print; exit }' "$LEGACY_INDEXER_SCHEMA_STATE_FILE" | tr -d '"'
    else
      echo "Ignoring legacy unscoped indexer schema override at $LEGACY_INDEXER_SCHEMA_STATE_FILE (testnet-era state) for network $LIVE_NETWORK." >&2
    fi
  fi
}

indexer_identity_state_file() {
  if [[ -n "$INDEXER_IDENTITY_STATE_FILE" ]]; then
    printf '%s\n' "$INDEXER_IDENTITY_STATE_FILE"
    return
  fi
  printf '%s\n' "$DEPLOY_STATE_DIR/indexer.app-identity.$LIVE_NETWORK"
}

indexer_resync_state_file() {
  if [[ -n "$INDEXER_RESYNC_STATE_FILE" ]]; then
    printf '%s\n' "$INDEXER_RESYNC_STATE_FILE"
    return
  fi
  printf '%s\n' "$DEPLOY_STATE_DIR/indexer.resync.$LIVE_NETWORK"
}

read_persisted_indexer_identity() {
  local state_file
  state_file=$(indexer_identity_state_file)
  if [[ -f "$state_file" ]]; then
    awk 'NF { print; exit }' "$state_file" | tr -d '"[:space:]'
  fi
}

write_atomic_state_value() {
  local state_file="$1"
  local value="$2"
  local dir
  dir=$(dirname "$state_file")
  mkdir -p "$dir"
  local tmp="${state_file}.tmp.$$"
  printf '%s\n' "$value" > "$tmp"
  mv "$tmp" "$state_file"
}

write_persisted_indexer_schema() {
  local schema="$1"
  local state_file
  state_file=$(indexer_schema_state_file)
  write_atomic_state_value "$state_file" "$schema"
  echo "Persisted indexer DATABASE_SCHEMA override in $state_file: $schema"
}

write_persisted_indexer_identity() {
  local identity="$1"
  local state_file
  state_file=$(indexer_identity_state_file)
  write_atomic_state_value "$state_file" "$identity"
  echo "Persisted indexer app identity in $state_file: $identity"
}

indexer_tree_identity() {
  local revision="$1"
  git -C "$APP_ROOT" rev-parse "${revision}:indexer" 2>/dev/null
}

indexer_ponder_config_identity() {
  local revision="$1"
  local template_path="${INDEXER_ENV_TEMPLATE#$APP_ROOT/}"
  local template=""
  template=$(git -C "$APP_ROOT" show "${revision}:${template_path}" 2>/dev/null) || return 1

  # Ponder's schema ownership depends on the resolved app configuration, not
  # just the indexer source tree. Hash only committed, non-secret Ponder/chain
  # inputs; DATABASE_SCHEMA is deliberately excluded because it is the value
  # this identity selects.
  local config=""
  config=$(
    printf '%s\n' "$template" \
      | awk -F= '$1 == "POLKADOT_CHAIN_ID" || $1 == "POLKADOT_CHAIN_NAME" || $1 ~ /^PONDER_[A-Z0-9_]+$/ { print }' \
      | LC_ALL=C sort
  )
  [[ -n "$config" ]] || return 1
  printf '%s\n' "$config" | git -C "$APP_ROOT" hash-object --stdin
}

indexer_app_identity() {
  local revision="$1"
  local tree_identity=""
  local config_identity=""
  tree_identity=$(indexer_tree_identity "$revision") || return 1
  config_identity=$(indexer_ponder_config_identity "$revision") || return 1
  printf 'indexer_tree=%s\nponder_config=%s\n' "$tree_identity" "$config_identity" \
    | git -C "$APP_ROOT" hash-object --stdin
}

mint_indexer_schema() {
  local identity="$1"
  local nonce
  nonce=$(
    printf '%s' "${LIVE_NETWORK}:$(date -u +%Y%m%d%H%M%S%N):$$:${identity}" \
      | git hash-object --stdin \
      | cut -c1-8
  )
  printf 'agent_indexer_%s_%s_%s\n' \
    "$LIVE_NETWORK" \
    "$(date -u +%Y%m%d%H%M%S)" \
    "$nonce"
}

acquire_indexer_schema_lock() {
  if [[ "$INDEXER_SCHEMA_LOCK_ACQUIRED" == "1" ]]; then
    return
  fi
  if [[ -z "$INDEXER_SCHEMA_LOCK_FILE" ]]; then
    # One host-level lock serializes claims across both retained stacks. Ponder
    # shares the same Postgres service, so network-specific lock files would
    # still allow two schema migrations to race inside that database.
    INDEXER_SCHEMA_LOCK_FILE="/tmp/averray-indexer-schema.lock"
  fi
  exec 8>"$INDEXER_SCHEMA_LOCK_FILE"
  if ! flock -n 8; then
    echo "Another indexer deploy currently owns the $LIVE_NETWORK schema claim lock ($INDEXER_SCHEMA_LOCK_FILE)." >&2
    echo "Rejecting this indexer step before DATABASE_SCHEMA or the running container can change; retry after the active deploy finishes." >&2
    exit 1
  fi
  INDEXER_SCHEMA_LOCK_ACQUIRED=1
  echo "Indexer schema claim lock acquired: $INDEXER_SCHEMA_LOCK_FILE"
}

release_indexer_schema_lock() {
  if [[ "$INDEXER_SCHEMA_LOCK_ACQUIRED" == "1" ]]; then
    exec 8>&-
    INDEXER_SCHEMA_LOCK_ACQUIRED=0
    echo "Indexer schema claim lock released."
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
    echo "Runtime env files are rendered before schema overrides; check render_runtime_envs output above." >&2
    exit 1
  fi

  local tmp
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' RETURN
  awk '!/^DATABASE_SCHEMA=/' "$INDEXER_ENV_FILE" > "$tmp"
  printf 'DATABASE_SCHEMA=%s\n' "$schema" >> "$tmp"

  local mode owner_group
  if mode=$(stat -c '%a' "$INDEXER_ENV_FILE" 2>/dev/null); then
    owner_group=$(stat -c '%U:%G' "$INDEXER_ENV_FILE")
  else
    mode=$(stat -f '%Lp' "$INDEXER_ENV_FILE")
    owner_group=$(stat -f '%Su:%Sg' "$INDEXER_ENV_FILE")
  fi
  chmod "$mode" "$tmp"

  case "$INDEXER_ENV_FILE" in
    /run/agent-stack/*|/run/agent-stack-mainnet/*)
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
  local indexer_deploy_requested="${1:-0}"
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

  local persisted_schema=""
  persisted_schema=$(read_persisted_indexer_schema)
  if [[ -n "$persisted_schema" ]]; then
    validate_indexer_schema "$persisted_schema"
  fi

  local candidate_tree_identity=""
  candidate_tree_identity=$(indexer_tree_identity "$NEW_SHA") || {
    echo "Cannot compute the incoming indexer source identity from $NEW_SHA:indexer; refusing schema selection before container recreation." >&2
    exit 1
  }
  local candidate_identity=""
  candidate_identity=$(indexer_app_identity "$NEW_SHA") || {
    echo "Cannot compute the incoming indexer app/config identity from $NEW_SHA:indexer and $INDEXER_ENV_TEMPLATE; refusing schema selection before container recreation." >&2
    exit 1
  }
  local persisted_identity=""
  persisted_identity=$(read_persisted_indexer_identity)
  local deployed_identity=""
  local deployed_tree_identity=""
  local deployed_sha=""
  deployed_sha=$(read_component_sha indexer)
  deployed_tree_identity=$(indexer_tree_identity "$deployed_sha" || true)
  deployed_identity=$(indexer_app_identity "$deployed_sha" || true)

  # #833 originally persisted only the indexer Git tree. Upgrade that legacy
  # value in memory using the last-good deploy SHA so a host that already
  # recovered onto the current config does not rotate twice. When the config
  # changed since the last-good SHA, the composite identities differ and the
  # normal path below rotates before Ponder starts.
  local previous_identity="$persisted_identity"
  if [[ -n "$previous_identity" \
    && -n "$deployed_tree_identity" \
    && "$previous_identity" == "$deployed_tree_identity" \
    && -n "$deployed_identity" ]]; then
    previous_identity="$deployed_identity"
    echo "Upgrading legacy tree-only indexer owner identity from last-good deploy $deployed_sha: $previous_identity"
  fi

  # Hosts predating any ownership record can safely bootstrap only when the
  # incoming composite identity is byte-identical to the last successfully
  # deployed app/config identity. Any other unknown/mismatched identity rotates
  # rather than gambling on Ponder accepting the old schema at container start.
  if [[ -z "$previous_identity" && -n "$deployed_identity" && "$deployed_identity" == "$candidate_identity" ]]; then
    previous_identity="$deployed_identity"
    echo "Bootstrapping indexer app identity from last-good deploy $deployed_sha: $previous_identity"
  fi

  local identity_changed=0
  local identity_change_reason="app_identity_changed"
  if [[ "$indexer_deploy_requested" == "1" && "$candidate_identity" != "$previous_identity" ]]; then
    identity_changed=1
    if [[ -n "$deployed_tree_identity" && "$candidate_tree_identity" == "$deployed_tree_identity" ]]; then
      identity_change_reason="ponder_config_changed"
    fi
    if [[ -n "$previous_identity" ]]; then
      echo "Pre-swap schema ownership check: incoming indexer identity $candidate_identity differs from owner $previous_identity."
    else
      echo "Pre-swap schema ownership check: the current schema has no trustworthy owner identity for incoming $candidate_identity."
    fi
  else
    echo "Pre-swap schema ownership check: incoming identity $candidate_identity matches the last-good owner."
  fi

  local target_schema=""
  if [[ -n "$INDEXER_DATABASE_SCHEMA" ]]; then
    validate_indexer_schema "$INDEXER_DATABASE_SCHEMA"
    target_schema="$INDEXER_DATABASE_SCHEMA"
    echo "Operator pinned indexer DATABASE_SCHEMA: $target_schema"
    if [[ "$identity_changed" == "1" && ( "$target_schema" == "$current_schema" || "$target_schema" == "$persisted_schema" ) ]]; then
      echo "Indexer app identity changed, but explicit DATABASE_SCHEMA $target_schema is still owned by the previous app." >&2
      echo "Choose a never-used schema or omit INDEXER_DATABASE_SCHEMA to let the deploy rotate automatically. Refusing before container recreation." >&2
      exit 1
    fi
    if [[ "$identity_changed" == "1" ]]; then
      INDEXER_SCHEMA_ROTATED=1
      INDEXER_SCHEMA_ROTATION_REASON="operator_schema_for_app_identity_change"
    fi
  elif [[ "$INDEXER_FRESH_SCHEMA" == "1" ]]; then
    target_schema=$(mint_indexer_schema "$candidate_identity")
    validate_indexer_schema "$target_schema"
    INDEXER_SCHEMA_ROTATED=1
    INDEXER_SCHEMA_ROTATION_REASON="operator_requested_fresh_schema"
    echo "INDEXER_FRESH_SCHEMA=1 — minting fresh DATABASE_SCHEMA: $target_schema"
  elif [[ "$identity_changed" == "1" ]]; then
    target_schema=$(mint_indexer_schema "$candidate_identity")
    validate_indexer_schema "$target_schema"
    INDEXER_SCHEMA_ROTATED=1
    INDEXER_SCHEMA_ROTATION_REASON="$identity_change_reason"
    echo "::warning::Indexer app/config identity changed; automatically rotating DATABASE_SCHEMA before container recreation: ${current_schema:-${persisted_schema:-<default>}} -> $target_schema"
  else
    if [[ -n "$persisted_schema" ]]; then
      target_schema="$persisted_schema"
      echo "Reapplying persisted indexer DATABASE_SCHEMA override: $target_schema"
    elif [[ -n "$current_schema" ]]; then
      target_schema="$current_schema"
    else
      return 0
    fi
  fi

  # The rendered env may have just reset DATABASE_SCHEMA to the committed
  # template. The persisted value is the schema the running container actually
  # claimed, so it is the rollback source of truth when one exists.
  INDEXER_PREVIOUS_SCHEMA="${persisted_schema:-$current_schema}"
  INDEXER_TARGET_SCHEMA="$target_schema"
  INDEXER_PREVIOUS_IDENTITY="$previous_identity"
  INDEXER_TARGET_IDENTITY="$candidate_identity"
  INDEXER_OWNERSHIP_STATE_PENDING=1

  if [[ -n "$current_schema" && "$current_schema" == "$target_schema" ]]; then
    echo "Indexer DATABASE_SCHEMA already current: $target_schema"
  elif [[ -n "$current_schema" ]]; then
    echo "Replacing existing DATABASE_SCHEMA ($current_schema) with $target_schema."
    write_indexer_schema "$target_schema"
  else
    write_indexer_schema "$target_schema"
  fi

  if [[ "$INDEXER_SCHEMA_ROTATED" == "1" ]]; then
    {
      echo "::warning::INDEXER HISTORICAL RE-SYNC STARTING"
      echo "::warning::network=$LIVE_NETWORK previous_schema=${INDEXER_PREVIOUS_SCHEMA:-<default>} new_schema=$INDEXER_TARGET_SCHEMA"
      echo "::warning::reason=$INDEXER_SCHEMA_ROTATION_REASON old_identity=${INDEXER_PREVIOUS_IDENTITY:-unknown} new_identity=$INDEXER_TARGET_IDENTITY"
      echo "::warning::The indexer will be live but staged while it replays from its configured start block. externalPostingWatcherLagSeconds must remain visible until catch-up."
    } >&2
  fi
}

commit_indexer_schema_ownership() {
  if [[ "$INDEXER_OWNERSHIP_STATE_PENDING" != "1" ]]; then
    return
  fi
  write_persisted_indexer_schema "$INDEXER_TARGET_SCHEMA"
  write_persisted_indexer_identity "$INDEXER_TARGET_IDENTITY"

  if [[ "$INDEXER_SCHEMA_ROTATED" == "1" ]]; then
    local state_file
    state_file=$(indexer_resync_state_file)
    local dir
    dir=$(dirname "$state_file")
    mkdir -p "$dir"
    local tmp="${state_file}.tmp.$$"
    {
      printf 'initial_status=staged\n'
      printf 'network=%s\n' "$LIVE_NETWORK"
      printf 'schema=%s\n' "$INDEXER_TARGET_SCHEMA"
      printf 'previous_schema=%s\n' "${INDEXER_PREVIOUS_SCHEMA:-unknown}"
      printf 'identity=%s\n' "$INDEXER_TARGET_IDENTITY"
      printf 'previous_identity=%s\n' "${INDEXER_PREVIOUS_IDENTITY:-unknown}"
      printf 'reason=%s\n' "$INDEXER_SCHEMA_ROTATION_REASON"
      printf 'source_sha=%s\n' "$NEW_SHA"
      printf 'selected_by=%s\n' "$DEPLOY_ACTOR"
      printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'honest_degradation_signal=externalPostingWatcherLagSeconds\n'
    } > "$tmp"
    mv "$tmp" "$state_file"
    echo "::warning::Indexer re-sync record written to $state_file (initial_status=staged)."
  fi
}

ensure_witness_verify_worker() {
  local runtime_env="$RUNTIME_ROOT/backend.env"
  # Narrow deploy fixtures and component-only recovery runs may intentionally
  # have no rendered backend env. In that case no Verify-enabled backend is
  # being started, so there is no worker precondition to satisfy.
  if [[ ! -f "$runtime_env" ]]; then
    if [[ "${X402_VERIFY_MODE:-disabled}" == "enabled" ]]; then
      echo "X402_VERIFY_MODE is enabled but $runtime_env is missing." >&2
      return 1
    fi
    return 0
  fi
  local mode
  mode=$(awk -F= '$1 == "X402_VERIFY_MODE" { value=$2 } END { print value }' "$runtime_env")
  if [[ "$mode" != "enabled" ]]; then
    return 0
  fi

  local unit_source="$APP_ROOT/deploy/averray-witness-verify@.service"
  local unit_target="/etc/systemd/system/averray-witness-verify@.service"
  local queue_root="/srv/agent-stack/verify-queue"
  local work_root="/srv/agent-stack/witness-work"
  if [[ "$LIVE_NETWORK" == "mainnet" ]]; then
    queue_root="/srv/agent-stack-mainnet/verify-queue"
    work_root="/srv/agent-stack-mainnet/witness-work"
  fi

  echo "Preparing offline Witness worker for $LIVE_NETWORK"
  sudo install -d -o ubuntu -g ubuntu -m 0700 "$queue_root" "$work_root"
  sudo install -m 0644 "$unit_source" "$unit_target"
  sudo systemctl daemon-reload
  if ! sudo docker image inspect averray-witness-preflight:phase1-uv-0.12.5-python-3.12.12-uv-build-0.9.27 >/dev/null 2>&1; then
    sudo docker build --pull \
      -t averray-witness-preflight:phase1-uv-0.12.5-python-3.12.12-uv-build-0.9.27 \
      "$APP_ROOT/witness/sandbox"
  fi
  sudo systemctl enable "averray-witness-verify@$LIVE_NETWORK.service" >/dev/null
  sudo systemctl restart "averray-witness-verify@$LIVE_NETWORK.service"

  local heartbeat="$queue_root/worker-heartbeat.json"
  local deadline=$(( $(date +%s) + 60 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if [[ -s "$heartbeat" ]] && jq -e '.worker == "averray-witness-git-patch-tests-v1" and (.at | type == "string")' "$heartbeat" >/dev/null 2>&1; then
      echo "Offline Witness worker heartbeat is ready."
      return 0
    fi
    sleep 1
  done
  echo "Offline Witness worker did not publish a valid heartbeat within 60 seconds." >&2
  sudo systemctl status --no-pager "averray-witness-verify@$LIVE_NETWORK.service" >&2 || true
  return 1
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
  resolve_deploy_target

  if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
    echo "No new commits. Running smoke check only."
  fi

  enforce_contract_compat_freeze
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
  local run_backend=0
  local run_indexer=0
  local run_frontend=0
  local run_site=0
  local run_caddy=0
  local backend_deployed_sha=""
  local deployed_components=()
  local indexer_code_changed=0
  local indexer_config_changed=0
  local indexer_schema_check_requested=1

  # Resolve the indexer path gate before schema selection. Ponder ties a
  # DATABASE_SCHEMA to a build + contract-config identity, so incoming indexer
  # source and Ponder env changes must be compared with the last-good owner
  # before anything recreates the container. The comparison is unconditional
  # on normal deploys: a prior failed deploy may already have fast-forwarded
  # the checkout and rendered the new env, so the current OLD..NEW range alone
  # is not authoritative.
  # A forced RUN_INDEXER=1 is intentionally treated as a deploy request; an
  # explicit RUN_INDEXER=0 leaves both the running indexer and schema untouched.
  if should_run indexer "$RUN_INDEXER" '^(indexer/|scripts/ops/redeploy-indexer\.sh)'; then
    indexer_code_changed=1
  fi
  case "$RUN_INDEXER" in
    0|false|no) indexer_schema_check_requested=0 ;;
    *)
      if changed_matches '^deploy/indexer(\.mainnet)?\.env\.template$'; then
        indexer_config_changed=1
      fi
      ;;
  esac

  render_runtime_envs
  ensure_witness_verify_worker
  if [[ "$indexer_schema_check_requested" == "1" \
    || -n "$INDEXER_DATABASE_SCHEMA" \
    || "$INDEXER_FRESH_SCHEMA" != "0" ]]; then
    acquire_indexer_schema_lock
    apply_indexer_database_schema 1
  fi

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
  if should_run backend "$RUN_BACKEND" '^(mcp-server/|witness/|sdk/|examples/|docs/(api/openapi\.json|schemas/|VERIFY_SHELF_OPERATIONS\.md)|package(-lock)?\.json|scripts/ops/(deploy-production|redeploy-backend)\.sh|deploy/(averray-witness-verify@\.service|backend(\.mainnet)?\.env\.template|docker-compose\.mainnet\.yml)|deployments/(testnet|mainnet)\.json)'; then
    backend_code_changed=1
  fi
  if [[ "$backend_code_changed" == "1" || "${RUNTIME_ENV_CHANGED_BACKEND:-0}" == "1" ]]; then
    run_backend=1
    deployed_components+=(backend)
    if [[ "$backend_code_changed" == "1" ]]; then
      echo "Deploying backend (reason: code path changed)"
      # The badge-receipt preflight declaration is per network: mainnet has
      # its own Roles Anywhere trust anchor/profile/role, so checking the
      # testnet declaration against the mainnet mounted aws-config can never
      # pass (2026-07-27 deploy failure after the schema-override fix).
      local badge_profile_declaration="$APP_ROOT/deploy/aws-config.badge-receipt-profile"
      if [[ "$LIVE_NETWORK" == "mainnet" ]]; then
        badge_profile_declaration="$APP_ROOT/deploy/aws-config.badge-receipt-profile.mainnet"
      fi
      COMPOSE_FILE="$COMPOSE_FILE" \
        COMPOSE_PROJECT_DIRECTORY="$COMPOSE_PROJECT_DIRECTORY" \
        BACKEND_SERVICE="$BACKEND_SERVICE" \
        BACKEND_CONTAINER="$BACKEND_CONTAINER" \
        BACKEND_ENV_TEMPLATE="$BACKEND_ENV_TEMPLATE" \
        BACKEND_ENV_TARGET="$RUNTIME_ROOT/backend.env" \
        BACKEND_ENV_TOKEN="$CREDENTIALS_ROOT/op-backend.env" \
        AWS_CONFIG_PATH="$CREDENTIALS_ROOT/aws-config" \
        BADGE_RECEIPT_CERT_PATH="$CREDENTIALS_ROOT/roles-anywhere/badge-receipt-signer-cert.pem" \
        BADGE_RECEIPT_KEY_PATH="$CREDENTIALS_ROOT/roles-anywhere/badge-receipt-signer-key.pem" \
        BADGE_RECEIPT_PROFILE_DECLARATION="$badge_profile_declaration" \
        SKIP_GIT_UPDATE=1 \
        PRE_DEPLOY_SHA="$OLD_SHA" \
        "$APP_ROOT/scripts/ops/redeploy-backend.sh"
      backend_deployed_sha="$NEW_SHA"
    else
      echo "Deploying backend (reason: $RUNTIME_ROOT/backend.env content changed; image unchanged — force-recreating $BACKEND_SERVICE only)"
      sudo docker compose --project-directory "$COMPOSE_PROJECT_DIRECTORY" -f "$COMPOSE_FILE" \
        up -d --force-recreate "$BACKEND_SERVICE"
      # Don't continue to downstream smoke checks until /health is 200
      # — see wait_for_backend_health() comment for the 2026-05-13 14:30Z
      # incident that motivated this.
      if ! wait_for_backend_health; then
        exit 1
      fi
    fi
  else
    echo "Skipping backend deploy"
  fi

  # The indexer image installs from indexer/package.json inside indexer/Dockerfile;
  # it does not copy or consume the root workspace package.json/package-lock.json.
  # Treating either root file as indexer code caused an app-only dependency change
  # to restart Ponder and trip schema recovery on 2026-07-12. Changes to the
  # indexer's own dependency manifest remain covered by the indexer/ prefix.
  if [[ "$indexer_code_changed" == "1" \
    || "$indexer_config_changed" == "1" \
    || "${RUNTIME_ENV_CHANGED_INDEXER:-0}" == "1" ]]; then
    run_indexer=1
    deployed_components+=(indexer)
    local indexer_build_image=0
    local indexer_previous_sha="$NEW_SHA"
    local indexer_wait_for_ready="$WAIT_FOR_READY"
    local indexer_health_stability="$HEALTH_STABILITY_SEC"
    if [[ "$indexer_code_changed" == "1" ]]; then
      indexer_build_image=1
      indexer_previous_sha="$OLD_SHA"
      echo "Deploying indexer (reason: code path changed)"
    elif [[ "$indexer_config_changed" == "1" ]]; then
      echo "Deploying indexer (reason: committed Ponder config changed; image unchanged)"
    else
      echo "Deploying indexer (reason: $RUNTIME_ROOT/indexer.env content changed; image unchanged)"
    fi
    if [[ "$INDEXER_SCHEMA_ROTATED" == "1" ]]; then
      indexer_wait_for_ready=0
      if [[ ! "$indexer_health_stability" =~ ^[0-9]+$ ]] || (( indexer_health_stability < 15 )); then
        indexer_health_stability=15
      fi
      echo "::warning::Fresh indexer schema selected; gating on stable /health and leaving /ready staged during the historical re-sync."
    fi
    COMPOSE_FILE="$COMPOSE_FILE" \
      COMPOSE_PROJECT_DIRECTORY="$COMPOSE_PROJECT_DIRECTORY" \
      INDEXER_SERVICE="$INDEXER_SERVICE" \
      INDEXER_ENV_TEMPLATE="$INDEXER_ENV_TEMPLATE" \
      INDEXER_ENV_TARGET="$RUNTIME_ROOT/indexer.env" \
      INDEXER_ENV_TOKEN="$CREDENTIALS_ROOT/op-indexer.env" \
      CADDY_COMPOSE_FILE="$CADDY_COMPOSE_FILE" \
      CADDY_PROJECT_DIRECTORY="$CADDY_PROJECT_DIRECTORY" \
      CADDY_CONTAINER="$CADDY_CONTAINER" \
      INDEXER_BUILD_IMAGE="$indexer_build_image" \
      INDEXER_SCHEMA_PREFLIGHTED=1 \
      INDEXER_SCHEMA_LOCK_HELD=1 \
      INDEXER_SCHEMA_LOCK_FILE="$INDEXER_SCHEMA_LOCK_FILE" \
      ROLLBACK_INDEXER_SCHEMA="$INDEXER_PREVIOUS_SCHEMA" \
      WAIT_FOR_READY="$indexer_wait_for_ready" \
      HEALTH_STABILITY_SEC="$indexer_health_stability" \
      SKIP_GIT_UPDATE=1 \
      PRE_DEPLOY_SHA="$indexer_previous_sha" \
      "$APP_ROOT/scripts/ops/redeploy-indexer.sh"
    commit_indexer_schema_ownership
    mark_component_deployed indexer
    release_indexer_schema_lock
  else
    echo "Skipping indexer deploy"
    release_indexer_schema_lock
  fi

  # The frontend keeps its path gate — unlike the site (~45s astro build),
  # build:frontend is a full Next.js workspace build (production npm ci + next build,
  # minutes in the docker runner) plus the wait_for_app/rollback cycle, too
  # expensive to pay on every docs-only deploy. Instead, the auto path adds
  # the frontend_tree_drift_reason disk check (see its comment block for the
  # 2026-06-28 stash incident) so a reverted working tree forces a rebuild
  # even when no frontend path changed. A served-hash check like
  # verify_site_served is NOT possible here: app.averray.com sits behind
  # Caddy basic-auth and the deploy runner deliberately has no credentials
  # (see wait_for_app's 401-pass rationale in redeploy-frontend.sh); Caddy
  # serves frontend/ from the same checkout bind mount, so for this failure
  # class disk state IS what gets served.
  local frontend_reason=""
  case "$RUN_FRONTEND" in
    0|false|no)
      echo "Skipping operator frontend deploy (RUN_FRONTEND=$RUN_FRONTEND) — frontend/ disk staleness is also NOT checked; app.averray.com may keep serving stale committed files"
      ;;
    1|true|yes)
      frontend_reason="forced by RUN_FRONTEND=$RUN_FRONTEND"
      ;;
    auto)
      if component_changed_matches frontend '^(app/|frontend/|scripts/sync-operator-frontend\.mjs|scripts/ops/redeploy-frontend\.sh|scripts/ops/deploy-production\.sh|package(-lock)?\.json)'; then
        frontend_reason="code path changed"
      else
        frontend_reason=$(frontend_tree_drift_reason || true)
      fi
      ;;
    *)
      echo "Invalid deploy toggle: $RUN_FRONTEND" >&2
      exit 1
      ;;
  esac

  if [[ -n "$frontend_reason" ]]; then
    run_frontend=1
    deployed_components+=(frontend)
    echo "Deploying operator frontend (reason: $frontend_reason)"
    SKIP_GIT_UPDATE=1 PRE_DEPLOY_SHA="$OLD_SHA" "$APP_ROOT/scripts/ops/redeploy-frontend.sh"
    record_frontend_tree_hash
    mark_component_deployed frontend
  elif [[ "$RUN_FRONTEND" == "auto" ]]; then
    echo "Skipping operator frontend deploy (frontend/ matches the last recorded build tree hash)"
  fi

  # 2026-06-28 → 2026-07-08 marketing-staleness incident: the site build
  # is no longer path-gated. The served site is UNCOMMITTED working-tree
  # output layered over stale committed site/ copies, so the path gate's
  # assumption — "if no site path changed since the site pointer, the
  # working tree still holds the last build" — is false whenever anything
  # stash-cleans the checkout. On 2026-06-28 an ops backend rollback ran
  # `git stash push -u` ("ops path-b backend rollback pre-state") before
  # checking out c683f39 and never popped it; that swept the built
  # site/index.html + console-stream.js away and restored the committed
  # pre-#409 copies, which Caddy served for 10 days because no subsequent
  # deploy range matched the site path gate. Rebuilding every deploy
  # (~45s in the docker runner) makes any such revert self-heal on the
  # next deploy; RUN_SITE=0 stays as the escape hatch for an urgent
  # deploy while the marketing build itself is broken. The source pattern is
  # retained for an auditable build reason, not as a gate; it includes the
  # discovery-manifest source now that build:site consumes that function.
  local site_build_reason=""
  case "$RUN_SITE" in
    0|false|no)
      echo "Skipping public site build (RUN_SITE=$RUN_SITE) — served-site hash verification is also skipped; www.averray.com is NOT checked by this deploy"
      ;;
    1|true|yes)
      run_site=1
      site_build_reason="forced by RUN_SITE=$RUN_SITE"
      ;;
    auto)
      run_site=1
      if component_changed_matches site "$SITE_SOURCE_PATTERN"; then
        site_build_reason="site source path changed"
      else
        site_build_reason="automatic safety rebuild; path gate removed after the 2026-06-28 stash regression"
      fi
      ;;
    *)
      echo "Invalid deploy toggle: $RUN_SITE" >&2
      exit 1
      ;;
  esac

  if [[ "$run_site" == "1" ]]; then
      echo "Building public site (reason: $site_build_reason)"
      local site_hash_before site_hash_after
      site_hash_before=$(site_content_hash)
      build_site
      site_hash_after=$(site_content_hash)
      if [[ "$site_hash_before" != "$site_hash_after" ]]; then
        deployed_components+=(site)
        echo "Public site output changed (${site_hash_before:0:8} -> ${site_hash_after:0:8})."
      else
        echo "Public site rebuild was byte-identical (${site_hash_after:0:8}); not a running-system change."
      fi
      mark_component_deployed site
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
      verify_public_caddy_network_selection
      run_caddy="$CADDY_RESTARTED"
      if [[ "$CADDY_RESTARTED" == "1" ]]; then
        deployed_components+=(caddy)
        mark_component_deployed caddy
      fi
      ;;
  esac

  # Runs after apply_caddy so a Caddy restart in this deploy is the state
  # being verified. Fail-closed: a mismatch here is exactly the silent
  # staleness the 2026-06-28 incident shipped for 10 days.
  if [[ "$run_site" == "1" ]]; then
    echo "Verifying served public site matches the fresh build"
    verify_site_served
  fi

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

  local expected_backend_sha
  expected_backend_sha=${backend_deployed_sha:-$(read_component_sha backend)}
  verify_public_deployed_sha "$expected_backend_sha"
  if [[ -n "$backend_deployed_sha" ]]; then
    mark_component_deployed backend
  fi

  emit_deploy_result "$OLD_SHA" "$NEW_SHA" ${deployed_components[@]+"${deployed_components[@]}"}
  echo "Production deploy completed."
}

emit_deploy_result() {
  local old_sha="$1"
  local new_sha="$2"
  shift 2

  local changed=false
  if (( $# > 0 )); then
    changed=true
  fi

  local components_json="["
  local separator=""
  local component
  for component in "$@"; do
    components_json+="${separator}\"${component}\""
    separator=","
  done
  components_json+="]"

  printf 'AVERRAY_DEPLOY_RESULT={"schemaVersion":1,"changed":%s,"oldSha":"%s","newSha":"%s","components":%s}\n' \
    "$changed" "$old_sha" "$new_sha" "$components_json"
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
