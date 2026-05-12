#!/usr/bin/env bash
#
# render-vps-env.sh — atomic, fail-closed render of a deploy/*.env.template
# to a runtime env file on the VPS.
#
# Phase 2 PR 2.3 of the secrets migration:
# https://github.com/averray-agent/agent/blob/main/docs/SECRETS_MIGRATION.md
#
# This script runs ON THE VPS during deploy (wired in PR 2.4). It uses
# the per-runtime 1Password service-account token to resolve every
# `op://` reference in the template, writes the rendered output to a
# mktemp file, validates that no unresolved references remain, sets
# strict file permissions, and atomically moves the file into place.
#
# Failure semantics are STRICT and FAIL-CLOSED:
#   • op inject error → script exits non-zero, target file untouched
#   • Any unresolved op:// in the rendered output → exit non-zero
#   • mktemp / mv failure → exit non-zero
#   • The live runtime env file is NEVER replaced with a partial,
#     unvalidated, or empty file.
#
# The rendered content is NEVER printed to stdout, stderr, or any log.
# Diagnostic output is counts and byte lengths only.
#
# Usage:
#   render-vps-env.sh <template> <target> <token-file>
#
# Example (on VPS):
#   /srv/agent-stack/app/scripts/ops/render-vps-env.sh \
#     /srv/agent-stack/app/deploy/backend.env.template \
#     /run/agent-stack/backend.env \
#     /etc/agent-stack/op-backend.env
#
# Arguments:
#   template     Path to a deploy/*.env.template file. Must exist and
#                contain `op://` references resolvable by the token.
#   target       Final path of the rendered env file. Must be inside
#                /run/agent-stack/ (the tmpfs from systemd-tmpfiles).
#   token-file   Path to a file containing exactly:
#                  OP_SERVICE_ACCOUNT_TOKEN=ops_…
#                Must be mode 0400, owner root. Sourced with `set -a`
#                so the token enters this script's env briefly, then
#                is unset before exit.
#
# Exit codes:
#   0   render succeeded; target file in place with correct perms
#   1   render failed (template, op inject, validation, or mv error)
#   2   usage error (wrong args, missing files, target outside /run)

set -euo pipefail
set +x
umask 077

