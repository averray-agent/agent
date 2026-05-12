#!/usr/bin/env bash

set -euo pipefail

PUBLIC_SITE_URL=${PUBLIC_SITE_URL:-https://averray.com/}
DISCOVERY_URL=${DISCOVERY_URL:-https://averray.com/.well-known/agent-tools.json}
APP_URL=${APP_URL:-https://app.averray.com/}
API_HEALTH_URL=${API_HEALTH_URL:-https://api.averray.com/health}
API_ONBOARDING_URL=${API_ONBOARDING_URL:-https://api.averray.com/onboarding}
API_ADMIN_STATUS_URL=${API_ADMIN_STATUS_URL:-https://api.averray.com/admin/status}
INDEXER_URL=${INDEXER_URL:-https://index.averray.com/}
INDEXER_READY_URL=${INDEXER_READY_URL:-https://index.averray.com/ready}
INDEXER_STATUS_URL=${INDEXER_STATUS_URL:-https://index.averray.com/status}
INDEXER_MAX_STALENESS_SEC=${INDEXER_MAX_STALENESS_SEC:-1800}
INDEXER_RETRY_ATTEMPTS=${INDEXER_RETRY_ATTEMPTS:-12}
INDEXER_RETRY_SLEEP_SEC=${INDEXER_RETRY_SLEEP_SEC:-5}
CHECK_INDEXER=${CHECK_INDEXER:-1}
CHECK_BOOTSTRAP_INSTRUMENTATION=${CHECK_BOOTSTRAP_INSTRUMENTATION:-0}
CHECK_BOOTSTRAP_SELF_REPORT_SENT=${CHECK_BOOTSTRAP_SELF_REPORT_SENT:-0}
CHECK_PRODUCT_PROOF_GATE=${CHECK_PRODUCT_PROOF_GATE:-0}
PRODUCT_PROOF_NODE_IMAGE=${PRODUCT_PROOF_NODE_IMAGE:-node:22-bookworm-slim}
PRODUCT_PROOF_EVIDENCE_FILE=${PRODUCT_PROOF_EVIDENCE_FILE:-}
PRODUCT_PROOF_REQUIRE_WORKER_LOOP=${PRODUCT_PROOF_REQUIRE_WORKER_LOOP:-0}
TIMEOUT_SEC=${TIMEOUT_SEC:-20}
APP_BASIC_AUTH_USER=${APP_BASIC_AUTH_USER:-}
APP_BASIC_AUTH_PASSWORD=${APP_BASIC_AUTH_PASSWORD:-}
APP_EXPECTED_MARKER=${APP_EXPECTED_MARKER:-Opening the operator control room.}
APP_ALLOW_PROTECTED_SHELL=${APP_ALLOW_PROTECTED_SHELL:-0}
APP_PROTECTED_STATUS_CODES=${APP_PROTECTED_STATUS_CODES:-401}
ADMIN_JWT=${ADMIN_JWT:-}
admin_status_json=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command curl
require_command jq

fetch() {
  local url="$1"
  local curl_args=(-fsS --max-time "$TIMEOUT_SEC")
  if [[ "$url" == "$APP_URL"* && -n "$APP_BASIC_AUTH_USER" && -n "$APP_BASIC_AUTH_PASSWORD" ]]; then
    curl_args+=(-u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD")
  fi
  curl "${curl_args[@]}" "$url"
}

fetch_admin_json() {
  local url="$1"
  curl -fsS --max-time "$TIMEOUT_SEC" \
    -H "accept: application/json" \
    -H "authorization: Bearer $ADMIN_JWT" \
    "$url"
}

fetch_admin_status_once() {
  if [[ -z "$admin_status_json" ]]; then
    admin_status_json="$(fetch_admin_json "$API_ADMIN_STATUS_URL")"
  fi
  printf '%s' "$admin_status_json"
}

fetch_indexer_with_retries() {
  local label="$1"
  local url="$2"
  local attempt=1
  local output=""

  while (( attempt <= INDEXER_RETRY_ATTEMPTS )); do
    if output="$(fetch "$url")"; then
      printf '%s' "$output"
      return 0
    fi
    if (( attempt == INDEXER_RETRY_ATTEMPTS )); then
      break
    fi
    echo "$label check failed on attempt $attempt/$INDEXER_RETRY_ATTEMPTS; retrying in ${INDEXER_RETRY_SLEEP_SEC}s." >&2
    sleep "$INDEXER_RETRY_SLEEP_SEC"
    attempt=$((attempt + 1))
  done

  echo "$label check failed after $INDEXER_RETRY_ATTEMPTS attempt(s)." >&2
  return 1
}

enabled() {
  case "${1:-}" in
    1|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}

if enabled "$CHECK_PRODUCT_PROOF_GATE" && ! command -v node >/dev/null 2>&1; then
  require_command docker
fi

status_allowed() {
  local status="$1"
  local allowed
  IFS=',' read -ra allowed <<<"$APP_PROTECTED_STATUS_CODES"
  for code in "${allowed[@]}"; do
    if [[ "$status" == "${code//[[:space:]]/}" ]]; then
      return 0
    fi
  done
  return 1
}

check_operator_app_shell() {
  if app_html="$(fetch "$APP_URL" 2>/dev/null)" && grep -Fq "$APP_EXPECTED_MARKER" <<<"$app_html"; then
    return 0
  fi

  # Fall through to the protected-status check when EITHER:
  #   (a) APP_ALLOW_PROTECTED_SHELL is explicitly enabled, OR
  #   (b) APP_BASIC_AUTH_PASSWORD is not present in this environment
  #       (Phase 2 PR 2.2 removed the raw from CI; without a password
  #       we cannot expect a successful auth-200 response, only a 401
  #       proving Caddy is up and serving the protected app).
  if ! enabled "$APP_ALLOW_PROTECTED_SHELL" && [[ -n "${APP_BASIC_AUTH_PASSWORD:-}" ]]; then
    echo "Operator app did not return the expected shell" >&2
    exit 1
  fi

  local curl_args=(-sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}")
  if [[ -n "$APP_BASIC_AUTH_USER" && -n "$APP_BASIC_AUTH_PASSWORD" ]]; then
    curl_args+=(-u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD")
  fi
  local status
  status="$(curl "${curl_args[@]}" "$APP_URL")"
  if status_allowed "$status"; then
    if [[ -z "${APP_BASIC_AUTH_PASSWORD:-}" ]]; then
      echo "Operator app returned protected status $status as expected (no auth in CI; auth-200 verification deferred to Phase 2 PR 2.5)."
    else
      echo "Operator app returned protected status $status as expected."
    fi
    return 0
  fi

  echo "Operator app did not return the expected shell or an allowed protected status (got HTTP $status)." >&2
  exit 1
}

echo "Checking public site"
public_html="$(fetch "$PUBLIC_SITE_URL")"
grep -q "<title>Averray" <<<"$public_html" || {
  echo "Public site did not return the expected HTML title" >&2
  exit 1
}

echo "Checking discovery manifest"
discovery_json="$(fetch "$DISCOVERY_URL")"
jq -e '.discoveryUrl == "https://averray.com/.well-known/agent-tools.json"' >/dev/null <<<"$discovery_json"
jq -e '.baseUrl == "https://api.averray.com"' >/dev/null <<<"$discovery_json"

echo "Checking operator app shell"
check_operator_app_shell

echo "Checking API health"
api_health_json="$(fetch "$API_HEALTH_URL")"
jq -e '.status == "ok"' >/dev/null <<<"$api_health_json"
jq -e '.components.stateStore.ok == true' >/dev/null <<<"$api_health_json"

echo "Checking onboarding contract"
onboarding_json="$(fetch "$API_ONBOARDING_URL")"
jq -e '.name | length > 0' >/dev/null <<<"$onboarding_json"
jq -e '.protocols | index("http") != null' >/dev/null <<<"$onboarding_json"

if enabled "$CHECK_INDEXER"; then
  echo "Checking indexer root"
  indexer_json="$(fetch_indexer_with_retries "Indexer root" "$INDEXER_URL")"
  jq -e '.status == "ok"' >/dev/null <<<"$indexer_json"

  echo "Checking indexer readiness"
  fetch_indexer_with_retries "Indexer readiness" "$INDEXER_READY_URL" >/dev/null

  echo "Checking indexer status freshness"
  indexer_status_json="$(fetch_indexer_with_retries "Indexer status" "$INDEXER_STATUS_URL")"
  jq -e 'type == "object" and (keys | length) > 0' >/dev/null <<<"$indexer_status_json"
  jq -e 'to_entries[0].value.block.number > 0' >/dev/null <<<"$indexer_status_json"
  jq -e --argjson maxAge "$INDEXER_MAX_STALENESS_SEC" '
    to_entries
    | map(.value.block.timestamp)
    | max as $latest
    | (now - $latest) <= $maxAge
  ' >/dev/null <<<"$indexer_status_json"
else
  echo "CHECK_INDEXER=$CHECK_INDEXER set; skipping indexer checks."
fi

if [[ -n "$ADMIN_JWT" ]]; then
  echo "Checking admin async XCM status"
  admin_status_json="$(fetch_admin_status_once)"
  jq -e '.maintenance.policy.enabled == true' >/dev/null <<<"$admin_status_json"
  jq -e '.xcmSettlementWatcher.enabled == true' >/dev/null <<<"$admin_status_json"
  jq -e '.xcmSettlementWatcher.pendingCount >= 0' >/dev/null <<<"$admin_status_json"
  jq -e '
    (.xcmObservationRelay | type) == "object" and
    (.xcmObservationRelay.enabled | type) == "boolean"
  ' >/dev/null <<<"$admin_status_json"
fi

if enabled "$CHECK_BOOTSTRAP_INSTRUMENTATION"; then
  if [[ -z "$ADMIN_JWT" ]]; then
    echo "CHECK_BOOTSTRAP_INSTRUMENTATION=1 requires ADMIN_JWT for /admin/status." >&2
    exit 1
  fi

  echo "Checking bootstrap instrumentation"
  admin_status_json="$(fetch_admin_status_once)"
  jq -e '
    .upstreamStatus.enabled == true and
    .upstreamStatus.running == true and
    (.upstreamStatus.intervalMs | type) == "number" and
    .upstreamStatus.intervalMs <= 86400000 and
    (.upstreamStatus.batchSize | type) == "number" and
    .upstreamStatus.batchSize > 0
  ' >/dev/null <<<"$admin_status_json"
  jq -e '
    .bootstrapSelfReport.enabled == true and
    .bootstrapSelfReport.running == true and
    .bootstrapSelfReport.providerConfigured == true and
    (.bootstrapSelfReport.recipientCount | type) == "number" and
    .bootstrapSelfReport.recipientCount > 0 and
    (.bootstrapSelfReport.intervalMs | type) == "number" and
    .bootstrapSelfReport.intervalMs <= 604800000
  ' >/dev/null <<<"$admin_status_json"

  if enabled "$CHECK_BOOTSTRAP_SELF_REPORT_SENT"; then
    jq -e '
      .bootstrapSelfReport.lastRun.status == "sent" and
      (.bootstrapSelfReport.lastRun.email.providerId | type) == "string" and
      (.bootstrapSelfReport.lastRun.email.providerId | length) > 0
    ' >/dev/null <<<"$admin_status_json"
  fi
fi

if enabled "$CHECK_PRODUCT_PROOF_GATE"; then
  echo "Checking product-proof gate"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if command -v node >/dev/null 2>&1; then
    PUBLIC_SITE_URL="$PUBLIC_SITE_URL" \
      PUBLIC_DISCOVERY_URL="$DISCOVERY_URL" \
      API_BASE_URL="${API_HEALTH_URL%/health}" \
      PRODUCT_PROOF_EVIDENCE_FILE="$PRODUCT_PROOF_EVIDENCE_FILE" \
      PRODUCT_PROOF_REQUIRE_WORKER_LOOP="$PRODUCT_PROOF_REQUIRE_WORKER_LOOP" \
      node "$script_dir/check-product-proof-gate.mjs"
  else
    docker run --rm \
      -v "$repo_root:/workspace" \
      -w /workspace \
      -e PUBLIC_SITE_URL="$PUBLIC_SITE_URL" \
      -e PUBLIC_DISCOVERY_URL="$DISCOVERY_URL" \
      -e API_BASE_URL="${API_HEALTH_URL%/health}" \
      -e PRODUCT_PROOF_EVIDENCE_FILE="$PRODUCT_PROOF_EVIDENCE_FILE" \
      -e PRODUCT_PROOF_REQUIRE_WORKER_LOOP="$PRODUCT_PROOF_REQUIRE_WORKER_LOOP" \
      "$PRODUCT_PROOF_NODE_IMAGE" \
      node scripts/ops/check-product-proof-gate.mjs
  fi
fi

echo "Hosted stack smoke check passed."
