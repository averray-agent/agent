#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
TEMPLATE_PATH="${TEMPLATE_PATH:-$REPO_ROOT/deploy/Caddyfile.averray}"

usage() {
  cat <<'EOF'
Usage:
  APP_BASIC_AUTH_USER=operator APP_BASIC_AUTH_PASSWORD='secret' \
    ./scripts/ops/render-caddyfile.sh /path/to/output/Caddyfile

Optional env:
  TEMPLATE_PATH                 Override the source template
  APP_BASIC_AUTH_USER           Basic-auth username for app.averray.com
  APP_BASIC_AUTH_PASSWORD       Plaintext password; rendered as bcrypt hash
  APP_BASIC_AUTH_PASSWORD_HASH  Precomputed bcrypt hash; use instead of plaintext

If no APP_BASIC_AUTH_* values are provided, the rendered file keeps
app.averray.com public.
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

render_hash() {
  local plaintext="$1"
  if command -v caddy >/dev/null 2>&1; then
    caddy hash-password --plaintext "$plaintext"
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    docker run --rm caddy:2 caddy hash-password --plaintext "$plaintext"
    return
  fi

  fail "Need either 'caddy' or 'docker' installed to hash a basic-auth password"
}

[[ $# -eq 1 ]] || {
  usage >&2
  exit 1
}

OUTPUT_PATH="$1"
APP_BASIC_AUTH_USER="${APP_BASIC_AUTH_USER:-}"
APP_BASIC_AUTH_PASSWORD="${APP_BASIC_AUTH_PASSWORD:-}"
APP_BASIC_AUTH_PASSWORD_HASH="${APP_BASIC_AUTH_PASSWORD_HASH:-}"

[[ -f "$TEMPLATE_PATH" ]] || fail "Template not found: $TEMPLATE_PATH"
require_command awk

if [[ -n "$APP_BASIC_AUTH_PASSWORD" && -n "$APP_BASIC_AUTH_PASSWORD_HASH" ]]; then
  fail "Set either APP_BASIC_AUTH_PASSWORD or APP_BASIC_AUTH_PASSWORD_HASH, not both"
fi

auth_block_file=""
if [[ -n "$APP_BASIC_AUTH_USER" || -n "$APP_BASIC_AUTH_PASSWORD" || -n "$APP_BASIC_AUTH_PASSWORD_HASH" ]]; then
  [[ -n "$APP_BASIC_AUTH_USER" ]] || fail "APP_BASIC_AUTH_USER is required when enabling basic auth"

  if [[ -n "$APP_BASIC_AUTH_PASSWORD" ]]; then
    APP_BASIC_AUTH_PASSWORD_HASH="$(render_hash "$APP_BASIC_AUTH_PASSWORD")"
  fi

  [[ -n "$APP_BASIC_AUTH_PASSWORD_HASH" ]] || fail "APP_BASIC_AUTH_PASSWORD or APP_BASIC_AUTH_PASSWORD_HASH is required when enabling basic auth"

  auth_block_file=$(mktemp)
  cat >"$auth_block_file" <<EOF
  basic_auth bcrypt "Averray Operator" {
    $APP_BASIC_AUTH_USER $APP_BASIC_AUTH_PASSWORD_HASH
  }

EOF
fi

cleanup() {
  if [[ -n "$auth_block_file" && -f "$auth_block_file" ]]; then
    rm -f "$auth_block_file"
  fi
}

trap cleanup EXIT

awk -v auth_block_file="$auth_block_file" '
  /^app\.averray\.com \{/ {
    print
    if (length(auth_block_file) > 0) {
      while ((getline line < auth_block_file) > 0) {
        print line
      }
      close(auth_block_file)
    }
    next
  }
  { print }
' "$TEMPLATE_PATH" > "$OUTPUT_PATH"

echo "Rendered Caddyfile to $OUTPUT_PATH"
