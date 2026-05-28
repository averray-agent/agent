#!/usr/bin/env bash

set -euo pipefail
set +x

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STACK_ROOT=${STACK_ROOT:-"$(cd "$SCRIPT_DIR/../.." && pwd)"}
CHECK_HOSTED_STACK_SCRIPT=${CHECK_HOSTED_STACK_SCRIPT:-"$SCRIPT_DIR/check-hosted-stack.sh"}
ALERT_WRAPPER_SCRIPT=${ALERT_WRAPPER_SCRIPT:-"$SCRIPT_DIR/check-hosted-stack-and-alert.sh"}
BACKEND_ENV_FILE=${BACKEND_ENV_FILE:-/run/agent-stack/backend.env}
API_BASE_URL=${API_BASE_URL:-https://api.averray.com}
API_METRICS_URL=${API_METRICS_URL:-"$API_BASE_URL/metrics"}
OPERATOR_NAME=${OPERATOR_NAME:-GitHub Actions}
OPERATOR_SIGNATURE=${OPERATOR_SIGNATURE:-hosted-observability-proof}
ALERT_CHANNEL=${ALERT_CHANNEL:-ops-alerts}
ALERT_CORRELATION_ID=${ALERT_CORRELATION_ID:-"observability-proof-$(date -u +"%Y%m%dT%H%M%SZ")"}
ALERT_SERVICE_NAME=${ALERT_SERVICE_NAME:-averray-hosted-stack}
ALERT_ENVIRONMENT=${ALERT_ENVIRONMENT:-production}
BACKEND_CONTAINER=${BACKEND_CONTAINER:-agent-backend}
DOCKER_BIN=${DOCKER_BIN:-docker}
CURL_BIN=${CURL_BIN:-curl}
JQ_BIN=${JQ_BIN:-jq}
TIMEOUT_SEC=${TIMEOUT_SEC:-20}
SENTRY_PROJECT=${SENTRY_PROJECT:-averray-backend-prod}
SENTRY_DEFERRED_REASON=${SENTRY_DEFERRED_REASON:-Backend Sentry intentionally deferred for v1; structured logs are the active launch surface.}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

sanitize_output() {
  sed -E \
    -e 's/(Bearer )[A-Za-z0-9._~+\/=-]+/\1[redacted]/g' \
    -e 's/re_[A-Za-z0-9_-]{12,}/re_[redacted]/g' \
    -e 's#https://[^@[:space:]]+@sentry#https://[redacted]@sentry#g'
}

read_env_value() {
  local name=$1
  local file=$2
  local line value

  line="$(grep -E "^${name}=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi

  value="${line#*=}"
  value="${value%$'\r'}"

  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  printf '%s' "$value"
}

load_backend_env_value() {
  local name=$1
  local value

  if [[ -n "${!name:-}" || ! -r "$BACKEND_ENV_FILE" ]]; then
    return 0
  fi

  if value="$(read_env_value "$name" "$BACKEND_ENV_FILE")"; then
    printf -v "$name" '%s' "$value"
    export "$name"
  fi
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

require_command "$CURL_BIN"
require_command "$JQ_BIN"
require_command mktemp

if [[ -r "$BACKEND_ENV_FILE" ]]; then
  load_backend_env_value METRICS_BEARER_TOKEN
  load_backend_env_value ALERT_WEBHOOK_URL
  load_backend_env_value SENTRY_DSN
elif [[ -z "${METRICS_BEARER_TOKEN:-}" || -z "${ALERT_WEBHOOK_URL:-}" ]]; then
  echo "Backend env file is not readable and required observability secrets were not supplied: $BACKEND_ENV_FILE" >&2
  exit 1
fi

if [[ -z "${METRICS_BEARER_TOKEN:-}" ]]; then
  echo "METRICS_BEARER_TOKEN is missing; hosted /metrics is expected to fail closed until configured." >&2
  exit 1
fi

if [[ -z "${ALERT_WEBHOOK_URL:-}" ]]; then
  echo "ALERT_WEBHOOK_URL is missing; cannot prove hosted smoke alert delivery." >&2
  exit 1
fi

metrics_observed_at="$(iso_now)"
if ! hosted_output="$(
  cd "$STACK_ROOT"
  APP_ALLOW_PROTECTED_SHELL=1 \
    CHECK_INDEXER=0 \
    CHECK_METRICS_AUTH=1 \
    METRICS_BEARER_TOKEN="$METRICS_BEARER_TOKEN" \
    "$CHECK_HOSTED_STACK_SCRIPT" 2>&1
)"; then
  printf '%s\n' "$hosted_output" | sanitize_output >&2
  exit 1
fi

metrics_status_without_bearer="$(
  "$CURL_BIN" -sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}" "$API_METRICS_URL"
)"
metrics_status_with_bearer="$(
  "$CURL_BIN" -sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}" \
    -H "authorization: Bearer $METRICS_BEARER_TOKEN" \
    "$API_METRICS_URL"
)"

alert_stub="$(mktemp)"
cat > "$alert_stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "deliberate observability proof failure"
exit 97
STUB
chmod +x "$alert_stub"

