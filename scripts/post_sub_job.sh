#!/usr/bin/env bash
#
# Helper for the sub-job escrow pattern (docs/patterns/sub-job-escrow.md).
# Posts a new job whose `parentSessionId` points back to an in-flight run
# the caller is currently working on. The sub-job id is deterministic:
#
#   sub-<first-8-of-parent>-<short-label>
#
# Requires a bearer token for an admin-role wallet (same auth as
# /admin/jobs).
#
# Example:
#   ./scripts/post_sub_job.sh \
#     --parent-session session-xyz \
#     --label summarise-inputs \
#     --category coding \
#     --reward 2 \
#     --api https://api.averray.com \
#     --token "$ADMIN_JWT"
set -euo pipefail

API_URL=""
TOKEN=""
PARENT_SESSION=""
LABEL=""
CATEGORY="coding"
TIER="starter"
REWARD=""
VERIFIER_MODE="benchmark"
VERIFIER_TERMS_JSON="[\"complete\",\"output\"]"
VERIFIER_MINIMUM_MATCHES=1
CLAIM_TTL=3600

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parent-session) PARENT_SESSION="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --category) CATEGORY="$2"; shift 2;;
    --tier) TIER="$2"; shift 2;;
    --reward) REWARD="$2"; shift 2;;
    --verifier-mode) VERIFIER_MODE="$2"; shift 2;;
    --verifier-terms) VERIFIER_TERMS_JSON="$2"; shift 2;;
    --verifier-min) VERIFIER_MINIMUM_MATCHES="$2"; shift 2;;
    --claim-ttl) CLAIM_TTL="$2"; shift 2;;
    --api) API_URL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }
[[ -n "$API_URL" ]] || fail "--api is required"
[[ -n "$TOKEN" ]] || fail "--token is required"
[[ -n "$PARENT_SESSION" ]] || fail "--parent-session is required"
[[ -n "$LABEL" ]] || fail "--label is required"
[[ -n "$REWARD" ]] || fail "--reward is required"

# Sub-job ids deliberately encode the parent's first 8 chars so dashboards
# can group a parent run's sub-jobs together at a glance.
parent_prefix="$(printf '%s' "$PARENT_SESSION" | tr -c 'a-zA-Z0-9' '-' | cut -c1-8)"
SUB_JOB_ID="sub-${parent_prefix}-${LABEL}"

API_URL="${API_URL%/}"
body=$(cat <<JSON
{
  "id": "$SUB_JOB_ID",
  "category": "$CATEGORY",
  "tier": "$TIER",
  "rewardAmount": $REWARD,
  "verifierMode": "$VERIFIER_MODE",
  "verifierTerms": $VERIFIER_TERMS_JSON,
  "verifierMinimumMatches": $VERIFIER_MINIMUM_MATCHES,
  "claimTtlSeconds": $CLAIM_TTL,
  "parentSessionId": "$PARENT_SESSION",
  "outputSchemaRef": "schema://jobs/sub-${CATEGORY}"
}
JSON
)

response=$(curl --silent --show-error --fail \
  -X POST "$API_URL/admin/jobs" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data "$body")

echo "$response"