fail() {
  echo "render-vps-env.sh: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: render-vps-env.sh <template> <target> <token-file>

  template     deploy/*.env.template path
  target       /run/agent-stack/*.env path (must be inside /run/agent-stack)
  token-file   /etc/agent-stack/op-*.env path (mode 0400, root)

See SECRETS_MIGRATION.md Phase 2 PR 2.3 for the full design.
USAGE
  exit 2
}

[ "$#" -eq 3 ] || usage
template="$1"
target="$2"
token_file="$3"

# ── Pre-flight checks ──────────────────────────────────────────────────────

[ -f "$template" ] || fail "template not found: $template"
[ -f "$token_file" ] || fail "token file not found: $token_file"

# Verify token file permissions. We tolerate mode 0400 (root readable
# only) but reject anything wider. 1Password's docs note service tokens
# are vault-decryption capabilities — wider perms are a real risk.
token_mode=$(stat -c '%a' "$token_file" 2>/dev/null || stat -f '%A' "$token_file" 2>/dev/null || echo "?")
case "$token_mode" in
  400|0400) : ;;
  *) fail "token file $token_file has mode $token_mode; require 0400" ;;
esac

# Target MUST be inside /run/agent-stack to enforce the tmpfs invariant.
# This is a defense against an attacker who can call this script with a
# different target — they cannot redirect output to a persistent disk
# location like /tmp or /srv.
case "$target" in
  /run/agent-stack/*) : ;;
  *) fail "target $target is not inside /run/agent-stack; refusing to render" ;;
esac

# The runtime dir must exist (set up by systemd-tmpfiles at boot, or
# by `systemd-tmpfiles --create` after a config change).
runtime_dir=$(dirname "$target")
if [ ! -d "$runtime_dir" ]; then
  fail "$runtime_dir does not exist (did systemd-tmpfiles --create run?)"
fi

# Verify op CLI is installed.
if ! command -v op >/dev/null 2>&1; then
  fail "1Password CLI (op) not in PATH; run install-op-vps.sh"
fi

# ── Render ─────────────────────────────────────────────────────────────────

# mktemp alongside the target, so the atomic mv is on the same filesystem.
# `XXXXXX` is the tmpname suffix; trap cleans up on any exit path.
#
# NB: do NOT chmod 0400 the file here — op inject needs to write to it.
# The umask 077 at the top of the script ensures mktemp's default mode
# is 0600 (read+write only by the owning user) during the brief window
# between create and op inject's write. Final chmod 0400 happens AFTER
# op inject succeeds, just before the atomic mv into place.
tmp=$(mktemp "$runtime_dir/$(basename "$target").XXXXXX")
trap 'rm -f "$tmp"' EXIT

# Load the OP service-account token into this script's env. `set -a`
# exports without echoing the value. The token-file is sourced (NOT
# eval'd) so it must be strict KEY=VALUE lines only.
set -a
# shellcheck source=/dev/null
. "$token_file"
set +a

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  fail "OP_SERVICE_ACCOUNT_TOKEN not set after sourcing $token_file"
fi

# Refuse OP Connect config that would override the service-account
# token (1Password's docs note OP_CONNECT_* takes precedence).
if [ -n "${OP_CONNECT_HOST:-}" ] || [ -n "${OP_CONNECT_TOKEN:-}" ]; then
  unset OP_SERVICE_ACCOUNT_TOKEN
  fail "OP_CONNECT_HOST or OP_CONNECT_TOKEN is set; these take precedence over OP_SERVICE_ACCOUNT_TOKEN and create confusing behavior. Clear them in $token_file."
fi

# `--cache=false` ensures we always hit 1Password, never a stale local
# cache. Critical for deploy paths.
#
# Both stdout and stderr are captured to tmpfiles so they never leak
# rendered content or path information to the deploy log.
op_stdout=$(mktemp)
op_stderr=$(mktemp)
trap 'rm -f "$tmp" "$op_stdout" "$op_stderr"; unset OP_SERVICE_ACCOUNT_TOKEN' EXIT

if ! op inject --in-file "$template" --out-file "$tmp" --cache=false \
    >"$op_stdout" 2>"$op_stderr"; then
  echo "render-vps-env.sh: op inject failed:" >&2
  sed 's/^/    /' < "$op_stderr" >&2
  unset OP_SERVICE_ACCOUNT_TOKEN
  exit 1
fi

# Unset the token immediately after op inject — minimize its lifetime
# in this script's process env.
unset OP_SERVICE_ACCOUNT_TOKEN

# ── Validation ─────────────────────────────────────────────────────────────

# Fail-closed: any unresolved op:// substring is a hard error. op inject
# can return 0 even when a reference fails to resolve under some syntax
# conditions — re-check ourselves.
if grep -q 'op://' "$tmp"; then
  echo "render-vps-env.sh: rendered output still contains unresolved op:// references" >&2
  echo "                  (rendered file path withheld; inspect with KEEP_TMPFILE=1)" >&2
  exit 1
fi

# Sanity: rendered file must have at least one KEY=value line.
key_value_lines=$(grep -cE '^[A-Z][A-Z0-9_]*=' "$tmp" 2>/dev/null || echo 0)
if [ "$key_value_lines" -lt 1 ]; then
  fail "rendered file has zero KEY=value lines; aborting (template likely malformed)"
fi

# ── Install ────────────────────────────────────────────────────────────────

# Final permissions match the v3 plan: 0400, root-owned. The compose
# service that consumes this file MUST be readable by root at startup
# (Docker daemon runs as root). If compose runs as non-root, the chown
# needs adjustment — make that an explicit operator decision rather
# than a silent permission drift.
chmod 0400 "$tmp"
chown root:root "$tmp" 2>/dev/null || {
  # Non-root invocation: skip chown, log a note, continue. The file is
  # still 0400; only the owning user can read it.
  echo "render-vps-env.sh: warning: chown root:root failed (not running as root?); leaving file owned by $(id -un)" >&2
}

# Atomic mv on the same filesystem (tmp is in $runtime_dir, target is
# in $runtime_dir). The previous target, if it existed, is replaced
# atomically by the rename(2) syscall.
mv "$tmp" "$target"

# Clear EXIT trap — successful path, no cleanup needed.
trap - EXIT
rm -f "$op_stdout" "$op_stderr"

# ── Report ─────────────────────────────────────────────────────────────────
#
# Counts only, never values.
total_lines=$(wc -l < "$target" | tr -d ' ')
echo "render-vps-env.sh: rendered $target"
echo "    template:        $template"
echo "    total lines:     $total_lines"
echo "    KEY=value lines: $key_value_lines"
echo "    mode:            0400"
