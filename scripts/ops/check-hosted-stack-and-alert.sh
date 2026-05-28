#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK_SCRIPT=${CHECK_HOSTED_STACK_SCRIPT:-"${SCRIPT_DIR}/check-hosted-stack.sh"}

ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-}
ALERT_SERVICE_NAME=${ALERT_SERVICE_NAME:-averray-hosted-stack}
ALERT_ENVIRONMENT=${ALERT_ENVIRONMENT:-production-like}
ALERT_CORRELATION_ID=${ALERT_CORRELATION_ID:-}
TIMEOUT_SEC=${TIMEOUT_SEC:-20}
CURL_BIN=${CURL_BIN:-curl}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command bash

output=""
if output="$("$CHECK_SCRIPT" 2>&1)"; then
  printf '%s\n' "$output"
  exit 0
fi

printf '%s\n' "$output" >&2

if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
  echo "Hosted stack smoke check failed and ALERT_WEBHOOK_URL is not set." >&2
  exit 1
fi

require_command "$CURL_BIN"
require_command jq

alert_text="$ALERT_SERVICE_NAME smoke check failed in $ALERT_ENVIRONMENT"
if [[ -n "$ALERT_CORRELATION_ID" ]]; then
  alert_text="$alert_text (correlation: $ALERT_CORRELATION_ID)"
fi

payload=$(
  jq -n \
    --arg service "$ALERT_SERVICE_NAME" \
    --arg environment "$ALERT_ENVIRONMENT" \
    --arg correlationId "$ALERT_CORRELATION_ID" \
    --arg text "$alert_text" \
    --arg hostname "$(hostname)" \
    --arg check "scripts/ops/check-hosted-stack.sh" \
    --arg output "$output" \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{
      status: "firing",
      text: $text,
      content: $text,
      service: $service,
      environment: $environment,
      hostname: $hostname,
      check: $check,
      timestamp: $timestamp,
      summary: "Hosted stack smoke check failed",
      output: $output
    } + (
      if $correlationId == "" then {}
      else {correlationId: $correlationId}
      end
    )'
)

"$CURL_BIN" -fsS --max-time "$TIMEOUT_SEC" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$ALERT_WEBHOOK_URL" >/dev/null

echo "Alert sent to configured webhook." >&2
exit 1
