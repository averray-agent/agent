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
RUN_SUBSCAN_XCM_VALIDATION=${RUN_SUBSCAN_XCM_VALIDATION:-0}

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

# Fail loudly when this gate references an npm script that does not exist.
# Without this, a renamed or mistyped script surfaces only as "Missing script"
# mid-run, and the tempting fix is to disable the step -- which silently drops
# that check from a release-readiness result that still reports green.
require_npm_script() {
  local script="$1"
  if ! node -e "process.exit((require('$APP_ROOT/package.json').scripts || {})['$script'] ? 0 : 1)" 2>/dev/null; then
    echo "check-release-readiness.sh references a missing npm script: $script" >&2
    echo "Correct the script name in this gate; do not disable the step." >&2
    exit 1
  fi
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

if [[ "$RUN_SUBSCAN_XCM_VALIDATION" == "1" ]]; then
  require_command node
fi

echo "Release readiness profile: $PROFILE"

if [[ "$RUN_FRONTEND_TESTS" == "1" ]]; then
  # `test:app` is the operator-app (frontend) suite declared in package.json.
  # There is no `test:frontend` script; calling it made this step fail with
  # "Missing script", which an operator could only clear by disabling the step
  # -- silently dropping frontend coverage from a release-readiness run.
  require_npm_script test:app
  run_step "Frontend tests" npm run test:app
fi

if [[ "$RUN_BACKEND_TESTS" == "1" ]]; then
  run_step "Backend tests" npm --workspace mcp-server test
fi

if [[ "$RUN_SITE_BUILD" == "1" ]]; then
  require_npm_script build:site
  run_step "Public site build" npm run build:site
fi

if [[ "$RUN_INDEXER_TYPECHECK" == "1" ]]; then
  require_npm_script typecheck:indexer
  run_step "Indexer typecheck" npm run typecheck:indexer
fi

if [[ "$RUN_CONTRACT_VERIFY" == "1" ]]; then
  verify_args=("$PROFILE")
  if [[ "${ALLOW_PAUSED:-0}" == "1" ]]; then
    verify_args+=("--allow-paused")
  fi
  if [[ "${REQUIRE_OWNER_RECORD_FINAL:-1}" == "1" ]]; then
    verify_args+=("--require-owner-record-final")
  fi
  run_step "Contract deployment verification" "$APP_ROOT/scripts/verify_deployment.sh" "${verify_args[@]}"
fi

if [[ "$RUN_HOSTED_CHECK" == "1" ]]; then
  run_step "Hosted stack smoke check" "$APP_ROOT/scripts/ops/check-hosted-stack.sh"
fi

if [[ "$RUN_SUBSCAN_XCM_VALIDATION" == "1" ]]; then
  run_step "Subscan XCM source validation" node "$APP_ROOT/scripts/ops/validate-subscan-xcm-source.mjs" --require-published
fi

echo
echo "Release readiness checks passed."
