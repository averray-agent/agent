#!/usr/bin/env bash

set -euo pipefail

PUBLIC_SITE_URL=${PUBLIC_SITE_URL:-https://averray.com/}
DISCOVERY_URL=${DISCOVERY_URL:-https://averray.com/.well-known/agent-tools.json}
APP_URL=${APP_URL:-https://app.averray.com/}
API_HEALTH_URL=${API_HEALTH_URL:-https://api.averray.com/health}
API_ONBOARDING_URL=${API_ONBOARDING_URL:-https://api.averray.com/onboarding}
INDEXER_URL=${INDEXER_URL:-https://index.averray.com/}
INDEXER_READY_URL=${INDEXER_READY_URL:-https://index.averray.com/ready}
INDEXER_STATUS_URL=${INDEXER_STATUS_URL:-https://index.averray.com/status}
INDEXER_MAX_STALENESS_SEC=${INDEXER_MAX_STALENESS_SEC:-1800}
TIMEOUT_SEC=${TIMEOUT_SEC:-20}
APP_BASIC_AUTH_USER=${APP_BASIC_AUTH_USER:-}
APP_BASIC_AUTH_PASSWORD=${APP_BASIC_AUTH_PASSWORD:-}

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
app_html="$(fetch "$APP_URL")"
grep -q 'id="auth-signin-button"' <<<"$app_html" || {
  echo "Operator app did not return the expected shell" >&2
  exit 1
}

echo "Checking API health"
api_health_json="$(fetch "$API_HEALTH_URL")"
jq -e '.status == "ok"' >/dev/null <<<"$api_health_json"
jq -e '.components.stateStore.ok == true' >/dev/null <<<"$api_health_json"

echo "Checking onboarding contract"
onboarding_json="$(fetch "$API_ONBOARDING_URL")"
jq -e '.name | length > 0' >/dev/null <<<"$onboarding_json"
jq -e '.protocols | index("http") != null' >/dev/null <<<"$onboarding_json"

echo "Checking indexer root"
indexer_json="$(fetch "$INDEXER_URL")"
jq -e '.status == "ok"' >/dev/null <<<"$indexer_json"

echo "Checking indexer readiness"
fetch "$INDEXER_READY_URL" >/dev/null

echo "Checking indexer status freshness"
indexer_status_json="$(fetch "$INDEXER_STATUS_URL")"
jq -e 'type == "object" and (keys | length) > 0' >/dev/null <<<"$indexer_status_json"
jq -e 'to_entries[0].value.block.number > 0' >/dev/null <<<"$indexer_status_json"
jq -e --argjson maxAge "$INDEXER_MAX_STALENESS_SEC" '
  to_entries
  | map(.value.block.timestamp)
  | max as $latest
  | (now - $latest) <= $maxAge
' >/dev/null <<<"$indexer_status_json"

echo "Hosted stack smoke check passed."
