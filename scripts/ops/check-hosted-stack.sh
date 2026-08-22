#!/usr/bin/env bash

set -euo pipefail

PUBLIC_SITE_URL=${PUBLIC_SITE_URL:-https://averray.com/}
PUBLIC_AGENT_PROFILE_URL=${PUBLIC_AGENT_PROFILE_URL:-https://averray.com/agents/0x97450bf69cb4aeb0b33db3ae51ac2d18224d4b5c}
PUBLIC_VERSIONED_ASSET_URL=${PUBLIC_VERSIONED_ASSET_URL:-https://averray.com/reader-fetch.js?v=20260823}
PUBLIC_RECEIPT_JUNK_URL=${PUBLIC_RECEIPT_JUNK_URL:-https://averray.com/receipts/junk}
PUBLIC_ONBOARDING_REDIRECT_URL=${PUBLIC_ONBOARDING_REDIRECT_URL:-https://averray.com/onboarding}
PUBLIC_HEALTH_REDIRECT_URL=${PUBLIC_HEALTH_REDIRECT_URL:-https://averray.com/health}
PUBLIC_JOB_TIERS_REDIRECT_URL=${PUBLIC_JOB_TIERS_REDIRECT_URL:-https://averray.com/jobs/tiers}
PUBLIC_VERIFY_PROFILES_REDIRECT_URL=${PUBLIC_VERIFY_PROFILES_REDIRECT_URL:-https://averray.com/verify/profiles}
APP_TRANSPARENCY_REDIRECT_URL=${APP_TRANSPARENCY_REDIRECT_URL:-https://app.averray.com/transparency}
APP_TRANSPARENCY_SLASH_REDIRECT_URL=${APP_TRANSPARENCY_SLASH_REDIRECT_URL:-https://app.averray.com/transparency/}
APP_RECEIPT_REDIRECT_URL=${APP_RECEIPT_REDIRECT_URL:-https://app.averray.com/receipts/example-receipt}
APP_JOBS_REDIRECT_URL=${APP_JOBS_REDIRECT_URL:-https://app.averray.com/jobs}
APP_JOB_SUBPATH_REDIRECT_URL=${APP_JOB_SUBPATH_REDIRECT_URL:-https://app.averray.com/jobs/example-job}
PUBLIC_WORK_REDIRECT_URL=${PUBLIC_WORK_REDIRECT_URL:-https://averray.com/work}
PUBLIC_WORK_SUBPATH_REDIRECT_URL=${PUBLIC_WORK_SUBPATH_REDIRECT_URL:-https://averray.com/work/example-job}
PUBLIC_GET_STARTED_REDIRECT_URL=${PUBLIC_GET_STARTED_REDIRECT_URL:-https://averray.com/get-started}
DISCOVERY_URL=${DISCOVERY_URL:-https://averray.com/.well-known/agent-tools.json}
APP_URL=${APP_URL:-https://app.averray.com/}
APP_POST_REDIRECT_URL=${APP_POST_REDIRECT_URL:-https://app.averray.com/post}
APP_VERIFY_REDIRECT_URL=${APP_VERIFY_REDIRECT_URL:-https://app.averray.com/verify}
API_HEALTH_URL=${API_HEALTH_URL:-https://api.averray.com/health}
API_MCP_INFO_URL=${API_MCP_INFO_URL:-https://api.averray.com/mcp}
API_POOL_URL=${API_POOL_URL:-https://api.averray.com/pool}
API_ACCOUNT_POSITION_URL=${API_ACCOUNT_POSITION_URL:-https://api.averray.com/account/position?asset=USDC}
API_ACCOUNT_WITHDRAW_URL=${API_ACCOUNT_WITHDRAW_URL:-https://api.averray.com/account/withdraw/transactions}
API_STRATEGIES_URL=${API_STRATEGIES_URL:-https://api.averray.com/strategies}
API_CREDIT_URL=${API_CREDIT_URL:-https://api.averray.com/credit}
API_ONBOARDING_URL=${API_ONBOARDING_URL:-https://api.averray.com/onboarding}
API_POSTER_ONBOARDING_URL=${API_POSTER_ONBOARDING_URL:-https://api.averray.com/poster/onboarding}
API_JOBS_OPEN_REDIRECT_URL=${API_JOBS_OPEN_REDIRECT_URL:-https://api.averray.com/jobs/open}
API_ADMIN_STATUS_URL=${API_ADMIN_STATUS_URL:-https://api.averray.com/admin/status}
API_METRICS_URL=${API_METRICS_URL:-https://api.averray.com/metrics}
INDEXER_URL=${INDEXER_URL:-https://index.averray.com/}
INDEXER_READY_URL=${INDEXER_READY_URL:-https://index.averray.com/ready}
INDEXER_STATUS_URL=${INDEXER_STATUS_URL:-https://index.averray.com/status}
INDEXER_MAX_STALENESS_SEC=${INDEXER_MAX_STALENESS_SEC:-1800}
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
CHECK_EXTERNAL_SCHEMA_PROOF=${CHECK_EXTERNAL_SCHEMA_PROOF:-0}
EXTERNAL_SCHEMA_PROOF_NODE_IMAGE=${EXTERNAL_SCHEMA_PROOF_NODE_IMAGE:-node:22-bookworm-slim}
EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE=${EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE:-}
EXTERNAL_SCHEMA_PROOF_JOB_ID=${EXTERNAL_SCHEMA_PROOF_JOB_ID:-}
EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY=${EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY:-}
CHECK_DISPUTE_VERDICT_PROOF=${CHECK_DISPUTE_VERDICT_PROOF:-0}
DISPUTE_PROOF_NODE_IMAGE=${DISPUTE_PROOF_NODE_IMAGE:-node:22-bookworm-slim}
DISPUTE_PROOF_EVIDENCE_FILE=${DISPUTE_PROOF_EVIDENCE_FILE:-}
CHECK_SIWE_FRESH_WALLET_PROOF=${CHECK_SIWE_FRESH_WALLET_PROOF:-0}
SIWE_FRESH_WALLET_PROOF_NODE_IMAGE=${SIWE_FRESH_WALLET_PROOF_NODE_IMAGE:-node:22-bookworm-slim}
SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE=${SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE:-}
SIWE_FRESH_WALLET_PRIVATE_KEY=${SIWE_FRESH_WALLET_PRIVATE_KEY:-}
CHECK_WORKER_CANARY_PROOF=${CHECK_WORKER_CANARY_PROOF:-0}
WORKER_CANARY_NODE_IMAGE=${WORKER_CANARY_NODE_IMAGE:-node:22-bookworm-slim}
WORKER_CANARY_EVIDENCE_FILE=${WORKER_CANARY_EVIDENCE_FILE:-}
WORKER_CANARY_WORKER_PRIVATE_KEY=${WORKER_CANARY_WORKER_PRIVATE_KEY:-}
WORKER_CANARY_WORKER_KEY_OP=${WORKER_CANARY_WORKER_KEY_OP:-}
WORKER_CANARY_PROFILE=${WORKER_CANARY_PROFILE:-}
WORKER_CANARY_REWARD_AMOUNT=${WORKER_CANARY_REWARD_AMOUNT:-}
WORKER_CANARY_TOKEN_MIN_DAYS=${WORKER_CANARY_TOKEN_MIN_DAYS:-}
WORKER_CANARY_VERIFY_MODE=${WORKER_CANARY_VERIFY_MODE:-}
WORKER_CANARY_ALLOW_EPHEMERAL=${WORKER_CANARY_ALLOW_EPHEMERAL:-}
WORKER_CANARY_KEEP_JOB=${WORKER_CANARY_KEEP_JOB:-}
CHECK_METRICS_AUTH=${CHECK_METRICS_AUTH:-0}
METRICS_BEARER_TOKEN=${METRICS_BEARER_TOKEN:-}
TIMEOUT_SEC=${TIMEOUT_SEC:-20}
HOSTED_CURL_RETRY_BACKOFF_1_SEC=${HOSTED_CURL_RETRY_BACKOFF_1_SEC:-5}
HOSTED_CURL_RETRY_BACKOFF_2_SEC=${HOSTED_CURL_RETRY_BACKOFF_2_SEC:-15}
APP_BASIC_AUTH_USER=${APP_BASIC_AUTH_USER:-}
APP_BASIC_AUTH_PASSWORD=${APP_BASIC_AUTH_PASSWORD:-}
APP_EXPECTED_MARKER=${APP_EXPECTED_MARKER:-averray-operator}
APP_ALLOW_PROTECTED_SHELL=${APP_ALLOW_PROTECTED_SHELL:-0}
APP_PROTECTED_STATUS_CODES=${APP_PROTECTED_STATUS_CODES:-401}
ADMIN_JWT=${ADMIN_JWT:-}
AVERRAY_TOKEN=${AVERRAY_TOKEN:-}
OPERATOR_TOKEN=${AVERRAY_TOKEN:-$ADMIN_JWT}
CREDIT_DOOR_TOKEN=${CREDIT_DOOR_TOKEN:-$OPERATOR_TOKEN}
admin_status_json=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command curl
require_command jq

for retry_delay in "$HOSTED_CURL_RETRY_BACKOFF_1_SEC" "$HOSTED_CURL_RETRY_BACKOFF_2_SEC"; do
  if [[ ! "$retry_delay" =~ ^[0-9]+$ ]]; then
    echo "Hosted curl retry backoffs must be non-negative integer seconds." >&2
    exit 1
  fi
done

# Retry only failures that occurred before the response could be asserted:
# curl timeouts and upstream HTTP 5xx responses. JSON/status/content assertions
# remain outside this function and therefore fail immediately.
curl_with_transport_retries() {
  local attempt=1
  local max_attempts=3
  local stdout_file stderr_file headers_file status rc retry_reason delay

  while (( attempt <= max_attempts )); do
    stdout_file="$(mktemp)"
    stderr_file="$(mktemp)"
    headers_file="$(mktemp)"

    if command curl --dump-header "$headers_file" "$@" >"$stdout_file" 2>"$stderr_file"; then
      rc=0
    else
      rc=$?
    fi

    status="$(awk '/^HTTP\/[0-9.]+ [0-9][0-9][0-9]/{code=$2} END{print code}' "$headers_file")"
    retry_reason=""
    if [[ "$rc" -eq 28 ]]; then
      retry_reason="timeout"
    elif [[ "$status" =~ ^5[0-9][0-9]$ ]]; then
      retry_reason="HTTP $status"
    fi

    if [[ -z "$retry_reason" || "$attempt" -eq "$max_attempts" ]]; then
      cat "$stdout_file"
      cat "$stderr_file" >&2
      rm -f "$stdout_file" "$stderr_file" "$headers_file"
      return "$rc"
    fi

    if [[ "$attempt" -eq 1 ]]; then
      delay="$HOSTED_CURL_RETRY_BACKOFF_1_SEC"
    else
      delay="$HOSTED_CURL_RETRY_BACKOFF_2_SEC"
    fi
    echo "Hosted curl transport $retry_reason failed on attempt $attempt/$max_attempts; retrying in ${delay}s." >&2
    rm -f "$stdout_file" "$stderr_file" "$headers_file"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

fetch() {
  local url="$1"
  local curl_args=(-fsS --max-time "$TIMEOUT_SEC")
  if [[ "$url" == "$APP_URL"* && -n "$APP_BASIC_AUTH_USER" && -n "$APP_BASIC_AUTH_PASSWORD" ]]; then
    curl_args+=(-u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD")
  fi
  curl_with_transport_retries "${curl_args[@]}" "$url"
}

fetch_admin_json() {
  local url="$1"
  curl_with_transport_retries -fsS --max-time "$TIMEOUT_SEC" \
    -H "accept: application/json" \
    -H "authorization: Bearer $OPERATOR_TOKEN" \
    "$url"
}

fetch_admin_status_once() {
  if [[ -z "$admin_status_json" ]]; then
    admin_status_json="$(fetch_admin_json "$API_ADMIN_STATUS_URL")"
  fi
  printf '%s' "$admin_status_json"
}

assert_cache_control() {
  local url="$1"
  local expected="$2"
  local label="$3"
  local headers actual
  headers="$(curl_with_transport_retries -fsSI --max-time "$TIMEOUT_SEC" "$url")"
  actual="$(awk '
    tolower($1) == "cache-control:" {
      sub(/^[^:]+:[[:space:]]*/, "")
      value=$0
    }
    END { print value }
  ' <<<"$headers" | tr -d '\r')"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label returned Cache-Control '$actual'; expected '$expected'." >&2
    exit 1
  fi
}

assert_redirect() {
  local url="$1"
  local expected="$2"
  local label="$3"
  local result status target
  result="$(curl_with_transport_retries -sS --max-time "$TIMEOUT_SEC" \
    -o /dev/null -w $'%{http_code}\n%{redirect_url}' "$url")"
  status="${result%%$'\n'*}"
  target="${result#*$'\n'}"
  if [[ "$status" != "301" || "$target" != "$expected" ]]; then
    echo "$label returned HTTP $status to '$target'; expected HTTP 301 to '$expected'." >&2
    exit 1
  fi
}

enabled() {
  case "${1:-}" in
    1|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}

if { enabled "$CHECK_PRODUCT_PROOF_GATE" || enabled "$CHECK_SERVICE_TOKEN_PROOF" || enabled "$CHECK_EXTERNAL_SCHEMA_PROOF" || enabled "$CHECK_DISPUTE_VERDICT_PROOF" || enabled "$CHECK_SIWE_FRESH_WALLET_PROOF" || enabled "$CHECK_WORKER_CANARY_PROOF"; } && ! command -v node >/dev/null 2>&1; then
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
  status="$(curl_with_transport_retries "${curl_args[@]}" "$APP_URL")"
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

echo "Checking public-site cache and routing contract"
assert_cache_control "$PUBLIC_SITE_URL" "no-cache" "Public site HTML"
assert_cache_control "$PUBLIC_AGENT_PROFILE_URL" "no-cache" "Agent-profile HTML rewrite"
assert_cache_control "$PUBLIC_VERSIONED_ASSET_URL" "public, max-age=31536000, immutable" "Versioned public asset"
assert_redirect "$PUBLIC_ONBOARDING_REDIRECT_URL" "https://api.averray.com/onboarding" "Public onboarding path"
assert_redirect "$PUBLIC_HEALTH_REDIRECT_URL" "https://api.averray.com/health" "Public health path"
assert_redirect "$PUBLIC_JOB_TIERS_REDIRECT_URL" "https://api.averray.com/jobs/tiers" "Public tier-ladder path"
assert_redirect "$PUBLIC_VERIFY_PROFILES_REDIRECT_URL" "https://api.averray.com/verify/profiles" "Public verification-profile path"
assert_redirect "$APP_TRANSPARENCY_REDIRECT_URL" "https://averray.com/transparency/" "Operator-app transparency path"
assert_redirect "$APP_TRANSPARENCY_SLASH_REDIRECT_URL" "https://averray.com/transparency/" "Operator-app transparency slash path"
assert_redirect "$APP_RECEIPT_REDIRECT_URL" "https://averray.com/receipts/example-receipt" "Operator-app public receipt path"
assert_redirect "$APP_JOBS_REDIRECT_URL" "https://app.averray.com/work" "Operator-app legacy jobs path"
assert_redirect "$APP_JOB_SUBPATH_REDIRECT_URL" "https://app.averray.com/work" "Operator-app legacy job subpath"
assert_redirect "$PUBLIC_WORK_REDIRECT_URL" "https://app.averray.com/work" "Public-site work path"
assert_redirect "$PUBLIC_WORK_SUBPATH_REDIRECT_URL" "https://app.averray.com/work" "Public-site work subpath"
assert_redirect "$PUBLIC_GET_STARTED_REDIRECT_URL" "https://averray.com/agents/" "Public get-started path"
assert_redirect "$APP_POST_REDIRECT_URL" "https://app.averray.com/poster/" "App posting alias"
assert_redirect "$APP_VERIFY_REDIRECT_URL" "https://app.averray.com/runs/" "App verification alias"
assert_redirect "$API_JOBS_OPEN_REDIRECT_URL" "https://api.averray.com/jobs" "API open-jobs alias"

receipt_shell_html="$(fetch "$PUBLIC_RECEIPT_JUNK_URL")"
for receipt_shell_marker in \
  'data-receipt-state="loading"' \
  '0xe302d62bef7f96686bba5db4cfc44fc5743b5464706f2acbc0e6350929a62ce1' \
  '0x8a99c2e19b75a7e3b19e1aefb4448be162e89480d953c20ad813b8dda12797c0' \
  'href="/transparency/"'; do
  grep -Fq "$receipt_shell_marker" <<<"$receipt_shell_html" || {
    echo "Junk receipt path did not serve the honest receipt shell ($receipt_shell_marker missing)." >&2
    exit 1
  }
done

echo "Checking discovery manifest"
discovery_json="$(fetch "$DISCOVERY_URL")"
jq -e '.discoveryUrl == "https://averray.com/.well-known/agent-tools.json"' >/dev/null <<<"$discovery_json"
jq -e '.baseUrl == "https://api.averray.com"' >/dev/null <<<"$discovery_json"
jq -e '.publicEndpoints | any(.path == "/poster/onboarding")' >/dev/null <<<"$discovery_json"
jq -e '.onboarding.posterEntrypoint == "https://api.averray.com/poster/onboarding"' >/dev/null <<<"$discovery_json"
jq -e '
  ([.publicEndpoints[]?.path, .authenticatedEndpoints[]?.path] | index("/strategies") == null) and
  ([.publicEndpoints[]?.path, .authenticatedEndpoints[]?.path] | index("/account/strategies") == null) and
  ([.tools[]?.name] | index("getStrategyPositions") == null) and
  ([.tools[]?.name] | index("listStrategies") == null)
' >/dev/null <<<"$discovery_json" || {
  echo "Discovery still advertises a retired strategy surface." >&2
  exit 1
}

echo "Checking operator app shell"
check_operator_app_shell

echo "Checking API health"
api_health_json="$(fetch "$API_HEALTH_URL")"
jq -e '.status == "ok"' >/dev/null <<<"$api_health_json"
jq -e '.components.stateStore.ok == true' >/dev/null <<<"$api_health_json"
jq -e '.components.submittedJobAutoVerifier.ok == true' >/dev/null <<<"$api_health_json"

echo "Checking browser-friendly MCP endpoint"
mcp_info_json="$(fetch "$API_MCP_INFO_URL")"
jq -e '
  (.type == "mcp_protocol_endpoint") and
  (.description == "This is an MCP protocol endpoint, not a browser page.") and
  (.connect.url == "https://api.averray.com/mcp") and
  (.connect.clientConfig.mcpServers.averray.url == "https://api.averray.com/mcp") and
  (.plainHttpAlternative.method == "GET") and
  (.plainHttpAlternative.path == "/verify/profiles") and
  (.plainHttpAlternative.url == "https://api.averray.com/verify/profiles")
' >/dev/null <<<"$mcp_info_json" || {
  echo "GET /mcp did not return the browser-friendly MCP connection guide." >&2
  exit 1
}

echo "Checking DepositPool door"
pool_response="$(curl_with_transport_retries -sS --max-time "$TIMEOUT_SEC" --write-out $'\n%{http_code}' "$API_POOL_URL")"
pool_status="${pool_response##*$'\n'}"
pool_json="${pool_response%$'\n'*}"
if [[ "$pool_status" != "200" ]]; then
  echo "DepositPool door returned HTTP $pool_status; expected 200." >&2
  exit 1
fi
jq -e '.available == true' >/dev/null <<<"$pool_json" || {
  echo "DepositPool door did not report available: true." >&2
  exit 1
}
jq -e '.disclosure.statement == "Technical pilot. Principal at risk. No depositor protection."' >/dev/null <<<"$pool_json" || {
  echo "DepositPool door did not carry the exact depositor-risk disclosure." >&2
  exit 1
}
jq -e '[.. | objects | select(has("fromDeposits"))] | length == 0' >/dev/null <<<"$pool_json" || {
  echo "DepositPool door still exposes a deposit-derived daily allowance field." >&2
  exit 1
}
printf '%s\n%s\n' "$pool_json" "$api_health_json" | jq -e -s '
  .[0].chainId == .[1].auth.chainId
' >/dev/null

# CreditPool is deliberately absent until its later ceremony. Once the
# deployed address appears in /health, the same hosted gate as the DepositPool
# enforces both availability and the canonical risk sentence on every deploy.
if jq -e '.addresses.creditPool | strings | test("^0x[0-9a-fA-F]{40}$")' >/dev/null <<<"$api_health_json"; then
  if [[ -z "$CREDIT_DOOR_TOKEN" ]]; then
    echo "CreditPool is configured but hosted smoke has no operator token for its wallet-bound door." >&2
    exit 1
  fi
  echo "Checking CreditPool door"
  credit_json="$(curl_with_transport_retries -fsS --max-time "$TIMEOUT_SEC" \
    -H "accept: application/json" \
    -H "authorization: Bearer $CREDIT_DOOR_TOKEN" \
    "$API_CREDIT_URL")"
  jq -e '.available == true' >/dev/null <<<"$credit_json" || {
    echo "CreditPool door did not report available: true." >&2
    exit 1
  }
  jq -e '.disclosure.statement == "Technical pilot. Principal at risk. No depositor protection."' >/dev/null <<<"$credit_json" || {
    echo "CreditPool door did not carry the exact depositor-risk disclosure." >&2
    exit 1
  }
  printf '%s\n%s\n' "$credit_json" "$api_health_json" | jq -e -s '
    (.[0].chainId == .[1].auth.chainId) and
    ((.[0].creditPool | ascii_downcase) == (.[1].addresses.creditPool | ascii_downcase))
  ' >/dev/null
fi

echo "Checking onboarding contract"
onboarding_json="$(fetch "$API_ONBOARDING_URL")"
jq -e '.name | length > 0' >/dev/null <<<"$onboarding_json"
jq -e '.protocols | index("http") != null' >/dev/null <<<"$onboarding_json"
jq -e '
  (.tools | index("getStrategyPositions") == null) and
  (.tools | index("listStrategies") == null)
' >/dev/null <<<"$onboarding_json" || {
  echo "Onboarding still advertises a retired strategy tool." >&2
  exit 1
}
jq -e '
  (.tools | index("getAccountPosition") != null) and
  (.tools | index("buildWithdrawTransactions") != null) and
  (.onboarding.withdrawEarnings.statement | contains("one-time first-withdrawal DOT grant")) and
  (.onboarding.withdrawEarnings.retentionNotGates | contains("never delays, conditions, prices, or adds steps"))
' >/dev/null <<<"$onboarding_json" || {
  echo "Onboarding promises withdrawal without carrying the canonical earnings door and retention-not-gates contract." >&2
  exit 1
}

echo "Checking retired strategy surfaces point to the DepositPool"
strategies_json="$(fetch "$API_STRATEGIES_URL")"
jq -e '
  (.status == "retired") and (.retired == true) and
  (.strategies == []) and (.see.pool == "/pool") and
  (.see.onboarding == "/onboarding#buildVestedCapacity")
' >/dev/null <<<"$strategies_json"

echo "Checking earnings account door is mounted and wallet-scoped (auth-first)"
account_status="$(curl_with_transport_retries -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT_SEC" \
  -H "accept: application/json" "$API_ACCOUNT_POSITION_URL")"
if [[ "$account_status" != "401" ]]; then
  echo "Earnings account door did not answer 401 to an unauthenticated probe (got $account_status)." >&2
  echo "The door is wallet-scoped: it derives the account from the SIWE session, so an admin token has no wallet and must never be used here." >&2
  exit 1
fi
# Follow-up (tracked): a wallet-scoped SIWE smoke walking the fresh-wallet
# zero-account shape needs SIWE support in these fixtures. Until then the
# authed door is covered by unit + parity tests and the operator walkthrough.

echo "Checking poster onboarding live facts"
poster_onboarding_json="$(fetch "$API_POSTER_ONBOARDING_URL")"
jq -e '
  . as $poster |
  ([.flow[] | select(.id == "fund")][0]) as $fund |
  (.mode == "open") and
  (.economics.feeSemantics == "poster_additive") and
  (.economics.protocolFeeBps | type) == "number" and
  (.economics.posterFeeBps == .economics.protocolFeeBps) and
  (.economics.posterFeeFloorRaw | test("^[0-9]+$")) and
  ((.economics.feeRecipient | ascii_downcase) | test("^0x[0-9a-f]{40}$")) and
  (.economics.minRewardUsdc | tonumber) > 0 and
  (.economics.draftTtlHours | type) == "number" and
  (.economics.quotePersistence == "demand_signal_only_until_funded") and
  (.economics.quoteIdentity == "poster_and_content_hash") and
  ((if .cancellation.selfServeCancel == true then
      (.cancellation.method == "cancelOpenJob(bytes32)") and
      (.cancellation.onChain.abiFragment == "function cancelOpenJob(bytes32 jobId)") and
      ((.cancellation.onChain.address | ascii_downcase) == (.escrowCore | ascii_downcase)) and
      (.cancellation.onChain.args == ["<jobId>"]) and
      (.cancellation.onChain.value == "0") and
      (.cancellation.scope == "any Open job") and
      (.cancellation.minimumOpenSeconds == 3600)
    else
      (.cancellation.rescue == "operator-mediated on request, ~7 days, refunds only ever to the recorded poster") and
      (.cancellation.plannedSelfServeCancel == "cancelOpenJob, next EscrowCore deployment window")
    end)) and
  (.workerFacts.claimBond.available == true) and
  (.workerFacts.claimBond.stakeBps | type) == "number" and
  (.workerFacts.claimBond.feeBps | type) == "number" and
  (.workerFacts.claimBond.minFeeRaw | test("^[0-9]+$")) and
  (.workerFacts.gasPolicy.operatorBrokeredGas == false) and
  (.workerFacts.gasPolicy.appliesTo == "all externally posted jobs") and
  (.workerFacts.disputeWindow.available == true) and
  (.workerFacts.disputeWindow.seconds | type) == "number" and
  (.workerFacts.disputeWindow.remedy.onChain.available == true) and
  (.workerFacts.disputeWindow.remedy.onChain.abiFragment == "function openDispute(bytes32 jobId)") and
  ((.workerFacts.disputeWindow.remedy.onChain.address | ascii_downcase) == (.escrowCore | ascii_downcase)) and
  (.workerFacts.disputeWindow.remedy.brokeredPath.available == false) and
  (.workerFacts.disputeWindow.remedy.brokeredPath.reason == "no_worker_reachable_brokered_open_dispute_route") and
  ($fund.posterReservedRawFormula == "rewardRaw + opsReserveRaw + contingencyReserveRaw + max(floor(rewardRaw * economics.posterFeeBps / 10000), economics.posterFeeFloorRaw)") and
  ($fund.depositAmountFormula == "max(posterReservedRaw - positions(poster, token).liquid, 0)") and
  (($fund.positionRead.address | ascii_downcase) == ($poster.agentAccountCore | ascii_downcase)) and
  (any($fund.writes[];
    (.abiFragment == "function approve(address spender, uint256 amount) returns (bool)") and
    ((.address | ascii_downcase) == ($poster.token.address | ascii_downcase)) and
    ((.args[0] | ascii_downcase) == ($poster.agentAccountCore | ascii_downcase)))) and
  (any($fund.writes[];
    (.abiFragment == "function deposit(address asset, uint256 amount)") and
    ((.address | ascii_downcase) == ($poster.agentAccountCore | ascii_downcase)) and
    ((.args[0] | ascii_downcase) == ($poster.token.address | ascii_downcase))))
' >/dev/null <<<"$poster_onboarding_json"

# Live chain reads are RETRIED, then advisory.
#
# These four assert that a third-party RPC answered — not that anything of ours
# is correct. Every structural claim above stays hard-gated.
#
# On 2026-08-08 they failed two production deploys (17:24 and 18:45 UTC) on a
# day when an upstream RPC returned 521 for hours. Both times the code had
# already installed successfully and the same assertion passed when re-run
# minutes later. A deploy that goes red because someone else's node blinked
# teaches everyone to ignore red deploys, which costs more than this check is
# worth. Same reasoning as #657, which made the Hermes gate advisory.
LIVE_READ_ATTEMPTS="${LIVE_READ_ATTEMPTS:-3}"
LIVE_READ_RETRY_SLEEP_SEC="${LIVE_READ_RETRY_SLEEP_SEC:-5}"

live_reads_available() {
  jq -e '
    (.liveReads.protocolFeeBps.status == "available") and
    (.liveReads.feeRecipient.status == "available") and
    (.liveReads.claimBond.status == "available") and
    (.liveReads.disputeWindow.status == "available")
  ' >/dev/null <<<"$1"
}

live_read_attempt=1
while true; do
  if live_reads_available "$poster_onboarding_json"; then
    echo "  poster onboarding live reads available (attempt ${live_read_attempt}/${LIVE_READ_ATTEMPTS})"
    break
  fi
  if (( live_read_attempt >= LIVE_READ_ATTEMPTS )); then
    echo "  WARNING: poster onboarding live chain reads unavailable after ${LIVE_READ_ATTEMPTS} attempts."
    echo "  WARNING: advisory only — every contract assertion above passed, so the deploy continues."
    # `.liveReads` carries a scalar `asOf` beside the read objects, so select
    # objects only — otherwise this dumps a jq type error instead of naming the
    # read that failed, which is the one thing the operator needs from it.
    jq -r '.liveReads // {} | to_entries[] | select(.value | type == "object")
           | "    " + .key + ": " + ((.value.status // "missing") | tostring)' \
      <<<"$poster_onboarding_json" || true
    break
  fi
  sleep "$LIVE_READ_RETRY_SLEEP_SEC"
  live_read_attempt=$(( live_read_attempt + 1 ))
  # Re-fetch: a payload already in hand cannot recover on its own.
  poster_onboarding_json="$(fetch "$API_POSTER_ONBOARDING_URL")"
done
# Feed both documents via stdin (-s slurps them into an array): --argjson puts
# the whole JSON into execve argv, and a large /health payload can blow past
# ARG_MAX ("jq: Argument list too long", exit 126 — hit live 2026-08-01).
printf '%s\n%s\n' "$poster_onboarding_json" "$api_health_json" | jq -e -s '
    .[0] as $poster | .[1] as $health |
    ($poster.chainId == $health.auth.chainId) and
    (($poster.escrowCore | ascii_downcase) == ($health.addresses.escrowCore | ascii_downcase)) and
    (($poster.agentAccountCore | ascii_downcase) == ($health.addresses.agentAccountCore | ascii_downcase)) and
    (($poster.token.address | ascii_downcase) == ($health.addresses.token | ascii_downcase))
  ' >/dev/null
jq -e '
  .externalBounties.posterOnboarding == "/poster/onboarding" and
  ((if .externalBounties.cancellation.selfServeCancel == true then
      (.externalBounties.cancellation.method == "cancelOpenJob(bytes32)") and
      (.externalBounties.cancellation.minimumOpenSeconds == 3600)
    else
      (.externalBounties.cancellation.rescue == "operator-mediated on request, ~7 days, refunds only ever to the recorded poster") and
      (.externalBounties.cancellation.plannedSelfServeCancel == "cancelOpenJob, next EscrowCore deployment window")
    end)) and
  .externalBounties.claimBond.available == true and
  .externalBounties.disputeWindow.available == true and
  .externalBounties.disputeWindow.remedy.onChain.available == true and
  (.externalBounties.disputeWindow.remedy.onChain.abiFragment == "function openDispute(bytes32 jobId)") and
  (.externalBounties.disputeWindow.remedy.brokeredPath.reason == "no_worker_reachable_brokered_open_dispute_route")
' >/dev/null <<<"$onboarding_json"

if [[ -n "$OPERATOR_TOKEN" ]]; then
  admin_status_json="$(fetch_admin_status_once)"
  # /admin/status is the largest payload in this script — never via argv (see above).
  printf '%s\n%s\n' "$poster_onboarding_json" "$admin_status_json" | jq -e -s '
      .[0] as $poster | .[1] as $operational |
      ($poster.workerFacts.claimBond.stakeBps == $operational.maintenance.policy.risk.defaultClaimStakeBps) and
      ($poster.workerFacts.claimBond.feeBps == $operational.maintenance.policy.risk.claimFeeBps)
    ' >/dev/null
fi

if enabled "$CHECK_METRICS_AUTH"; then
  if [[ -z "$METRICS_BEARER_TOKEN" ]]; then
    echo "CHECK_METRICS_AUTH=1 requires METRICS_BEARER_TOKEN." >&2
    exit 1
  fi

  echo "Checking metrics bearer gate"
  metrics_status_without_bearer="$(curl_with_transport_retries -sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}" "$API_METRICS_URL")"
  if [[ "$metrics_status_without_bearer" != "401" ]]; then
    echo "Expected unauthenticated /metrics to return 401, got HTTP $metrics_status_without_bearer." >&2
    exit 1
  fi

  metrics_status_with_bearer="$(curl_with_transport_retries -sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}" \
    -H "authorization: Bearer $METRICS_BEARER_TOKEN" \
    "$API_METRICS_URL")"
  if [[ "$metrics_status_with_bearer" != "200" ]]; then
    echo "Expected bearer-authenticated /metrics to return 200, got HTTP $metrics_status_with_bearer." >&2
    exit 1
  fi
fi

if enabled "$CHECK_INDEXER"; then
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
else
  echo "CHECK_INDEXER=$CHECK_INDEXER set; skipping indexer checks."
fi

if [[ -n "$OPERATOR_TOKEN" ]]; then
  echo "Checking admin async XCM status"
  admin_status_json="$(fetch_admin_status_once)"
  jq -e '.maintenance.policy.enabled == true' >/dev/null <<<"$admin_status_json"
  jq -e '.xcmSettlementWatcher.enabled == true' >/dev/null <<<"$admin_status_json"
  jq -e '.xcmSettlementWatcher.pendingCount >= 0' >/dev/null <<<"$admin_status_json"
  # `enabled` only proves the watcher was wired in at construction.
  # `running` proves the start() side actually ran and the polling
  # loop is alive — without it, pending observations queue up but
  # never settle. Closes the rc1 P0 row "Hosted /admin/status async
  # XCM smoke" by verifying the watcher lane is publishing, not just
  # configured. See docs/PROJECT_ROADMAP.md §"P0 Launch Gates".
  jq -e '.xcmSettlementWatcher.running == true' >/dev/null <<<"$admin_status_json" || {
    echo "xcmSettlementWatcher.enabled is true but .running is false — settlement watcher loop is not alive; pending observations would not settle." >&2
    exit 1
  }
  jq -e '
    (.xcmObservationRelay | type) == "object" and
    (.xcmObservationRelay.enabled | type) == "boolean"
  ' >/dev/null <<<"$admin_status_json"
  # When the observation relay is enabled, verify the polling loop is
  # alive AND the last poll was either a clean success (no lastError)
  # or hasn't happened yet (lastError null). A stale lastError after a
  # successful poll is cleared by the relay; a sticky lastError means
  # the upstream observer feed is broken from the backend's side.
  jq -e '
    .xcmObservationRelay.enabled == false or
    (
      .xcmObservationRelay.running == true and
      (.xcmObservationRelay.lastError == null or (.xcmObservationRelay.lastError | tostring | length) == 0)
    )
  ' >/dev/null <<<"$admin_status_json" || {
    echo "xcmObservationRelay is enabled but either not running, or its lastError is non-empty (upstream observer feed broken)." >&2
    jq '.xcmObservationRelay' <<<"$admin_status_json" >&2
    exit 1
  }
  # Optional freshness gate. Skipped when the relay is disabled or
  # hasn't polled yet (lastSyncedAt null). Default 30 min — 2× a
  # 15-min poll interval gives the smoke headroom on a freshly-
  # restarted relay that hasn't ticked yet. Operators can tighten
  # via XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC if the deploy is
  # known to poll faster.
  jq -e --argjson maxAge "${XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC:-1800}" '
    .xcmObservationRelay.enabled == false or
    .xcmObservationRelay.lastSyncedAt == null or
    (
      .xcmObservationRelay.lastSyncedAt
      | sub("\\.[0-9]+Z$"; "Z")
      | fromdateiso8601 as $lastSynced
      | (now - $lastSynced) >= 0 and (now - $lastSynced) <= $maxAge
    )
  ' >/dev/null <<<"$admin_status_json" || {
    echo "xcmObservationRelay.lastSyncedAt is older than ${XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC:-1800}s — relay is not polling at the expected cadence." >&2
    jq '.xcmObservationRelay' <<<"$admin_status_json" >&2
    exit 1
  }
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
    .upstreamStatus.batchSize > 0 and
    (.upstreamStatus.evidencePersistenceNote | type) == "string" and
    (.upstreamStatus.lastRun == null or (.upstreamStatus.lastRun | type) == "object") and
    (.upstreamStatus.fundedJobs | type) == "object" and
    (.upstreamStatus.fundedJobs.totalRecords | type) == "number" and
    (.upstreamStatus.fundedJobs.openRecords | type) == "number" and
    (.upstreamStatus.fundedJobs.finalRecords | type) == "number" and
    (.upstreamStatus.fundedJobs.pollableRecords | type) == "number" and
    (.upstreamStatus.fundedJobs.awaitingSubmissionRecords | type) == "number" and
    (.upstreamStatus.fundedJobs.recordsWithUpstreamEvidence | type) == "number" and
    (.upstreamStatus.fundedJobs.byFinalStatus | type) == "object" and
    (.upstreamStatus.fundedJobs.bySourceType | type) == "object"
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

if enabled "$CHECK_EXTERNAL_SCHEMA_PROOF"; then
  if [[ -z "$ADMIN_JWT" ]]; then
    echo "CHECK_EXTERNAL_SCHEMA_PROOF=1 requires ADMIN_JWT." >&2
    exit 1
  fi

  echo "Checking external schema registration proof"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if [[ -n "$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE" ]]; then
    if [[ "$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE" != /* ]]; then
      EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE="$repo_root/$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE"
    fi
    external_schema_proof_evidence_dir="$(dirname "$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE")"
    mkdir -p "$external_schema_proof_evidence_dir"
  fi
  if command -v node >/dev/null 2>&1; then
    API_BASE_URL="${API_HEALTH_URL%/health}" \
      ADMIN_JWT="$ADMIN_JWT" \
      EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE="$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE" \
      EXTERNAL_SCHEMA_PROOF_JOB_ID="$EXTERNAL_SCHEMA_PROOF_JOB_ID" \
      EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY="$EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY" \
      node "$script_dir/check-external-schema-registration-proof.mjs"
  else
    external_schema_proof_docker_volume_args=(-v "$repo_root:/workspace")
    if [[ -n "${external_schema_proof_evidence_dir:-}" ]]; then
      external_schema_proof_docker_volume_args+=(-v "$external_schema_proof_evidence_dir:$external_schema_proof_evidence_dir")
    fi
    docker run --rm \
      "${external_schema_proof_docker_volume_args[@]}" \
      -w /workspace \
      -e API_BASE_URL="${API_HEALTH_URL%/health}" \
      -e ADMIN_JWT="$ADMIN_JWT" \
      -e EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE="$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE" \
      -e EXTERNAL_SCHEMA_PROOF_JOB_ID="$EXTERNAL_SCHEMA_PROOF_JOB_ID" \
      -e EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY="$EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY" \
      "$EXTERNAL_SCHEMA_PROOF_NODE_IMAGE" \
      node scripts/ops/check-external-schema-registration-proof.mjs
  fi
fi

if enabled "$CHECK_DISPUTE_VERDICT_PROOF"; then
  if [[ -z "$ADMIN_JWT" && -z "$AVERRAY_TOKEN" ]]; then
    echo "CHECK_DISPUTE_VERDICT_PROOF=1 requires ADMIN_JWT or AVERRAY_TOKEN." >&2
    exit 1
  fi
  if [[ "${DISPUTE_PROOF_LIVE:-}" != "1" ]]; then
    echo "CHECK_DISPUTE_VERDICT_PROOF=1 requires DISPUTE_PROOF_LIVE=1; dry-run output is not enough for the hosted proof gate." >&2
    exit 1
  fi

  echo "Checking hosted dispute verdict proof"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if [[ -n "$DISPUTE_PROOF_EVIDENCE_FILE" ]]; then
    if [[ "$DISPUTE_PROOF_EVIDENCE_FILE" != /* ]]; then
      DISPUTE_PROOF_EVIDENCE_FILE="$repo_root/$DISPUTE_PROOF_EVIDENCE_FILE"
    fi
    dispute_proof_evidence_dir="$(dirname "$DISPUTE_PROOF_EVIDENCE_FILE")"
    mkdir -p "$dispute_proof_evidence_dir"
  fi
  if command -v node >/dev/null 2>&1; then
    dispute_proof_json="$(
      API_BASE_URL="${API_HEALTH_URL%/health}" \
        ADMIN_JWT="$ADMIN_JWT" \
        AVERRAY_TOKEN="$AVERRAY_TOKEN" \
        DISPUTE_PROOF_EVIDENCE_FILE="$DISPUTE_PROOF_EVIDENCE_FILE" \
        DISPUTE_PROOF_JSON_ONLY=1 \
        DISPUTE_PROOF_REQUIRE_CHAIN=1 \
        node "$script_dir/run-dispute-verdict-proof.mjs"
    )"
  else
    dispute_proof_docker_volume_args=(-v "$repo_root:/workspace")
    if [[ -n "${dispute_proof_evidence_dir:-}" ]]; then
      dispute_proof_docker_volume_args+=(-v "$dispute_proof_evidence_dir:$dispute_proof_evidence_dir")
    fi
    dispute_proof_json="$(
      docker run --rm \
        "${dispute_proof_docker_volume_args[@]}" \
        -w /workspace \
        -e API_BASE_URL="${API_HEALTH_URL%/health}" \
        -e ADMIN_JWT="$ADMIN_JWT" \
        -e AVERRAY_TOKEN="$AVERRAY_TOKEN" \
        -e DISPUTE_PROOF_ID="${DISPUTE_PROOF_ID:-}" \
        -e DISPUTE_PROOF_VERDICT="${DISPUTE_PROOF_VERDICT:-}" \
        -e DISPUTE_PROOF_RATIONALE="${DISPUTE_PROOF_RATIONALE:-}" \
        -e DISPUTE_PROOF_WORKER_PAYOUT="${DISPUTE_PROOF_WORKER_PAYOUT:-}" \
        -e DISPUTE_PROOF_IDEMPOTENCY_KEY="${DISPUTE_PROOF_IDEMPOTENCY_KEY:-}" \
        -e DISPUTE_PROOF_LIVE="$DISPUTE_PROOF_LIVE" \
        -e DISPUTE_PROOF_EVIDENCE_FILE="$DISPUTE_PROOF_EVIDENCE_FILE" \
        -e DISPUTE_PROOF_JSON_ONLY=1 \
        -e DISPUTE_PROOF_REQUIRE_CHAIN=1 \
        "$DISPUTE_PROOF_NODE_IMAGE" \
        node scripts/ops/run-dispute-verdict-proof.mjs
    )"
  fi
  jq -e '
    .mode == "live" and
    (.response.chainStatus == "confirmed" or .response.chainStatus == "submitted") and
    (.response.txHash | type) == "string" and
    (.response.txHash | test("^0x[a-fA-F0-9]{64}$")) and
    .persisted.status == "resolved" and
    .persisted.reasoningHash == .response.reasoningHash
  ' >/dev/null <<<"$dispute_proof_json"
fi

if enabled "$CHECK_SIWE_FRESH_WALLET_PROOF"; then
  # Real SIWE login with a FRESH, non-admin/non-verifier wallet — the
  # regression guard for the roleless-wallet JWT mint. Needs no ADMIN_JWT
  # (that's the whole point: it exercises the live front door, not a
  # pre-minted multi-role token). Must FAIL before the auth fix (verify
  # 500s) and PASS after.
  echo "Checking SIWE fresh-wallet proof"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if [[ -n "$SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE" ]]; then
    if [[ "$SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE" != /* ]]; then
      SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE="$repo_root/$SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE"
    fi
    siwe_fresh_wallet_proof_evidence_dir="$(dirname "$SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE")"
    mkdir -p "$siwe_fresh_wallet_proof_evidence_dir"
  fi
  if command -v node >/dev/null 2>&1; then
    API_BASE_URL="${API_HEALTH_URL%/health}" \
      SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE="$SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE" \
      SIWE_FRESH_WALLET_PRIVATE_KEY="$SIWE_FRESH_WALLET_PRIVATE_KEY" \
      node "$script_dir/check-siwe-fresh-wallet-proof.mjs"
  else
    siwe_fresh_wallet_proof_docker_volume_args=(-v "$repo_root:/workspace")
    if [[ -n "${siwe_fresh_wallet_proof_evidence_dir:-}" ]]; then
      siwe_fresh_wallet_proof_docker_volume_args+=(-v "$siwe_fresh_wallet_proof_evidence_dir:$siwe_fresh_wallet_proof_evidence_dir")
    fi
    docker run --rm \
      "${siwe_fresh_wallet_proof_docker_volume_args[@]}" \
      -w /workspace \
      -e API_BASE_URL="${API_HEALTH_URL%/health}" \
      -e SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE="$SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE" \
      -e SIWE_FRESH_WALLET_PRIVATE_KEY="$SIWE_FRESH_WALLET_PRIVATE_KEY" \
      "$SIWE_FRESH_WALLET_PROOF_NODE_IMAGE" \
      node scripts/ops/check-siwe-fresh-wallet-proof.mjs
  fi
fi

if enabled "$CHECK_WORKER_CANARY_PROOF"; then
  # End-to-end external-worker canary: a FRESH ROLELESS wallet walks the real
  # SIWE front door, then claim→submit→verify→settle on a disposable,
  # operator-funded testnet job. Worker stages use the roleless token; only the
  # operator stages (create/fund/verify/cleanup) use the ADMIN_JWT. Each stage
  # fails loud with the launch-blocker class it guards (#625/#626/claim-409/
  # #627/settlement/#628). Testnet-only — it refuses any other chain.
  if [[ -z "$ADMIN_JWT" && -z "$AVERRAY_TOKEN" ]]; then
    echo "CHECK_WORKER_CANARY_PROOF=1 requires an operator credential (ADMIN_JWT or AVERRAY_TOKEN) for the create/verify/cleanup stages." >&2
    exit 1
  fi
  echo "Checking external-worker canary"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if [[ -n "$WORKER_CANARY_EVIDENCE_FILE" ]]; then
    if [[ "$WORKER_CANARY_EVIDENCE_FILE" != /* ]]; then
      WORKER_CANARY_EVIDENCE_FILE="$repo_root/$WORKER_CANARY_EVIDENCE_FILE"
    fi
    worker_canary_evidence_dir="$(dirname "$WORKER_CANARY_EVIDENCE_FILE")"
    mkdir -p "$worker_canary_evidence_dir"
  fi
  if command -v node >/dev/null 2>&1; then
    API_BASE_URL="${API_HEALTH_URL%/health}" \
      ADMIN_JWT="$ADMIN_JWT" \
      AVERRAY_TOKEN="$AVERRAY_TOKEN" \
      WORKER_CANARY_EVIDENCE_FILE="$WORKER_CANARY_EVIDENCE_FILE" \
      WORKER_CANARY_WORKER_PRIVATE_KEY="$WORKER_CANARY_WORKER_PRIVATE_KEY" \
      WORKER_CANARY_WORKER_KEY_OP="$WORKER_CANARY_WORKER_KEY_OP" \
      WORKER_CANARY_PROFILE="$WORKER_CANARY_PROFILE" \
      WORKER_CANARY_REWARD_AMOUNT="$WORKER_CANARY_REWARD_AMOUNT" \
      WORKER_CANARY_TOKEN_MIN_DAYS="$WORKER_CANARY_TOKEN_MIN_DAYS" \
      WORKER_CANARY_VERIFY_MODE="$WORKER_CANARY_VERIFY_MODE" \
      WORKER_CANARY_ALLOW_EPHEMERAL="$WORKER_CANARY_ALLOW_EPHEMERAL" \
      WORKER_CANARY_KEEP_JOB="$WORKER_CANARY_KEEP_JOB" \
      node "$script_dir/run-worker-canary.mjs"
  else
    worker_canary_docker_volume_args=(-v "$repo_root:/workspace")
    if [[ -n "${worker_canary_evidence_dir:-}" ]]; then
      worker_canary_docker_volume_args+=(-v "$worker_canary_evidence_dir:$worker_canary_evidence_dir")
    fi
    docker run --rm \
      "${worker_canary_docker_volume_args[@]}" \
      -w /workspace \
      -e API_BASE_URL="${API_HEALTH_URL%/health}" \
      -e ADMIN_JWT="$ADMIN_JWT" \
      -e AVERRAY_TOKEN="$AVERRAY_TOKEN" \
      -e WORKER_CANARY_EVIDENCE_FILE="$WORKER_CANARY_EVIDENCE_FILE" \
      -e WORKER_CANARY_WORKER_PRIVATE_KEY="$WORKER_CANARY_WORKER_PRIVATE_KEY" \
      -e WORKER_CANARY_WORKER_KEY_OP="$WORKER_CANARY_WORKER_KEY_OP" \
      -e WORKER_CANARY_PROFILE="$WORKER_CANARY_PROFILE" \
      -e WORKER_CANARY_REWARD_AMOUNT="$WORKER_CANARY_REWARD_AMOUNT" \
      -e WORKER_CANARY_TOKEN_MIN_DAYS="$WORKER_CANARY_TOKEN_MIN_DAYS" \
      -e WORKER_CANARY_VERIFY_MODE="$WORKER_CANARY_VERIFY_MODE" \
      -e WORKER_CANARY_ALLOW_EPHEMERAL="$WORKER_CANARY_ALLOW_EPHEMERAL" \
      -e WORKER_CANARY_KEEP_JOB="$WORKER_CANARY_KEEP_JOB" \
      "$WORKER_CANARY_NODE_IMAGE" \
      node scripts/ops/run-worker-canary.mjs
  fi
fi

echo "Hosted stack smoke check passed."