alert_received_at="$(iso_now)"
set +e
alert_output="$(
  CHECK_HOSTED_STACK_SCRIPT="$alert_stub" \
    ALERT_WEBHOOK_URL="$ALERT_WEBHOOK_URL" \
    ALERT_SERVICE_NAME="$ALERT_SERVICE_NAME" \
    ALERT_ENVIRONMENT="$ALERT_ENVIRONMENT" \
    ALERT_CORRELATION_ID="$ALERT_CORRELATION_ID" \
    TIMEOUT_SEC="$TIMEOUT_SEC" \
    "$ALERT_WRAPPER_SCRIPT" 2>&1
)"
alert_code=$?
set -e
rm -f "$alert_stub"

if [[ "$alert_code" -eq 0 ]]; then
  echo "Deliberate hosted smoke failure unexpectedly exited 0; alert proof is invalid." >&2
  exit 1
fi
if ! grep -Fq "Alert sent to configured webhook." <<<"$alert_output"; then
  printf '%s\n' "$alert_output" | sanitize_output >&2
  echo "Alert wrapper did not confirm webhook delivery." >&2
  exit 1
fi

require_command "$DOCKER_BIN"

logging_observed_at="$(iso_now)"
raw_logs="$("$DOCKER_BIN" logs "$BACKEND_CONTAINER" --tail 200 2>&1 || true)"
structured_log_line="$(
  printf '%s\n' "$raw_logs" \
    | grep -E '\{.*"level":[0-9]+.*"msg":' \
    | tail -1 \
    | sanitize_output \
    | cut -c 1-1000 || true
)"

if [[ -z "$structured_log_line" ]]; then
  echo "No structured backend log line found in $DOCKER_BIN logs $BACKEND_CONTAINER --tail 200." >&2
  exit 1
fi

sentry_ready_observed=false
sentry_decision=log_only_deferred
if [[ -n "${SENTRY_DSN:-}" ]]; then
  sentry_decision=sentry_enabled
  if grep -Fq "observability.sentry_ready" <<<"$raw_logs"; then
    sentry_ready_observed=true
    structured_log_line="$(
      printf '%s\n' "$raw_logs" \
        | grep -F "observability.sentry_ready" \
        | tail -1 \
        | sanitize_output \
        | cut -c 1-1000
    )"
  else
    echo "SENTRY_DSN is configured, but observability.sentry_ready was not observed in recent backend logs." >&2
    exit 1
  fi
fi

completed_at="$(iso_now)"
proof_date="${completed_at:0:10}"

"$JQ_BIN" -n \
  --arg schemaVersion "observability-proof-v1" \
  --arg proofDate "$proof_date" \
  --arg completedAt "$completed_at" \
  --arg operatorName "$OPERATOR_NAME" \
  --arg operatorSignature "$OPERATOR_SIGNATURE" \
  --arg apiBaseUrl "$API_BASE_URL" \
  --arg metricsCommand 'METRICS_BEARER_TOKEN=$METRICS_BEARER_TOKEN CHECK_METRICS_AUTH=1 ./scripts/ops/check-hosted-stack.sh' \
  --argjson unauthenticatedStatus "$metrics_status_without_bearer" \
  --argjson authenticatedStatus "$metrics_status_with_bearer" \
  --arg metricsObservedAt "$metrics_observed_at" \
  --arg alertChannel "$ALERT_CHANNEL" \
  --arg alertMessageId "$ALERT_CORRELATION_ID" \
  --arg alertReceivedAt "$alert_received_at" \
  --arg alertFailureMode "Deliberate hosted smoke failure via local stub; alert payload included correlationId $ALERT_CORRELATION_ID." \
  --arg sentryDecision "$sentry_decision" \
  --arg logSurface "$DOCKER_BIN logs $BACKEND_CONTAINER --tail 200" \
  --arg observedLogLine "$structured_log_line" \
  --arg loggingObservedAt "$logging_observed_at" \
  --argjson sentryReadyObserved "$sentry_ready_observed" \
  --arg sentryProject "$SENTRY_PROJECT" \
  --arg deferredReason "$SENTRY_DEFERRED_REASON" \
  '{
    schemaVersion: $schemaVersion,
    proofDate: $proofDate,
    completedAt: $completedAt,
    operator: {
      name: $operatorName,
      signature: $operatorSignature
    },
    target: {
      environment: "production",
      apiBaseUrl: $apiBaseUrl
    },
    metricsAuth: {
      checkHostedStackRan: true,
      command: $metricsCommand,
      unauthenticatedStatus: $unauthenticatedStatus,
      authenticatedStatus: $authenticatedStatus,
      observedAt: $metricsObservedAt
    },
    alertDestination: {
      webhookConfigured: true,
      deliberateFailureDelivered: true,
      channel: $alertChannel,
      messageId: $alertMessageId,
      receivedAt: $alertReceivedAt,
      failureMode: $alertFailureMode
    },
    sentryLogging: (
      {
        decision: $sentryDecision,
        structuredLogsVisible: true,
        logSurface: $logSurface,
        observedLogLine: $observedLogLine,
        observedAt: $loggingObservedAt,
        sentryReadyObserved: $sentryReadyObserved
      } + (
        if $sentryDecision == "sentry_enabled" then {sentryProject: $sentryProject}
        else {deferredReason: $deferredReason}
        end
      )
    )
  }'
