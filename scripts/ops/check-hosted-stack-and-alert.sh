#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECK_SCRIPT="${SCRIPT_DIR}/check-hosted-stack.sh"

ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-}
ALERT_SERVICE_NAME=${ALERT_SERVICE_NAME:-averray-hosted-stack}
ALERT_ENVIRONMENT=${ALERT_ENVIRONMENT:-production-like}
TIMEOUT_SEC=${TIMEOUT_SEC:-20}

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

require_command curl
require_command jq

payload=$(
  jq -n \
    --arg service "$ALERT_SERVICE_NAME" \
    --arg environment "$ALERT_ENVIRONMENT" \
    --arg hostname "$(hostname)" \
    --arg check "scripts/ops/check-hosted-stack.sh" \
    --arg output "$output" \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{
      status: "firing",
      service: $service,
      environment: $environment,
      hostname: $hostname,
      check: $check,
      timestamp: $timestamp,
      summary: "Hosted stack smoke check failed",
      output: $output
    }'
)

curl -fsS --max-time "$TIMEOUT_SEC" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$ALERT_WEBHOOK_URL" >/dev/null

echo "Alert sent to configured webhook." >&2
exit 1
