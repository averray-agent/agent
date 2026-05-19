#!/usr/bin/env bash

set -euo pipefail

PUBLIC_SITE_URL=${PUBLIC_SITE_URL:-https://averray.com/}
DISCOVERY_URL=${DISCOVERY_URL:-https://averray.com/.well-known/agent-tools.json}
APP_URL=${APP_URL:-https://app.averray.com/}
API_HEALTH_URL=${API_HEALTH_URL:-https://api.averray.com/health}
API_ONBOARDING_URL=${API_ONBOARDING_URL:-https://api.averray.com/onboarding}
API_ADMIN_STATUS_URL=${API_ADMIN_STATUS_URL:-https://api.averray.com/admin/status}
API_METRICS_URL=${API_METRICS_URL:-https://api.averray.com/metrics}
INDEXER_URL=${INDEXER_URL:-https://index.averray.com/}
INDEXER_READY_URL=${INDEXER_READY_URL:-https://index.averray.com/ready}
INDEXER_STATUS_URL=${INDEXER_STATUS_URL:-https://index.averray.com/status}
INDEXER_MAX_STALENESS_SEC=${INDEXER_MAX_STALENESS_SEC:-1800}
INDEXER_RETRY_ATTEMPTS=${INDEXER_RETRY_ATTEMPTS:-12}
INDEXER_RETRY_SLEEP_SEC=${INDEXER_RETRY_SLEEP_SEC:-5}
CHECK_INDEXER=${CHECK_INDEXER:-1}
CHECK_BOOTSTRAP_INSTRUMENTATION=${CHECK_BOOTSTRAP_INSTRUMENTATION:-0}
CHECK_BOOTSTRAP_SELF_REPORT_SENT=${CHECK_BOOTSTRAP_SELF_REPORT_SENT:-0}
BOOTSTRAP_SELF_REPORT_EXPECTED_FROM=${BOOTSTRAP_SELF_REPORT_EXPECTED_FROM:-}
BOOTSTRAP_SELF_REPORT_EXPECTED_TO=${BOOTSTRAP_SELF_REPORT_EXPECTED_TO:-}
BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC=${BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC:-691200}
CHECK_PRODUCT_PROOF_GATE=${CHECK_PRODUCT_PROOF_GATE:-0}
PRODUCT_PROOF_NODE_IMAGE=${PRODUCT_PROOF_NODE_IMAGE:-node:22-bookworm-slim}
PRODUCT_PROOF_EVIDENCE_FILE=${PRODUCT_PROOF_EVIDENCE_FILE:-}
PRODUCT_PROOF_REQUIRE_WORKER_LOOP=${PRODUCT_PROOF_REQUIRE_WORKER_LOOP:-0}
CHECK_SERVICE_TOKEN_PROOF=${CHECK_SERVICE_TOKEN_PROOF:-0}
SERVICE_TOKEN_PROOF_NODE_IMAGE=${SERVICE_TOKEN_PROOF_NODE_IMAGE:-node:22-bookworm-slim}
SERVICE_TOKEN_PROOF_EVIDENCE_FILE=${SERVICE_TOKEN_PROOF_EVIDENCE_FILE:-}
SERVICE_TOKEN_PROOF_SUBJECT=${SERVICE_TOKEN_PROOF_SUBJECT:-}
SERVICE_TOKEN_PROOF_CAPABILITIES=${SERVICE_TOKEN_PROOF_CAPABILITIES:-}
SERVICE_TOKEN_PROOF_SCOPE=${SERVICE_TOKEN_PROOF_SCOPE:-}
SERVICE_TOKEN_PROOF_ALLOWED_PATH=${SERVICE_TOKEN_PROOF_ALLOWED_PATH:-}
SERVICE_TOKEN_PROOF_DENIED_PATHS=${SERVICE_TOKEN_PROOF_DENIED_PATHS:-}
SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS=${SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS:-}
SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY=${SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY:-}
CHECK_METRICS_AUTH=${CHECK_METRICS_AUTH:-0}
METRICS_BEARER_TOKEN=${METRICS_BEARER_TOKEN:-}
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

if { enabled "$CHECK_PRODUCT_PROOF_GATE" || enabled "$CHECK_SERVICE_TOKEN_PROOF"; } && ! command -v node >/dev/null 2>&1; then
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

if enabled "$CHECK_METRICS_AUTH"; then
  if [[ -z "$METRICS_BEARER_TOKEN" ]]; then
    echo "CHECK_METRICS_AUTH=1 requires METRICS_BEARER_TOKEN." >&2
    exit 1
  fi

  echo "Checking metrics bearer gate"
  metrics_status_without_bearer="$(curl -sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}" "$API_METRICS_URL")"
  if [[ "$metrics_status_without_bearer" != "401" ]]; then
    echo "Expected unauthenticated /metrics to return 401, got HTTP $metrics_status_without_bearer." >&2
    exit 1
  fi

  metrics_status_with_bearer="$(curl -sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}" \
    -H "authorization: Bearer $METRICS_BEARER_TOKEN" \
    "$API_METRICS_URL")"
  if [[ "$metrics_status_with_bearer" != "200" ]]; then
    echo "Expected bearer-authenticated /metrics to return 200, got HTTP $metrics_status_with_bearer." >&2
    exit 1
  fi
fi

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
    (.bootstrapSelfReport | type) == "object" and
    (.bootstrapSelfReport.enabled | type) == "boolean" and
    (.bootstrapSelfReport.running | type) == "boolean" and
    (.bootstrapSelfReport.providerConfigured | type) == "boolean" and
    (.bootstrapSelfReport.recipientCount | type) == "number" and
    (.bootstrapSelfReport.to | type) == "array" and
    all(.bootstrapSelfReport.to[]; type == "string" and length > 0) and
    (
      .bootstrapSelfReport.enabled == false or
      (
        .bootstrapSelfReport.running == true and
        (.bootstrapSelfReport.intervalMs | type) == "number" and
        .bootstrapSelfReport.intervalMs <= 604800000
      )
    ) and
    (
      .bootstrapSelfReport.providerConfigured == false or
      (
        (.bootstrapSelfReport.from | type) == "string" and
        (.bootstrapSelfReport.from | length) > 0 and
        .bootstrapSelfReport.recipientCount > 0 and
        .bootstrapSelfReport.recipientCount == (.bootstrapSelfReport.to | length)
      )
    )
  ' >/dev/null <<<"$admin_status_json"
  jq -e '
    (.bootstrapSelfReport | tostring | test("Bearer\\s+[^\\s,}\\]]+|re_[A-Za-z0-9_-]{12,}"; "i") | not)
  ' >/dev/null <<<"$admin_status_json" || {
    echo "Bootstrap self-report status appears to contain a provider/API key token." >&2
    exit 1
  }
  if [[ -n "$BOOTSTRAP_SELF_REPORT_EXPECTED_FROM" ]]; then
    jq -e --arg expectedFrom "$BOOTSTRAP_SELF_REPORT_EXPECTED_FROM" '
      .bootstrapSelfReport.from == $expectedFrom
    ' >/dev/null <<<"$admin_status_json"
  fi
  if [[ -n "$BOOTSTRAP_SELF_REPORT_EXPECTED_TO" ]]; then
    jq -e --arg expectedTo "$BOOTSTRAP_SELF_REPORT_EXPECTED_TO" '
      ($expectedTo | split(",") | map(gsub("^\\s+|\\s+$"; "") | select(length > 0))) as $recipients |
      .bootstrapSelfReport.to == $recipients
    ' >/dev/null <<<"$admin_status_json"
  fi

  if enabled "$CHECK_BOOTSTRAP_SELF_REPORT_SENT"; then
    jq -e '
      (.bootstrapSelfReport.lastAttemptedAt | type) == "string" and
      (.bootstrapSelfReport.lastAttemptedAt | test("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$")) and
      (.bootstrapSelfReport.lastSuccessfulAt | type) == "string" and
      (.bootstrapSelfReport.lastSuccessfulAt | test("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$")) and
      .bootstrapSelfReport.lastRun.status == "sent" and
      (.bootstrapSelfReport.lastRun.email.providerId | type) == "string" and
      (.bootstrapSelfReport.lastRun.email.providerId | length) > 0
    ' >/dev/null <<<"$admin_status_json"
    jq -e --argjson maxAge "$BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC" '
      .bootstrapSelfReport.lastSuccessfulAt
      | sub("\\.[0-9]+Z$"; "Z")
      | fromdateiso8601 as $lastSuccessful
      | (now - $lastSuccessful) >= 0 and (now - $lastSuccessful) <= $maxAge
    ' >/dev/null <<<"$admin_status_json"
  fi
fi

if enabled "$CHECK_PRODUCT_PROOF_GATE"; then
  echo "Checking product-proof gate"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if [[ -n "$PRODUCT_PROOF_EVIDENCE_FILE" ]]; then
    if [[ "$PRODUCT_PROOF_EVIDENCE_FILE" != /* ]]; then
      PRODUCT_PROOF_EVIDENCE_FILE="$repo_root/$PRODUCT_PROOF_EVIDENCE_FILE"
    fi
    product_proof_evidence_dir="$(dirname "$PRODUCT_PROOF_EVIDENCE_FILE")"
    mkdir -p "$product_proof_evidence_dir"
  fi
  if command -v node >/dev/null 2>&1; then
    PUBLIC_SITE_URL="$PUBLIC_SITE_URL" \
      PUBLIC_DISCOVERY_URL="$DISCOVERY_URL" \
      API_BASE_URL="${API_HEALTH_URL%/health}" \
      PRODUCT_PROOF_EVIDENCE_FILE="$PRODUCT_PROOF_EVIDENCE_FILE" \
      PRODUCT_PROOF_REQUIRE_WORKER_LOOP="$PRODUCT_PROOF_REQUIRE_WORKER_LOOP" \
      node "$script_dir/check-product-proof-gate.mjs"
  else
    product_proof_docker_volume_args=(-v "$repo_root:/workspace")
    if [[ -n "${product_proof_evidence_dir:-}" ]]; then
      product_proof_docker_volume_args+=(-v "$product_proof_evidence_dir:$product_proof_evidence_dir")
    fi
    docker run --rm \
      "${product_proof_docker_volume_args[@]}" \
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

if enabled "$CHECK_SERVICE_TOKEN_PROOF"; then
  if [[ -z "$ADMIN_JWT" ]]; then
    echo "CHECK_SERVICE_TOKEN_PROOF=1 requires ADMIN_JWT." >&2
    exit 1
  fi

  echo "Checking scoped service-token proof"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if [[ -n "$SERVICE_TOKEN_PROOF_EVIDENCE_FILE" ]]; then
    if [[ "$SERVICE_TOKEN_PROOF_EVIDENCE_FILE" != /* ]]; then
      SERVICE_TOKEN_PROOF_EVIDENCE_FILE="$repo_root/$SERVICE_TOKEN_PROOF_EVIDENCE_FILE"
    fi
    service_token_proof_evidence_dir="$(dirname "$SERVICE_TOKEN_PROOF_EVIDENCE_FILE")"
    mkdir -p "$service_token_proof_evidence_dir"
  fi
  if command -v node >/dev/null 2>&1; then
    API_BASE_URL="${API_HEALTH_URL%/health}" \
      ADMIN_JWT="$ADMIN_JWT" \
      SERVICE_TOKEN_PROOF_EVIDENCE_FILE="$SERVICE_TOKEN_PROOF_EVIDENCE_FILE" \
      SERVICE_TOKEN_PROOF_SUBJECT="$SERVICE_TOKEN_PROOF_SUBJECT" \
      SERVICE_TOKEN_PROOF_CAPABILITIES="$SERVICE_TOKEN_PROOF_CAPABILITIES" \
      SERVICE_TOKEN_PROOF_SCOPE="$SERVICE_TOKEN_PROOF_SCOPE" \
      SERVICE_TOKEN_PROOF_ALLOWED_PATH="$SERVICE_TOKEN_PROOF_ALLOWED_PATH" \
      SERVICE_TOKEN_PROOF_DENIED_PATHS="$SERVICE_TOKEN_PROOF_DENIED_PATHS" \
      SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS="$SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS" \
      SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY="$SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY" \
      node "$script_dir/check-service-token-proof.mjs"
  else
    service_token_proof_docker_volume_args=(-v "$repo_root:/workspace")
    if [[ -n "${service_token_proof_evidence_dir:-}" ]]; then
      service_token_proof_docker_volume_args+=(-v "$service_token_proof_evidence_dir:$service_token_proof_evidence_dir")
    fi
    docker run --rm \
      "${service_token_proof_docker_volume_args[@]}" \
      -w /workspace \
      -e API_BASE_URL="${API_HEALTH_URL%/health}" \
      -e ADMIN_JWT="$ADMIN_JWT" \
      -e SERVICE_TOKEN_PROOF_EVIDENCE_FILE="$SERVICE_TOKEN_PROOF_EVIDENCE_FILE" \
      -e SERVICE_TOKEN_PROOF_SUBJECT="$SERVICE_TOKEN_PROOF_SUBJECT" \
      -e SERVICE_TOKEN_PROOF_CAPABILITIES="$SERVICE_TOKEN_PROOF_CAPABILITIES" \
      -e SERVICE_TOKEN_PROOF_SCOPE="$SERVICE_TOKEN_PROOF_SCOPE" \
      -e SERVICE_TOKEN_PROOF_ALLOWED_PATH="$SERVICE_TOKEN_PROOF_ALLOWED_PATH" \
      -e SERVICE_TOKEN_PROOF_DENIED_PATHS="$SERVICE_TOKEN_PROOF_DENIED_PATHS" \
      -e SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS="$SERVICE_TOKEN_PROOF_TOKEN_TTL_SECONDS" \
      -e SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY="$SERVICE_TOKEN_PROOF_IDEMPOTENCY_KEY" \
      "$SERVICE_TOKEN_PROOF_NODE_IMAGE" \
      node scripts/ops/check-service-token-proof.mjs
  fi
fi

echo "Hosted stack smoke check passed."
