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
APP_RECEIPT_REDIRECT_URL=${APP_RECEIPT_REDIRECT_URL:-https://app.averray.com/receipts/0xabc123def4567890abc123def4567890abc123de}
APP_RECEIPTS_RSC_URL=${APP_RECEIPTS_RSC_URL:-https://app.averray.com/receipts/__next._tree.txt}
APP_JOBS_REDIRECT_URL=${APP_JOBS_REDIRECT_URL:-https://app.averray.com/jobs}
APP_JOB_SUBPATH_REDIRECT_URL=${APP_JOB_SUBPATH_REDIRECT_URL:-https://app.averray.com/jobs/example-job}
PUBLIC_WORK_REDIRECT_URL=${PUBLIC_WORK_REDIRECT_URL:-https://averray.com/work}
PUBLIC_WORK_SUBPATH_REDIRECT_URL=${PUBLIC_WORK_SUBPATH_REDIRECT_URL:-https://averray.com/work/example-job}
PUBLIC_GET_STARTED_REDIRECT_URL=${PUBLIC_GET_STARTED_REDIRECT_URL:-https://averray.com/get-started}
DISCOVERY_URL=${DISCOVERY_URL:-https://averray.com/.well-known/agent-tools.json}
APP_URL=${APP_URL:-https://app.averray.com/}
APP_POST_REDIRECT_URL=${APP_POST_REDIRECT_URL:-https://app.averray.com/post}
APP_POSTER_JOBS_REDIRECT_URL=${APP_POSTER_JOBS_REDIRECT_URL:-https://app.averray.com/poster/jobs}
APP_VERIFY_REDIRECT_URL=${APP_VERIFY_REDIRECT_URL:-https://app.averray.com/verify}
APP_WITHDRAW_REDIRECT_URL=${APP_WITHDRAW_REDIRECT_URL:-https://app.averray.com/withdraw}
APP_WITHDRAW_SLASH_REDIRECT_URL=${APP_WITHDRAW_SLASH_REDIRECT_URL:-https://app.averray.com/withdraw/}
APP_EARNINGS_REDIRECT_URL=${APP_EARNINGS_REDIRECT_URL:-https://app.averray.com/earnings}
APP_EARNINGS_SLASH_REDIRECT_URL=${APP_EARNINGS_SLASH_REDIRECT_URL:-https://app.averray.com/earnings/}
WWW_MCP_INSTALL_REDIRECT_URL=${WWW_MCP_INSTALL_REDIRECT_URL:-https://averray.com/mcp}
WWW_INSTALL_REDIRECT_URL=${WWW_INSTALL_REDIRECT_URL:-https://averray.com/install}
WWW_CURSOR_INSTALL_REDIRECT_URL=${WWW_CURSOR_INSTALL_REDIRECT_URL:-https://averray.com/cursor}
WWW_CLAUDE_INSTALL_REDIRECT_URL=${WWW_CLAUDE_INSTALL_REDIRECT_URL:-https://averray.com/claude}
APP_MCP_INSTALL_REDIRECT_URL=${APP_MCP_INSTALL_REDIRECT_URL:-https://app.averray.com/mcp}
APP_INSTALL_REDIRECT_URL=${APP_INSTALL_REDIRECT_URL:-https://app.averray.com/install}
APP_CONNECT_INSTALL_REDIRECT_URL=${APP_CONNECT_INSTALL_REDIRECT_URL:-https://app.averray.com/connect}
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
# Sync liveness runs on EVERY smoke, not only when the indexer was redeployed
# (CHECK_INDEXER gates the deploy checks: root + /ready). A wedged Ponder sync
# keeps /health 200 (process liveness) while /status stops advancing; since
# #1358 the /credit door needs a current index, so the 2026-09-10 wedge failed
# every backend-only deploy for ~10h at "CreditPool door did not return the
# wallet's L1/L2/L3 debt fields" instead of naming the indexer. The budget
# mirrors the backend's INDEXER_LAG_BUDGET_SECONDS so this smoke and
# capabilityHealth.indexer agree on what "current" means;
# INDEXER_MAX_STALENESS_SEC stays honoured as the operator override
# (docs/INCIDENT_RESPONSE.md uses it to force a deliberate failure).
INDEXER_LAG_BUDGET_SECONDS=${INDEXER_LAG_BUDGET_SECONDS:-600}
INDEXER_MAX_STALENESS_SEC=${INDEXER_MAX_STALENESS_SEC:-$INDEXER_LAG_BUDGET_SECONDS}
CHECK_INDEXER=${CHECK_INDEXER:-1}
CHECK_INDEXER_SYNC=${CHECK_INDEXER_SYNC:-1}
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
# Deploy-time transients get exactly ONE bounded re-read before the smoke
# fails (see evaluate_clauses and the two call sites below). Nothing else is
# retried: a parsed assertion failure on a stable document fails on the spot.
#   TRANSIENT_RECHECK_SLEEP_SEC      minimum wait before the single re-read;
#                                    the default equals the backend's
#                                    POSTER_ONBOARDING_CACHE_MS (30s) — below
#                                    it the poster re-fetch can be served the
#                                    same cached cold snapshot
#   TRANSIENT_RECHECK_MAX_SLEEP_SEC  cap when the wait is stretched to the
#                                    verifier's advertised nextRunAt
#   VERIFIER_CRITICAL_GRACE_SEC      how young (consecutiveRuns × intervalMs) a
#                                    critical submitted_session_persistently_skipped
#                                    must be to count as post-recreate noise
TRANSIENT_RECHECK_SLEEP_SEC=${TRANSIENT_RECHECK_SLEEP_SEC:-30}
TRANSIENT_RECHECK_MAX_SLEEP_SEC=${TRANSIENT_RECHECK_MAX_SLEEP_SEC:-90}
VERIFIER_CRITICAL_GRACE_SEC=${VERIFIER_CRITICAL_GRACE_SEC:-600}
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
for transient_knob in "$TRANSIENT_RECHECK_SLEEP_SEC" "$TRANSIENT_RECHECK_MAX_SLEEP_SEC" "$VERIFIER_CRITICAL_GRACE_SEC"; do
  if [[ ! "$transient_knob" =~ ^[0-9]+$ ]]; then
    echo "TRANSIENT_RECHECK_SLEEP_SEC, TRANSIENT_RECHECK_MAX_SLEEP_SEC and VERIFIER_CRITICAL_GRACE_SEC must be non-negative integer seconds." >&2
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

assert_app_side_asset() {
  local url="$1"
  local label="$2"
  local status
  local curl_args=(-sS --max-time "$TIMEOUT_SEC" -o /dev/null -w "%{http_code}")
  if [[ -n "$APP_BASIC_AUTH_USER" && -n "$APP_BASIC_AUTH_PASSWORD" ]]; then
    curl_args+=(-u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD")
  fi
  status="$(curl_with_transport_retries "${curl_args[@]}" "$url")"
  case "$status" in
    301|302|303|307|308)
      echo "$label returned HTTP $status; the client-navigation request escaped the app vhost." >&2
      exit 1
      ;;
    *) return 0 ;;
  esac
}

enabled() {
  case "${1:-}" in
    1|true|yes) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Named-clause assertions --------------------------------------------------
#
# Every jq assertion in this smoke runs through evaluate_clauses so that a red
# run names the FIRST failing clause and prints the field values it read. A
# bare `jq -e '...' >/dev/null` fails the deploy with nothing but
# "##[error]Process completed with exit code 1": five production deploys on
# 2026-09-11/12 died that way right after "Checking API health" / "Checking
# poster onboarding live facts", every one of them was green when re-run
# minutes later, and the log carried no evidence of which clause had refused.
#
#   evaluate_clauses [-s] [--arg NAME VALUE] [--argjson NAME VALUE] \
#     LABEL JSON PRELUDE  NAME EXPR CONTEXT  [NAME EXPR CONTEXT ...]
#
#   -s        slurp: JSON holds newline-separated documents and the clauses
#             see the array (`.[0] as $a | .[1] as $b |` in PRELUDE) — used
#             for the cross-document checks; keeps large payloads off argv
#             (--argjson blew ARG_MAX live on 2026-08-01)
#   LABEL     what is being checked, printed on failure ("API health")
#   PRELUDE   jq bindings prefixed to every clause, "" for none
#   NAME      stable clause id — this is what the failure log names
#   EXPR      the jq boolean the clause asserts
#   CONTEXT   jq expression whose value is printed beside the failure, "" for
#             none; keep it to the fields the clause read
#
# Returns 1 on the first failing clause and leaves its NAME in FAILED_CLAUSE
# for the two call sites that decide about a bounded re-read. A jq runtime
# error inside a clause (`test` on a null, `ascii_downcase` on a missing
# address) is a failure too and its message is printed rather than swallowed.
# Clauses that used to error that way are written `(...)? // false` so the
# log shows the observed value instead of a jq stack line — the accepted set
# is unchanged, a missing field still fails.
FAILED_CLAUSE=""
evaluate_clauses() {
  local jq_args=()
  while (( $# > 0 )); do
    case "$1" in
      -s) jq_args+=(-s); shift ;;
      --arg|--argjson) jq_args+=("$1" "$2" "$3"); shift 3 ;;
      *) break ;;
    esac
  done
  local label="$1" json="$2" prelude="$3"
  shift 3
  if (( $# == 0 || $# % 3 != 0 )); then
    echo "evaluate_clauses: '$label' needs NAME EXPR CONTEXT triples (got $# arguments)." >&2
    exit 1
  fi
  local name expr context output rc
  FAILED_CLAUSE=""
  while (( $# >= 3 )); do
    name="$1"; expr="$2"; context="$3"
    shift 3
    output="$(jq -e ${jq_args[@]+"${jq_args[@]}"} "${prelude} (${expr})" <<<"$json" 2>&1)" && rc=0 || rc=$?
    if (( rc == 0 )); then
      continue
    fi
    FAILED_CLAUSE="$name"
    {
      echo "$label: clause '$name' failed."
      echo "  asserted: $(tr -s '[:space:]' ' ' <<<"$expr" | sed -e 's/^ //' -e 's/ $//')"
      # jq -e exits 1 for a plain false/null; anything else is an error worth reading.
      if (( rc != 1 )); then
        echo "  jq exit $rc: ${output:-(no result: the expression produced no value)}"
      fi
      if [[ -n "$context" ]]; then
        echo "  observed: $(jq -c ${jq_args[@]+"${jq_args[@]}"} "${prelude} (${context})" <<<"$json" 2>&1 || true)"
      fi
    } >&2
    return 1
  done
  return 0
}

assert_clauses() {
  evaluate_clauses "$@" || exit 1
}

# /health warning list as "code (severity), ..." so the log shows what the
# check saw on every run, not only when it refuses something.
describe_health_warnings() {
  jq -r '
    [.warnings[]? | objects | "\(.code // "?") (\(.severity // "?"))"]
    | if length == 0 then "none" else join(", ") end
  ' <<<"$1" 2>/dev/null || echo "unreadable"
}

# The verifier's persistent-skip streak, for the log: "2 run(s) x 60000ms".
describe_verifier_streak() {
  jq -r '
    .components.submittedJobAutoVerifier
    | "\([.persistentSubmittedFailures[]?.consecutiveRuns | numbers] | max // "?") run(s) x \(.intervalMs // "?")ms"
  ' <<<"$1" 2>/dev/null || echo "unknown"
}

# A critical submitted_session_persistently_skipped is post-recreate noise ONLY
# while it is young. The verifier's failure streaks live in memory
# (submitted-job-auto-verifier.js submittedFailureStreaks), so a backend
# recreate resets them; the first runs after a recreate re-skip a submitted
# session the cold chain gateway cannot settle yet, and /health goes critical
# at run 2 (~60s after start). On 2026-09-11/12 it cleared within two more
# runs every time. /health carries no process start time, but the streak's
# consecutiveRuns × intervalMs is exactly how long the verifier has been
# watching this failure since its counter (re)started, so that is the window.
#
# Eligible for the single re-read iff status and state store are fine, no
# indexer_stalled warning is present, the verifier's state is exactly
# submitted_session_persistently_skipped, and its streak is younger than
# VERIFIER_CRITICAL_GRACE_SEC. Anything else — indexer_stalled above all, a
# stopped or timed-out verifier, a streak older than the grace — fails on the
# first read. Other warnings are printed, not gated, and do not block the
# re-read: blockchain/treasury health is a cold cache for the first seconds
# after a recreate and gating it here would be a new flake, not a fix.
health_transient_verifier_critical() {
  jq -e --argjson graceSec "$VERIFIER_CRITICAL_GRACE_SEC" '
    (.status == "ok")
    and (.components.stateStore.ok == true)
    and ([.warnings[]? | objects | select(.code == "indexer_stalled")] | length == 0)
    and (.components.submittedJobAutoVerifier as $v
      | ($v.ok == false)
      and ($v.state == "submitted_session_persistently_skipped")
      and (($v.intervalMs | numbers) > 0)
      and ([$v.persistentSubmittedFailures[]?.consecutiveRuns | numbers] as $runs
        | ($runs | length) > 0
        and ((($runs | max) * $v.intervalMs / 1000) <= $graceSec)))
  ' >/dev/null <<<"$1"
}

# Seconds to wait before the single /health re-read: at least
# TRANSIENT_RECHECK_SLEEP_SEC, stretched to just past the verifier's advertised
# nextRunAt because the streak only changes when a run finishes, capped at
# TRANSIENT_RECHECK_MAX_SLEEP_SEC so a skewed clock cannot hang the deploy.
health_recheck_delay_sec() {
  jq -r --argjson floor "$TRANSIENT_RECHECK_SLEEP_SEC" --argjson cap "$TRANSIENT_RECHECK_MAX_SLEEP_SEC" '
    (.components.submittedJobAutoVerifier.nextRunAt
      | if type == "string" then (sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) else null end) as $next
    | (if $next == null then $floor else ((($next - now) | ceil) + 5) end) as $wanted
    | [$floor, ([$wanted, $cap] | min)] | max | floor
  ' <<<"$1" 2>/dev/null || echo "$TRANSIENT_RECHECK_SLEEP_SEC"
}

# Poster onboarding only populates the live-derived facts —
# economics.protocolFeeBps/posterFeeBps/posterFeeFloorRaw/feeRecipient,
# workerFacts.claimBond, workerFacts.disputeWindow — from a successful chain
# read (mcp-server/src/core/poster-onboarding.js buildSnapshot). While the
# gateway warms up after a recreate those reads report `unavailable` and the
# structural clauses cannot pass yet. That, and only that, earns one re-fetch
# after a bounded wait; a clause failing while every read is `available` is a
# contract regression and fails on the first read.
poster_live_reads_unavailable() {
  jq -e '
    [.liveReads // {} | to_entries[] | select(.value | type == "object") | select(.value.status != "available")]
    | length > 0
  ' >/dev/null <<<"$1"
}

# `.liveReads` carries a scalar `asOf` beside the read objects; select objects
# only so this names the reads instead of printing a jq type error.
describe_poster_live_reads() {
  jq -r '
    [.liveReads // {} | to_entries[] | select(.value | type == "object")
      | "\(.key)=\(.value.status // "missing")\(if .value.reason then " (\(.value.reason))" else "" end)"]
    | if length == 0 then "none reported" else join(", ") end
  ' <<<"$1" 2>/dev/null || echo "unreadable"
}

# When the snapshot was built. The backend caches it for
# POSTER_ONBOARDING_CACHE_MS; an unchanged asOf on the re-fetch means the
# second read saw the same cold snapshot, not a recovered gateway.
poster_snapshot_as_of() {
  jq -r '.liveReads.asOf // "unknown"' <<<"$1" 2>/dev/null || echo "unknown"
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
assert_redirect "$APP_RECEIPT_REDIRECT_URL" "https://averray.com/receipts/0xabc123def4567890abc123def4567890abc123de" "Operator-app public receipt path"
assert_app_side_asset "$APP_RECEIPTS_RSC_URL" "Operator-app receipts client-navigation asset"
assert_redirect "$APP_JOBS_REDIRECT_URL" "https://app.averray.com/work" "Operator-app legacy jobs path"
assert_redirect "$APP_JOB_SUBPATH_REDIRECT_URL" "https://app.averray.com/work" "Operator-app legacy job subpath"
assert_redirect "$PUBLIC_WORK_REDIRECT_URL" "https://app.averray.com/work" "Public-site work path"
assert_redirect "$PUBLIC_WORK_SUBPATH_REDIRECT_URL" "https://app.averray.com/work" "Public-site work subpath"
assert_redirect "$PUBLIC_GET_STARTED_REDIRECT_URL" "https://averray.com/agents/" "Public get-started path"
assert_redirect "$APP_POST_REDIRECT_URL" "https://app.averray.com/poster/" "App posting alias"
assert_redirect "$APP_POSTER_JOBS_REDIRECT_URL" "https://app.averray.com/poster/" "App poster-jobs alias"
assert_redirect "$APP_VERIFY_REDIRECT_URL" "https://app.averray.com/runs/" "App verification alias"
assert_redirect "$APP_WITHDRAW_REDIRECT_URL" "https://app.averray.com/work-withdraw/" "App withdrawal alias"
assert_redirect "$APP_WITHDRAW_SLASH_REDIRECT_URL" "https://app.averray.com/work-withdraw/" "App withdrawal slash alias"
assert_redirect "$APP_EARNINGS_REDIRECT_URL" "https://app.averray.com/work-withdraw/" "App earnings alias"
assert_redirect "$APP_EARNINGS_SLASH_REDIRECT_URL" "https://app.averray.com/work-withdraw/" "App earnings slash alias"
assert_redirect "$WWW_MCP_INSTALL_REDIRECT_URL" "https://averray.com/builders/#install" "WWW MCP install alias"
assert_redirect "$WWW_INSTALL_REDIRECT_URL" "https://averray.com/builders/#install" "WWW install alias"
assert_redirect "$WWW_CURSOR_INSTALL_REDIRECT_URL" "https://averray.com/builders/#install" "WWW Cursor install alias"
assert_redirect "$WWW_CLAUDE_INSTALL_REDIRECT_URL" "https://averray.com/builders/#install" "WWW Claude install alias"
assert_redirect "$APP_MCP_INSTALL_REDIRECT_URL" "https://averray.com/builders/#install" "App MCP install alias"
assert_redirect "$APP_INSTALL_REDIRECT_URL" "https://averray.com/builders/#install" "App install alias"
assert_redirect "$APP_CONNECT_INSTALL_REDIRECT_URL" "https://averray.com/builders/#install" "App connect install alias"
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
assert_clauses "Discovery manifest" "$discovery_json" "" \
  discovery_url_canonical \
    '.discoveryUrl == "https://averray.com/.well-known/agent-tools.json"' \
    '.discoveryUrl' \
  base_url_canonical \
    '.baseUrl == "https://api.averray.com"' \
    '.baseUrl' \
  poster_onboarding_is_public_endpoint \
    '(.publicEndpoints | any(.path == "/poster/onboarding"))? // false' \
    '[.publicEndpoints[]?.path]' \
  poster_entrypoint_canonical \
    '.onboarding.posterEntrypoint == "https://api.averray.com/poster/onboarding"' \
    '.onboarding.posterEntrypoint'
evaluate_clauses "Discovery manifest" "$discovery_json" "" \
  no_retired_strategies_endpoint \
    '([.publicEndpoints[]?.path, .authenticatedEndpoints[]?.path] | index("/strategies") == null)' \
    '[.publicEndpoints[]?.path, .authenticatedEndpoints[]?.path]' \
  no_retired_account_strategies_endpoint \
    '([.publicEndpoints[]?.path, .authenticatedEndpoints[]?.path] | index("/account/strategies") == null)' \
    '[.publicEndpoints[]?.path, .authenticatedEndpoints[]?.path]' \
  no_retired_get_strategy_positions_tool \
    '([.tools[]?.name] | index("getStrategyPositions") == null)' \
    '[.tools[]?.name]' \
  no_retired_list_strategies_tool \
    '([.tools[]?.name] | index("listStrategies") == null)' \
    '[.tools[]?.name]' || {
  echo "Discovery still advertises a retired strategy surface." >&2
  exit 1
}

echo "Checking operator app shell"
check_operator_app_shell

echo "Checking API health"
# Clause order is the refusal order: a stalled index is named ahead of the
# verifier even when both are red, because the verifier can only be re-read
# when the index is not the reason it is skipping (see
# health_transient_verifier_critical).
api_health_clauses=(
  status_ok
    '.status == "ok"'
    '{status, serviceHealth}'
  state_store_ok
    '.components.stateStore.ok == true'
    '.components.stateStore'
  indexer_not_stalled
    '[.warnings[]? | objects | select(.code == "indexer_stalled")] | length == 0'
    '[.warnings[]? | objects | select(.code == "indexer_stalled")]'
  auto_verifier_ok
    '.components.submittedJobAutoVerifier.ok == true'
    '.components.submittedJobAutoVerifier | {ok, state, intervalMs, nextRunAt, lastRunFinishedAt, pendingTimeoutCount, persistentSubmittedFailures}'
)
api_health_json="$(fetch "$API_HEALTH_URL")"
echo "  /health warnings: $(describe_health_warnings "$api_health_json")"
if ! evaluate_clauses "API health" "$api_health_json" "" "${api_health_clauses[@]}"; then
  if ! health_transient_verifier_critical "$api_health_json"; then
    echo "API health: refused on clause '$FAILED_CLAUSE' (warnings seen: $(describe_health_warnings "$api_health_json")); not a deploy-time transient, so no re-read." >&2
    if [[ "$FAILED_CLAUSE" == "indexer_not_stalled" ]]; then
      echo "The backend's own indexer probe reports a stalled sync: the newest indexed block has not moved for its stall budget. Ponder's /health stays 200 in this state (process liveness only). If no schema replay is in progress, restart the indexer container (docker restart agent-mainnet-indexer) and see docs/INCIDENT_RESPONSE.md \"Indexer sync stall from a provider block hole\"." >&2
    fi
    exit 1
  fi
  health_recheck_delay="$(health_recheck_delay_sec "$api_health_json")"
  echo "  API health: critical submitted_session_persistently_skipped is younger than VERIFIER_CRITICAL_GRACE_SEC=${VERIFIER_CRITICAL_GRACE_SEC}s (streak $(describe_verifier_streak "$api_health_json")) — the verifier's streaks reset on a backend recreate and the first runs after one re-skip until the chain gateway is warm. Re-reading /health ONCE in ${health_recheck_delay}s (TRANSIENT_RECHECK_SLEEP_SEC=${TRANSIENT_RECHECK_SLEEP_SEC}, stretched to the verifier's next run, capped at TRANSIENT_RECHECK_MAX_SLEEP_SEC=${TRANSIENT_RECHECK_MAX_SLEEP_SEC})."
  sleep "$health_recheck_delay"
  api_health_json="$(fetch "$API_HEALTH_URL")"
  echo "  /health warnings on re-read: $(describe_health_warnings "$api_health_json")"
  if ! evaluate_clauses "API health (re-read)" "$api_health_json" "" "${api_health_clauses[@]}"; then
    echo "API health: refused on clause '$FAILED_CLAUSE' after the single bounded re-read (warnings seen: $(describe_health_warnings "$api_health_json"); verifier streak $(describe_verifier_streak "$api_health_json"))." >&2
    exit 1
  fi
  echo "  API health clauses passed on the re-read; the verifier critical cleared."
fi
# The gate above is the contract this smoke enforces; it is not "no critical
# warnings". blockchain_*/treasury_mutations_*/locked-tier criticals are printed
# but not gated (see health_transient_verifier_critical for why), so a pass
# with one of them standing must not read as a clean pass.
ungated_health_criticals="$(jq -r '
  [.warnings[]? | objects | select(.severity == "critical") | .code // "?"]
  | join(", ")
' <<<"$api_health_json" 2>/dev/null || true)"
if [[ -n "$ungated_health_criticals" ]]; then
  echo "  WARNING: API health passed its gated clauses while /health still carries critical warning(s) this smoke does not gate: ${ungated_health_criticals}. Read capabilityHealth before treating this deploy as clean."
fi

# Before any door that answers from the index (/credit below), so a stalled
# sync is named as such rather than as a credit-door field failure.
if enabled "$CHECK_INDEXER_SYNC"; then
  echo "Checking indexer sync liveness"
  if ! [[ "$INDEXER_MAX_STALENESS_SEC" =~ ^[0-9]+$ ]]; then
    echo "INDEXER_MAX_STALENESS_SEC / INDEXER_LAG_BUDGET_SECONDS must be a non-negative integer number of seconds." >&2
    exit 1
  fi
  indexer_status_json="$(fetch "$INDEXER_STATUS_URL")"
  assert_clauses "Indexer /status" "$indexer_status_json" "" \
    status_is_nonempty_object \
      'type == "object" and (keys | length) > 0' \
      '{type: type, keys: (keys? // null)}' \
    head_block_number_positive \
      '([to_entries[].value.block.number] | max > 0)? // false' \
      '[to_entries[]? | {network: .key, block: .value.block}]'
  indexer_head_block="$(jq -r '[to_entries[].value.block] | max_by(.timestamp) | .number' <<<"$indexer_status_json")"
  indexer_head_age_sec="$(jq -r '(now - ([to_entries[].value.block.timestamp] | max)) | floor | if . < 0 then 0 else . end' <<<"$indexer_status_json")"
  if (( indexer_head_age_sec > INDEXER_MAX_STALENESS_SEC )); then
    echo "Indexer sync is stalled: newest indexed block $indexer_head_block is ${indexer_head_age_sec}s old (budget ${INDEXER_MAX_STALENESS_SEC}s)." >&2
    echo "Ponder's /health stays 200 in this state (process liveness only), so the compose healthcheck never restarts it. If no schema replay is in progress, restart the indexer container (docker restart agent-mainnet-indexer) and see docs/INCIDENT_RESPONSE.md \"Indexer sync stall from a provider block hole\"." >&2
    exit 1
  fi
  echo "Indexer head is ${indexer_head_age_sec}s old (budget ${INDEXER_MAX_STALENESS_SEC}s)."
else
  echo "CHECK_INDEXER_SYNC=$CHECK_INDEXER_SYNC set; skipping indexer sync liveness check."
fi

echo "Checking browser-friendly MCP endpoint"
mcp_info_json="$(fetch "$API_MCP_INFO_URL")"
evaluate_clauses "GET /mcp" "$mcp_info_json" "" \
  type_is_mcp_protocol_endpoint \
    '.type == "mcp_protocol_endpoint"' \
    '.type' \
  description_names_protocol_endpoint \
    '.description == "This is an MCP protocol endpoint, not a browser page."' \
    '.description' \
  connect_url_canonical \
    '.connect.url == "https://api.averray.com/mcp"' \
    '.connect.url' \
  connect_client_config_url_canonical \
    '.connect.clientConfig.mcpServers.averray.url == "https://api.averray.com/mcp"' \
    '.connect.clientConfig' \
  install_npm_package \
    '.install.npm.package == "@averray/mcp"' \
    '.install.npm' \
  install_npm_command \
    '.install.npm.command == "npx -y @averray/mcp"' \
    '.install.npm' \
  install_cursor_deeplink \
    '.install.cursor.deeplink == "cursor://anysphere.cursor-deeplink/mcp/install?name=averray&config=eyJ1cmwiOiJodHRwczovL2FwaS5hdmVycmF5LmNvbS9tY3AifQ%3D%3D"' \
    '.install.cursor.deeplink' \
  install_cursor_client_config_url \
    '.install.cursor.clientConfig.mcpServers.averray.url == "https://api.averray.com/mcp"' \
    '.install.cursor.clientConfig' \
  install_claude_code_command \
    '.install.claudeCode.command == "claude mcp add --transport http averray https://api.averray.com/mcp"' \
    '.install.claudeCode' \
  install_claude_desktop_command \
    '.install.claudeDesktop.clientConfig.mcpServers.averray.command == "npx"' \
    '.install.claudeDesktop.clientConfig' \
  install_claude_desktop_args \
    '.install.claudeDesktop.clientConfig.mcpServers.averray.args == ["-y", "@averray/mcp"]' \
    '.install.claudeDesktop.clientConfig' \
  plain_http_alternative_method \
    '.plainHttpAlternative.method == "GET"' \
    '.plainHttpAlternative' \
  plain_http_alternative_path \
    '.plainHttpAlternative.path == "/verify/profiles"' \
    '.plainHttpAlternative' \
  plain_http_alternative_url \
    '.plainHttpAlternative.url == "https://api.averray.com/verify/profiles"' \
    '.plainHttpAlternative' || {
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
evaluate_clauses "DepositPool door" "$pool_json" "" \
  available \
    '.available == true' \
    '{available, reason}' || {
  echo "DepositPool door did not report available: true." >&2
  exit 1
}
evaluate_clauses "DepositPool door" "$pool_json" "" \
  depositor_risk_disclosure_exact \
    '.disclosure.statement == "Technical pilot. Principal at risk. No depositor protection."' \
    '.disclosure' || {
  echo "DepositPool door did not carry the exact depositor-risk disclosure." >&2
  exit 1
}
evaluate_clauses "DepositPool door" "$pool_json" "" \
  no_deposit_derived_daily_allowance \
    '[.. | objects | select(has("fromDeposits"))] | length == 0' \
    '[paths(objects) | select(.[-1] == "fromDeposits") | map(tostring) | join(".")]' || {
  echo "DepositPool door still exposes a deposit-derived daily allowance field." >&2
  exit 1
}
# Both documents via stdin (-s slurps them into an array): --argjson puts the
# whole JSON into execve argv, and a large /health payload can blow past
# ARG_MAX ("jq: Argument list too long", exit 126 — hit live 2026-08-01).
assert_clauses -s "DepositPool door vs /health" "$(printf '%s\n%s\n' "$pool_json" "$api_health_json")" \
  '.[0] as $pool | .[1] as $health |' \
  chain_id_matches_health \
    '$pool.chainId == $health.auth.chainId' \
    '{pool: $pool.chainId, health: $health.auth.chainId}'

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
  evaluate_clauses "CreditPool door" "$credit_json" "" \
    available \
      '.available == true' \
      '{available, reason}' || {
    echo "CreditPool door did not report available: true." >&2
    exit 1
  }
  # `| strings |` yields nothing for a missing field, so jq -e exits 4 (no
  # result) rather than 1 — still a failure, and the log names the field.
  evaluate_clauses "CreditPool door" "$credit_json" "" \
    wallet_l1_outstanding_raw_is_integer_string \
      '(.wallet.outstanding.raw | strings | test("^[0-9]+$"))' \
      '.wallet.outstanding' \
    wallet_l2_cash_outstanding_raw_is_integer_string \
      '(.receiptGraph.wallet.cash.outstanding.raw | strings | test("^[0-9]+$"))' \
      '.receiptGraph.wallet.cash' \
    wallet_l3_posting_outstanding_raw_is_integer_string \
      '(.receiptGraph.wallet.posting.outstanding.raw | strings | test("^[0-9]+$"))' \
      '.receiptGraph.wallet.posting' || {
    echo "CreditPool door did not return the wallet's L1/L2/L3 debt fields." >&2
    exit 1
  }
  evaluate_clauses "CreditPool door" "$credit_json" "" \
    depositor_risk_disclosure_exact \
      '.disclosure.statement == "Technical pilot. Principal at risk. No depositor protection."' \
      '.disclosure' || {
    echo "CreditPool door did not carry the exact depositor-risk disclosure." >&2
    exit 1
  }
  assert_clauses -s "CreditPool door vs /health" "$(printf '%s\n%s\n' "$credit_json" "$api_health_json")" \
    '.[0] as $credit | .[1] as $health |' \
    chain_id_matches_health \
      '$credit.chainId == $health.auth.chainId' \
      '{credit: $credit.chainId, health: $health.auth.chainId}' \
    credit_pool_address_matches_health \
      '(($credit.creditPool | ascii_downcase) == ($health.addresses.creditPool | ascii_downcase))? // false' \
      '{credit: $credit.creditPool, health: $health.addresses.creditPool}'
fi

echo "Checking onboarding contract"
onboarding_json="$(fetch "$API_ONBOARDING_URL")"
assert_clauses "Onboarding" "$onboarding_json" "" \
  name_present \
    '(.name | length > 0)? // false' \
    '.name' \
  http_protocol_listed \
    '(.protocols | index("http") != null)? // false' \
    '.protocols'
evaluate_clauses "Onboarding" "$onboarding_json" "" \
  no_retired_get_strategy_positions_tool \
    '(.tools | index("getStrategyPositions") == null)? // false' \
    '.tools' \
  no_retired_list_strategies_tool \
    '(.tools | index("listStrategies") == null)? // false' \
    '.tools' || {
  echo "Onboarding still advertises a retired strategy tool." >&2
  exit 1
}
evaluate_clauses "Onboarding" "$onboarding_json" "" \
  get_account_position_tool_listed \
    '(.tools | index("getAccountPosition") != null)? // false' \
    '.tools' \
  build_withdraw_transactions_tool_listed \
    '(.tools | index("buildWithdrawTransactions") != null)? // false' \
    '.tools' \
  withdraw_earnings_statement_names_dot_grant \
    '(.onboarding.withdrawEarnings.statement | contains("one-time first-withdrawal DOT grant"))? // false' \
    '.onboarding.withdrawEarnings.statement' \
  retention_not_gates_contract \
    '(.onboarding.withdrawEarnings.retentionNotGates | contains("never delays, conditions, prices, or adds steps"))? // false' \
    '.onboarding.withdrawEarnings.retentionNotGates' || {
  echo "Onboarding promises withdrawal without carrying the canonical earnings door and retention-not-gates contract." >&2
  exit 1
}

echo "Checking retired strategy surfaces point to the DepositPool"
strategies_json="$(fetch "$API_STRATEGIES_URL")"
assert_clauses "Retired /strategies" "$strategies_json" "" \
  status_retired \
    '.status == "retired"' \
    '.status' \
  retired_flag \
    '.retired == true' \
    '.retired' \
  strategies_empty \
    '.strategies == []' \
    '.strategies' \
  see_pool_points_to_deposit_pool \
    '.see.pool == "/pool"' \
    '.see' \
  see_onboarding_points_to_vested_capacity \
    '.see.onboarding == "/onboarding#buildVestedCapacity"' \
    '.see'

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
# Every clause here is our own contract, hard-gated. The live-derived ones
# (economics fee fields, claimBond, disputeWindow) are listed first so the
# first failing clause on a cold gateway is the one that names the cause.
poster_prelude='. as $poster | ([.flow[] | select(.id == "fund")][0]) as $fund |'
poster_onboarding_clauses=(
  protocol_fee_bps_is_number
    '(.economics.protocolFeeBps | type) == "number"'
    '.economics | {protocolFeeBps, availability}'
  poster_fee_bps_equals_protocol_fee_bps
    '.economics.posterFeeBps == .economics.protocolFeeBps'
    '.economics | {posterFeeBps, protocolFeeBps}'
  poster_fee_floor_raw_is_integer_string
    '(.economics.posterFeeFloorRaw | test("^[0-9]+$"))? // false'
    '.economics.posterFeeFloorRaw'
  fee_recipient_is_address
    '((.economics.feeRecipient | ascii_downcase) | test("^0x[0-9a-f]{40}$"))? // false'
    '.economics | {feeRecipient, availability}'
  claim_bond_available
    '.workerFacts.claimBond.available == true'
    '.workerFacts.claimBond'
  claim_bond_stake_bps_is_number
    '(.workerFacts.claimBond.stakeBps | type) == "number"'
    '.workerFacts.claimBond'
  claim_bond_fee_bps_is_number
    '(.workerFacts.claimBond.feeBps | type) == "number"'
    '.workerFacts.claimBond'
  claim_bond_min_fee_raw_is_integer_string
    '(.workerFacts.claimBond.minFeeRaw | test("^[0-9]+$"))? // false'
    '.workerFacts.claimBond'
  dispute_window_available
    '.workerFacts.disputeWindow.available == true'
    '.workerFacts.disputeWindow | {available, reason, seconds}'
  dispute_window_seconds_is_number
    '(.workerFacts.disputeWindow.seconds | type) == "number"'
    '.workerFacts.disputeWindow | {available, reason, seconds}'
  mode_open
    '.mode == "open"'
    '.mode'
  fee_semantics_poster_additive
    '.economics.feeSemantics == "poster_additive"'
    '.economics.feeSemantics'
  min_reward_usdc_positive
    '((.economics.minRewardUsdc | tonumber) > 0)? // false'
    '.economics.minRewardUsdc'
  draft_ttl_hours_is_number
    '(.economics.draftTtlHours | type) == "number"'
    '.economics.draftTtlHours'
  quote_persistence_demand_signal_only
    '.economics.quotePersistence == "demand_signal_only_until_funded"'
    '.economics.quotePersistence'
  quote_identity_poster_and_content_hash
    '.economics.quoteIdentity == "poster_and_content_hash"'
    '.economics.quoteIdentity'
  cancellation_contract
    '(if .cancellation.selfServeCancel == true then
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
      end)? // false'
    '{cancellation, escrowCore}'
  gas_policy_no_operator_brokered_gas
    '.workerFacts.gasPolicy.operatorBrokeredGas == false'
    '.workerFacts.gasPolicy'
  gas_policy_applies_to_all_external_jobs
    '.workerFacts.gasPolicy.appliesTo == "all externally posted jobs"'
    '.workerFacts.gasPolicy'
  dispute_remedy_on_chain_available
    '.workerFacts.disputeWindow.remedy.onChain.available == true'
    '.workerFacts.disputeWindow.remedy'
  dispute_remedy_on_chain_abi_fragment
    '.workerFacts.disputeWindow.remedy.onChain.abiFragment == "function openDispute(bytes32 jobId)"'
    '.workerFacts.disputeWindow.remedy.onChain'
  dispute_remedy_on_chain_address_is_escrow_core
    '((.workerFacts.disputeWindow.remedy.onChain.address | ascii_downcase) == (.escrowCore | ascii_downcase))? // false'
    '{remedyAddress: .workerFacts.disputeWindow.remedy.onChain.address, escrowCore}'
  dispute_remedy_brokered_path_unavailable
    '.workerFacts.disputeWindow.remedy.brokeredPath.available == false'
    '.workerFacts.disputeWindow.remedy.brokeredPath'
  dispute_remedy_brokered_path_reason
    '.workerFacts.disputeWindow.remedy.brokeredPath.reason == "no_worker_reachable_brokered_open_dispute_route"'
    '.workerFacts.disputeWindow.remedy.brokeredPath'
  fund_step_poster_reserved_raw_formula
    '$fund.posterReservedRawFormula == "rewardRaw + opsReserveRaw + contingencyReserveRaw + max(floor(rewardRaw * economics.posterFeeBps / 10000), economics.posterFeeFloorRaw)"'
    '$fund.posterReservedRawFormula'
  fund_step_deposit_amount_formula
    '$fund.depositAmountFormula == "max(posterReservedRaw - positions(poster, token).liquid, 0)"'
    '$fund.depositAmountFormula'
  fund_step_position_read_is_agent_account_core
    '(($fund.positionRead.address | ascii_downcase) == ($poster.agentAccountCore | ascii_downcase))? // false'
    '{positionRead: $fund.positionRead, agentAccountCore: $poster.agentAccountCore}'
  fund_step_approve_write_targets_token_for_agent_account_core
    '(any($fund.writes[];
      (.abiFragment == "function approve(address spender, uint256 amount) returns (bool)") and
      ((.address | ascii_downcase) == ($poster.token.address | ascii_downcase)) and
      ((.args[0] | ascii_downcase) == ($poster.agentAccountCore | ascii_downcase))))? // false'
    '{writes: $fund.writes, token: $poster.token.address, agentAccountCore: $poster.agentAccountCore}'
  fund_step_deposit_write_targets_agent_account_core_for_token
    '(any($fund.writes[];
      (.abiFragment == "function deposit(address asset, uint256 amount)") and
      ((.address | ascii_downcase) == ($poster.agentAccountCore | ascii_downcase)) and
      ((.args[0] | ascii_downcase) == ($poster.token.address | ascii_downcase))))? // false'
    '{writes: $fund.writes, token: $poster.token.address, agentAccountCore: $poster.agentAccountCore}'
)
poster_onboarding_json="$(fetch "$API_POSTER_ONBOARDING_URL")"
if ! evaluate_clauses "Poster onboarding" "$poster_onboarding_json" "$poster_prelude" "${poster_onboarding_clauses[@]}"; then
  # The structural clauses only get a second read when the document itself
  # says a live chain read is unavailable — poster_live_reads_unavailable
  # explains why that is the one warm-up condition that can clear on its own.
  if ! poster_live_reads_unavailable "$poster_onboarding_json"; then
    echo "Poster onboarding: refused on clause '$FAILED_CLAUSE'; the document reports no unavailable live chain read (live reads: $(describe_poster_live_reads "$poster_onboarding_json")), so this is a contract regression, not a warm-up transient — no re-fetch." >&2
    exit 1
  fi
  poster_first_snapshot_as_of="$(poster_snapshot_as_of "$poster_onboarding_json")"
  echo "  Poster onboarding: clause '$FAILED_CLAUSE' failed on a document whose live chain reads are unavailable ($(describe_poster_live_reads "$poster_onboarding_json"); snapshot asOf ${poster_first_snapshot_as_of}). The live-derived facts cannot be present until the chain gateway has warmed up after the deploy, so re-fetching ONCE in ${TRANSIENT_RECHECK_SLEEP_SEC}s."
  sleep "$TRANSIENT_RECHECK_SLEEP_SEC"
  poster_onboarding_json="$(fetch "$API_POSTER_ONBOARDING_URL")"
  if ! evaluate_clauses "Poster onboarding (re-fetch)" "$poster_onboarding_json" "$poster_prelude" "${poster_onboarding_clauses[@]}"; then
    poster_second_snapshot_as_of="$(poster_snapshot_as_of "$poster_onboarding_json")"
    echo "Poster onboarding: refused on clause '$FAILED_CLAUSE' after the single bounded re-fetch (live reads: $(describe_poster_live_reads "$poster_onboarding_json"); snapshot asOf ${poster_second_snapshot_as_of})." >&2
    if [[ "$poster_second_snapshot_as_of" == "$poster_first_snapshot_as_of" ]]; then
      echo "Both reads carried the same snapshot (asOf ${poster_first_snapshot_as_of}): the backend served its cached document again, so the re-fetch did not observe the gateway a second time. TRANSIENT_RECHECK_SLEEP_SEC must stay at or above the backend's POSTER_ONBOARDING_CACHE_MS." >&2
    fi
    exit 1
  fi
  echo "  poster onboarding clauses passed on the re-fetch; the live chain reads recovered (snapshot asOf $(poster_snapshot_as_of "$poster_onboarding_json"))."
fi

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
# Both documents via stdin (-s): a large /health payload on argv blew ARG_MAX
# live on 2026-08-01 (see evaluate_clauses).
assert_clauses -s "Poster onboarding vs /health" "$(printf '%s\n%s\n' "$poster_onboarding_json" "$api_health_json")" \
  '.[0] as $poster | .[1] as $health |' \
  chain_id_matches_health \
    '$poster.chainId == $health.auth.chainId' \
    '{poster: $poster.chainId, health: $health.auth.chainId}' \
  escrow_core_matches_health \
    '(($poster.escrowCore | ascii_downcase) == ($health.addresses.escrowCore | ascii_downcase))? // false' \
    '{poster: $poster.escrowCore, health: $health.addresses.escrowCore}' \
  agent_account_core_matches_health \
    '(($poster.agentAccountCore | ascii_downcase) == ($health.addresses.agentAccountCore | ascii_downcase))? // false' \
    '{poster: $poster.agentAccountCore, health: $health.addresses.agentAccountCore}' \
  token_matches_health \
    '(($poster.token.address | ascii_downcase) == ($health.addresses.token | ascii_downcase))? // false' \
    '{poster: $poster.token.address, health: $health.addresses.token}'
assert_clauses "Onboarding externalBounties" "$onboarding_json" "" \
  poster_onboarding_path \
    '.externalBounties.posterOnboarding == "/poster/onboarding"' \
    '.externalBounties.posterOnboarding' \
  cancellation_contract \
    '(if .externalBounties.cancellation.selfServeCancel == true then
        (.externalBounties.cancellation.method == "cancelOpenJob(bytes32)") and
        (.externalBounties.cancellation.minimumOpenSeconds == 3600)
      else
        (.externalBounties.cancellation.rescue == "operator-mediated on request, ~7 days, refunds only ever to the recorded poster") and
        (.externalBounties.cancellation.plannedSelfServeCancel == "cancelOpenJob, next EscrowCore deployment window")
      end)? // false' \
    '.externalBounties.cancellation' \
  claim_bond_available \
    '.externalBounties.claimBond.available == true' \
    '.externalBounties.claimBond' \
  dispute_window_available \
    '.externalBounties.disputeWindow.available == true' \
    '.externalBounties.disputeWindow | {available, reason}' \
  dispute_remedy_on_chain_available \
    '.externalBounties.disputeWindow.remedy.onChain.available == true' \
    '.externalBounties.disputeWindow.remedy' \
  dispute_remedy_on_chain_abi_fragment \
    '.externalBounties.disputeWindow.remedy.onChain.abiFragment == "function openDispute(bytes32 jobId)"' \
    '.externalBounties.disputeWindow.remedy.onChain' \
  dispute_remedy_brokered_path_reason \
    '.externalBounties.disputeWindow.remedy.brokeredPath.reason == "no_worker_reachable_brokered_open_dispute_route"' \
    '.externalBounties.disputeWindow.remedy.brokeredPath'

if [[ -n "$OPERATOR_TOKEN" ]]; then
  admin_status_json="$(fetch_admin_status_once)"
  # /admin/status is the largest payload in this script — never via argv (see above).
  assert_clauses -s "Poster onboarding vs /admin/status" "$(printf '%s\n%s\n' "$poster_onboarding_json" "$admin_status_json")" \
    '.[0] as $poster | .[1] as $operational |' \
    claim_bond_stake_bps_matches_policy \
      '$poster.workerFacts.claimBond.stakeBps == $operational.maintenance.policy.risk.defaultClaimStakeBps' \
      '{poster: $poster.workerFacts.claimBond.stakeBps, policy: $operational.maintenance.policy.risk.defaultClaimStakeBps}' \
    claim_bond_fee_bps_matches_policy \
      '$poster.workerFacts.claimBond.feeBps == $operational.maintenance.policy.risk.claimFeeBps' \
      '{poster: $poster.workerFacts.claimBond.feeBps, policy: $operational.maintenance.policy.risk.claimFeeBps}'
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

# Deploy checks for a redeployed indexer (root + /ready). Sync liveness is
# checked unconditionally above.
if enabled "$CHECK_INDEXER"; then
  echo "Checking indexer root"
  indexer_json="$(fetch "$INDEXER_URL")"
  assert_clauses "Indexer root" "$indexer_json" "" \
    status_ok \
      '.status == "ok"' \
      '.status'

  echo "Checking indexer readiness"
  fetch "$INDEXER_READY_URL" >/dev/null
else
  echo "CHECK_INDEXER=$CHECK_INDEXER set; skipping indexer deploy checks (root, ready)."
fi

if [[ -n "$OPERATOR_TOKEN" ]]; then
  echo "Checking admin async XCM status"
  admin_status_json="$(fetch_admin_status_once)"
  assert_clauses "Admin status" "$admin_status_json" "" \
    maintenance_policy_enabled \
      '.maintenance.policy.enabled == true' \
      '.maintenance.policy | {enabled}' \
    xcm_settlement_watcher_enabled \
      '.xcmSettlementWatcher.enabled == true' \
      '.xcmSettlementWatcher' \
    xcm_settlement_watcher_pending_count_non_negative \
      '(.xcmSettlementWatcher.pendingCount >= 0)? // false' \
      '.xcmSettlementWatcher'
  # `enabled` only proves the watcher was wired in at construction.
  # `running` proves the start() side actually ran and the polling
  # loop is alive — without it, pending observations queue up but
  # never settle. Closes the rc1 P0 row "Hosted /admin/status async
  # XCM smoke" by verifying the watcher lane is publishing, not just
  # configured. See docs/PROJECT_ROADMAP.md §"P0 Launch Gates".
  evaluate_clauses "Admin status" "$admin_status_json" "" \
    xcm_settlement_watcher_running \
      '.xcmSettlementWatcher.running == true' \
      '.xcmSettlementWatcher' || {
    echo "xcmSettlementWatcher.enabled is true but .running is false — settlement watcher loop is not alive; pending observations would not settle." >&2
    exit 1
  }
  assert_clauses "Admin status" "$admin_status_json" "" \
    xcm_observation_relay_is_object \
      '(.xcmObservationRelay | type) == "object"' \
      '.xcmObservationRelay' \
    xcm_observation_relay_enabled_is_boolean \
      '(.xcmObservationRelay.enabled | type) == "boolean"' \
      '.xcmObservationRelay'
  # When the observation relay is enabled, verify the polling loop is
  # alive AND the last poll was either a clean success (no lastError)
  # or hasn't happened yet (lastError null). A stale lastError after a
  # successful poll is cleared by the relay; a sticky lastError means
  # the upstream observer feed is broken from the backend's side.
  evaluate_clauses "Admin status" "$admin_status_json" "" \
    xcm_observation_relay_running_without_error_when_enabled \
      '.xcmObservationRelay.enabled == false or
      (
        .xcmObservationRelay.running == true and
        (.xcmObservationRelay.lastError == null or (.xcmObservationRelay.lastError | tostring | length) == 0)
      )' \
      '.xcmObservationRelay' || {
    echo "xcmObservationRelay is enabled but either not running, or its lastError is non-empty (upstream observer feed broken)." >&2
    exit 1
  }
  # Optional freshness gate. Skipped when the relay is disabled or
  # hasn't polled yet (lastSyncedAt null). Default 30 min — 2× a
  # 15-min poll interval gives the smoke headroom on a freshly-
  # restarted relay that hasn't ticked yet. Operators can tighten
  # via XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC if the deploy is
  # known to poll faster.
  evaluate_clauses --argjson maxAge "${XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC:-1800}" \
    "Admin status" "$admin_status_json" "" \
    xcm_observation_relay_last_synced_within_budget \
      '(.xcmObservationRelay.enabled == false or
      .xcmObservationRelay.lastSyncedAt == null or
      (
        .xcmObservationRelay.lastSyncedAt
        | sub("\\.[0-9]+Z$"; "Z")
        | fromdateiso8601 as $lastSynced
        | (now - $lastSynced) >= 0 and (now - $lastSynced) <= $maxAge
      ))? // false' \
      '{relay: .xcmObservationRelay, maxAgeSec: $maxAge, now: (now | todate)}' || {
    echo "xcmObservationRelay.lastSyncedAt is older than ${XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC:-1800}s — relay is not polling at the expected cadence." >&2
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
  assert_clauses "Bootstrap upstream status" "$admin_status_json" "" \
    enabled \
      '.upstreamStatus.enabled == true' \
      '.upstreamStatus | {enabled, running}' \
    running \
      '.upstreamStatus.running == true' \
      '.upstreamStatus | {enabled, running}' \
    interval_ms_is_number \
      '(.upstreamStatus.intervalMs | type) == "number"' \
      '.upstreamStatus.intervalMs' \
    interval_ms_within_one_day \
      '(.upstreamStatus.intervalMs <= 86400000)? // false' \
      '.upstreamStatus.intervalMs' \
    batch_size_is_number \
      '(.upstreamStatus.batchSize | type) == "number"' \
      '.upstreamStatus.batchSize' \
    batch_size_positive \
      '(.upstreamStatus.batchSize > 0)? // false' \
      '.upstreamStatus.batchSize' \
    evidence_persistence_note_is_string \
      '(.upstreamStatus.evidencePersistenceNote | type) == "string"' \
      '.upstreamStatus.evidencePersistenceNote' \
    last_run_null_or_object \
      '(.upstreamStatus.lastRun == null or (.upstreamStatus.lastRun | type) == "object")' \
      '.upstreamStatus.lastRun' \
    funded_jobs_is_object \
      '(.upstreamStatus.fundedJobs | type) == "object"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_total_records_is_number \
      '(.upstreamStatus.fundedJobs.totalRecords | type) == "number"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_open_records_is_number \
      '(.upstreamStatus.fundedJobs.openRecords | type) == "number"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_final_records_is_number \
      '(.upstreamStatus.fundedJobs.finalRecords | type) == "number"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_pollable_records_is_number \
      '(.upstreamStatus.fundedJobs.pollableRecords | type) == "number"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_awaiting_submission_records_is_number \
      '(.upstreamStatus.fundedJobs.awaitingSubmissionRecords | type) == "number"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_records_with_upstream_evidence_is_number \
      '(.upstreamStatus.fundedJobs.recordsWithUpstreamEvidence | type) == "number"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_by_final_status_is_object \
      '(.upstreamStatus.fundedJobs.byFinalStatus | type) == "object"' \
      '.upstreamStatus.fundedJobs' \
    funded_jobs_by_source_type_is_object \
      '(.upstreamStatus.fundedJobs.bySourceType | type) == "object"' \
      '.upstreamStatus.fundedJobs'
  assert_clauses "Bootstrap self-report" "$admin_status_json" "" \
    is_object \
      '(.bootstrapSelfReport | type) == "object"' \
      '.bootstrapSelfReport' \
    enabled_is_boolean \
      '(.bootstrapSelfReport.enabled | type) == "boolean"' \
      '.bootstrapSelfReport | {enabled}' \
    running_is_boolean \
      '(.bootstrapSelfReport.running | type) == "boolean"' \
      '.bootstrapSelfReport | {running}' \
    provider_configured_is_boolean \
      '(.bootstrapSelfReport.providerConfigured | type) == "boolean"' \
      '.bootstrapSelfReport | {providerConfigured}' \
    recipient_count_is_number \
      '(.bootstrapSelfReport.recipientCount | type) == "number"' \
      '.bootstrapSelfReport | {recipientCount}' \
    to_is_array \
      '(.bootstrapSelfReport.to | type) == "array"' \
      '.bootstrapSelfReport | {toType: (.to | type)}' \
    to_entries_are_nonempty_strings \
      '(all(.bootstrapSelfReport.to[]; type == "string" and length > 0))? // false' \
      '.bootstrapSelfReport | {toEntryTypes: [.to[]? | type], toEmptyEntries: ([.to[]? | select(type != "string" or length == 0)] | length)}' \
    running_on_a_weekly_or_faster_interval_when_enabled \
      '(.bootstrapSelfReport.enabled == false or
      (
        .bootstrapSelfReport.running == true and
        (.bootstrapSelfReport.intervalMs | type) == "number" and
        .bootstrapSelfReport.intervalMs <= 604800000
      ))? // false' \
      '.bootstrapSelfReport | {enabled, running, intervalMs}' \
    sender_and_recipients_present_when_provider_configured \
      '(.bootstrapSelfReport.providerConfigured == false or
      (
        (.bootstrapSelfReport.from | type) == "string" and
        (.bootstrapSelfReport.from | length) > 0 and
        .bootstrapSelfReport.recipientCount > 0 and
        .bootstrapSelfReport.recipientCount == (.bootstrapSelfReport.to | length)
      ))? // false' \
      '.bootstrapSelfReport | {providerConfigured, fromType: (.from | type), fromLength: (.from | length? // null), recipientCount, toLength: (.to | length? // null)}'
  evaluate_clauses "Bootstrap self-report" "$admin_status_json" "" \
    no_api_key_shaped_token \
      '(.bootstrapSelfReport | tostring | test("Bearer\\s+[^\\s,}\\]]+|re_[A-Za-z0-9_-]{12,}"; "i") | not)' \
      '"redacted: the status document matched an API-key-shaped token"' || {
    echo "Bootstrap self-report status appears to contain a provider/API key token." >&2
    exit 1
  }
  if [[ -n "$BOOTSTRAP_SELF_REPORT_EXPECTED_FROM" ]]; then
    assert_clauses --arg expectedFrom "$BOOTSTRAP_SELF_REPORT_EXPECTED_FROM" \
      "Bootstrap self-report" "$admin_status_json" "" \
      from_matches_expected_sender \
        '.bootstrapSelfReport.from == $expectedFrom' \
        '{fromType: (.bootstrapSelfReport.from | type), matchesExpected: (.bootstrapSelfReport.from == $expectedFrom)}'
  fi
  if [[ -n "$BOOTSTRAP_SELF_REPORT_EXPECTED_TO" ]]; then
    assert_clauses --arg expectedTo "$BOOTSTRAP_SELF_REPORT_EXPECTED_TO" \
      "Bootstrap self-report" "$admin_status_json" \
      '($expectedTo | split(",") | map(gsub("^\\s+|\\s+$"; "") | select(length > 0))) as $recipients |' \
      to_matches_expected_recipients \
        '.bootstrapSelfReport.to == $recipients' \
        '{toLength: (.bootstrapSelfReport.to | length? // null), expectedLength: ($recipients | length), matchesExpected: (.bootstrapSelfReport.to == $recipients)}'
  fi

  if enabled "$CHECK_BOOTSTRAP_SELF_REPORT_SENT"; then
    assert_clauses "Bootstrap self-report sent" "$admin_status_json" "" \
      last_attempted_at_is_string \
        '(.bootstrapSelfReport.lastAttemptedAt | type) == "string"' \
        '.bootstrapSelfReport.lastAttemptedAt' \
      last_attempted_at_is_iso8601 \
        '(.bootstrapSelfReport.lastAttemptedAt | test("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$"))? // false' \
        '.bootstrapSelfReport.lastAttemptedAt' \
      last_successful_at_is_string \
        '(.bootstrapSelfReport.lastSuccessfulAt | type) == "string"' \
        '.bootstrapSelfReport.lastSuccessfulAt' \
      last_successful_at_is_iso8601 \
        '(.bootstrapSelfReport.lastSuccessfulAt | test("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$"))? // false' \
        '.bootstrapSelfReport.lastSuccessfulAt' \
      last_run_status_sent \
        '.bootstrapSelfReport.lastRun.status == "sent"' \
        '.bootstrapSelfReport.lastRun | {status}' \
      last_run_provider_id_is_string \
        '(.bootstrapSelfReport.lastRun.email.providerId | type) == "string"' \
        '.bootstrapSelfReport.lastRun.email | {providerId}' \
      last_run_provider_id_nonempty \
        '((.bootstrapSelfReport.lastRun.email.providerId | length) > 0)? // false' \
        '.bootstrapSelfReport.lastRun.email | {providerId}'
    assert_clauses --argjson maxAge "$BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC" \
      "Bootstrap self-report sent" "$admin_status_json" "" \
      last_successful_at_within_max_age \
        '(.bootstrapSelfReport.lastSuccessfulAt
        | sub("\\.[0-9]+Z$"; "Z")
        | fromdateiso8601 as $lastSuccessful
        | (now - $lastSuccessful) >= 0 and (now - $lastSuccessful) <= $maxAge)? // false' \
        '{lastSuccessfulAt: .bootstrapSelfReport.lastSuccessfulAt, maxAgeSec: $maxAge, now: (now | todate)}'
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
  assert_clauses "Dispute verdict proof" "$dispute_proof_json" "" \
    mode_live \
      '.mode == "live"' \
      '.mode' \
    chain_status_confirmed_or_submitted \
      '(.response.chainStatus == "confirmed" or .response.chainStatus == "submitted")' \
      '.response | {chainStatus}' \
    tx_hash_is_string \
      '(.response.txHash | type) == "string"' \
      '.response | {txHash}' \
    tx_hash_is_32_bytes_hex \
      '(.response.txHash | test("^0x[a-fA-F0-9]{64}$"))? // false' \
      '.response | {txHash}' \
    persisted_status_resolved \
      '.persisted.status == "resolved"' \
      '.persisted | {status}' \
    persisted_reasoning_hash_matches_response \
      '.persisted.reasoningHash == .response.reasoningHash' \
      '{persisted: .persisted.reasoningHash, response: .response.reasoningHash}'
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
