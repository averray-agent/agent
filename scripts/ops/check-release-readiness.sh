#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
PROFILE="${1:-${PROFILE:-testnet}}"

RUN_FRONTEND_TESTS=${RUN_FRONTEND_TESTS:-1}
RUN_BACKEND_TESTS=${RUN_BACKEND_TESTS:-1}
RUN_SITE_BUILD=${RUN_SITE_BUILD:-1}
RUN_INDEXER_TYPECHECK=${RUN_INDEXER_TYPECHECK:-1}
RUN_CONTRACT_VERIFY=${RUN_CONTRACT_VERIFY:-1}
RUN_HOSTED_CHECK=${RUN_HOSTED_CHECK:-1}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

run_step() {
  local label="$1"
  shift
  echo
  echo "==> $label"
  "$@"
}

if [[ "$RUN_FRONTEND_TESTS" == "1" || "$RUN_BACKEND_TESTS" == "1" || "$RUN_SITE_BUILD" == "1" || "$RUN_INDEXER_TYPECHECK" == "1" ]]; then
  require_command npm
fi

if [[ "$RUN_CONTRACT_VERIFY" == "1" ]]; then
  require_command cast
  require_command jq
fi

if [[ "$RUN_HOSTED_CHECK" == "1" ]]; then
  require_command curl
  require_command jq
fi

echo "Release readiness profile: $PROFILE"

if [[ "$RUN_FRONTEND_TESTS" == "1" ]]; then
  run_step "Frontend tests" npm run test:frontend
fi

if [[ "$RUN_BACKEND_TESTS" == "1" ]]; then
  run_step "Backend tests" npm --workspace mcp-server test
fi

if [[ "$RUN_SITE_BUILD" == "1" ]]; then
  run_step "Public site build" npm run build:site
fi

if [[ "$RUN_INDEXER_TYPECHECK" == "1" ]]; then
  run_step "Indexer typecheck" npm run typecheck:indexer
fi

if [[ "$RUN_CONTRACT_VERIFY" == "1" ]]; then
  verify_args=("$PROFILE")
  if [[ "${ALLOW_PAUSED:-0}" == "1" ]]; then
    verify_args+=("--allow-paused")
  fi
  run_step "Contract deployment verification" "$APP_ROOT/scripts/verify_deployment.sh" "${verify_args[@]}"
fi

if [[ "$RUN_HOSTED_CHECK" == "1" ]]; then
  run_step "Hosted stack smoke check" "$APP_ROOT/scripts/ops/check-hosted-stack.sh"
fi

echo
echo "Release readiness checks passed."
