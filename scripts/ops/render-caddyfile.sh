#!/usr/bin/env bash

set -euo pipefail
set +x

# render-caddyfile.sh — render deploy/Caddyfile.averray with basic-auth block.
#
# Phase 2 PR 2.2 hardening:
#   • REQUIRES the precomputed bcrypt hash. No in-script hashing.
#   • REFUSES to run if APP_BASIC_AUTH_PASSWORD (raw) is set in the env —
#     catches accidental fallback paths that would put the raw password
#     into shell args / ps output / journald.
#   • Raw passwords belong in `op://prod-critical/app-basic-auth` (human-only).
#     CI and the VPS only ever see the bcrypt HASH, which Caddy uses to
#     verify the password presented at HTTP basic-auth time.
#
# Backwards-incompat note: pre-PR-2.2 callers of this script could pass
# APP_BASIC_AUTH_PASSWORD as plaintext and have it hashed in-process by
# `caddy hash-password --plaintext`. That path is removed in this PR
# because it puts the raw password on the script's command line, visible
# in `ps -ef` for the duration of the call.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
TEMPLATE_PATH="${TEMPLATE_PATH:-$REPO_ROOT/deploy/Caddyfile.averray}"

usage() {
  cat <<'EOF'
Usage:
  APP_BASIC_AUTH_USER=operator \
  APP_BASIC_AUTH_PASSWORD_HASH='$2a$14$...' \
    ./scripts/ops/render-caddyfile.sh /path/to/output/Caddyfile

Required env (when basic-auth is enabled — set both, or neither):
  APP_BASIC_AUTH_USER           Basic-auth username for app.averray.com
  APP_BASIC_AUTH_PASSWORD_HASH  bcrypt hash of the raw password.
                                Generate with:
                                  printf '%s' "$RAW" | caddy hash-password --algorithm bcrypt

Rejected env (the script fails if this is set):
  APP_BASIC_AUTH_PASSWORD       Raw password. Removed in Phase 2 PR 2.2 —
                                raw passwords no longer flow through CI.
                                The raw lives only in op://prod-critical/app-basic-auth
                                (human-only) for operator browser-login.

Optional env:
  TEMPLATE_PATH                 Override the source template.

If neither APP_BASIC_AUTH_USER nor APP_BASIC_AUTH_PASSWORD_HASH is set,
the rendered file keeps app.averray.com public.
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

[[ $# -eq 1 ]] || {
  usage >&2
  exit 1
}

OUTPUT_PATH="$1"
APP_BASIC_AUTH_USER="${APP_BASIC_AUTH_USER:-}"
APP_BASIC_AUTH_PASSWORD_HASH="${APP_BASIC_AUTH_PASSWORD_HASH:-}"

# Hard reject — raw passwords MUST NOT enter this script.
if [[ -n "${APP_BASIC_AUTH_PASSWORD:-}" ]]; then
  fail "APP_BASIC_AUTH_PASSWORD (raw) is set, but Phase 2 PR 2.2 removed that code path. The raw password should live only in op://prod-critical/app-basic-auth. Pass APP_BASIC_AUTH_PASSWORD_HASH (bcrypt) instead — see usage."
fi

[[ -f "$TEMPLATE_PATH" ]] || fail "Template not found: $TEMPLATE_PATH"
require_command awk

# Basic-auth enabled requires BOTH user and hash. Half-set is an error.
if [[ -n "$APP_BASIC_AUTH_USER" || -n "$APP_BASIC_AUTH_PASSWORD_HASH" ]]; then
  [[ -n "$APP_BASIC_AUTH_USER" ]] || fail "APP_BASIC_AUTH_USER is required when APP_BASIC_AUTH_PASSWORD_HASH is set"
  [[ -n "$APP_BASIC_AUTH_PASSWORD_HASH" ]] || fail "APP_BASIC_AUTH_PASSWORD_HASH is required when APP_BASIC_AUTH_USER is set"

  # Sanity check: bcrypt hashes start with $2a$, $2b$, or $2y$.
  if ! [[ "$APP_BASIC_AUTH_PASSWORD_HASH" =~ ^\$2[aby]\$ ]]; then
    fail "APP_BASIC_AUTH_PASSWORD_HASH does not look like a bcrypt hash (expected leading \$2a\$, \$2b\$, or \$2y\$)"
  fi
fi

auth_block_file=""
if [[ -n "$APP_BASIC_AUTH_USER" && -n "$APP_BASIC_AUTH_PASSWORD_HASH" ]]; then
  auth_block_file=$(mktemp)
  cat >"$auth_block_file" <<EOF
  @protectedOperatorShell {
    not path /api/* /index/*
  }
  basic_auth @protectedOperatorShell bcrypt "Averray Operator" {
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
