#!/usr/bin/env bash
#
# validate-env-render.sh — dry-run renderer + validator for Phase 2 env templates.
#
# Renders a deploy/*.env.template via `op inject` to a tmpfile, validates the
# output against the structural rules in deploy/secrets-inventory.md, and
# DELETES the rendered file before exit. The rendered content is never
# printed to stdout/stderr/log.
#
# Usage:
#   ./scripts/ops/validate-env-render.sh backend
#   ./scripts/ops/validate-env-render.sh indexer
#
# Environment:
#   OP_SERVICE_ACCOUNT_TOKEN  optional — if set, op inject uses this token
#                             instead of the local op CLI session. Lets you
#                             test under the same scoping the VPS will have.
#   STRICT=1                  refuse to render if any TODO(operator) marker
#                             remains in the template. Default: warn but
#                             allow. PR 2.3 cutover MUST run with STRICT=1.
#   KEEP_TMPFILE=1            (debug only) don't delete the rendered tmpfile.
#                             NEVER use in CI or shared environments.
#
# Exit codes:
#   0   render succeeded; all critical-nonempty values populated; no
#       unresolved op:// refs
#   1   render failed (op inject error, unresolved ref, missing critical
#       value, or, in STRICT mode, lingering TODO marker)
#   2   usage error
#
# Per the v3 plan in docs/SECRETS_MIGRATION.md §2 "atomic / fail-closed"
# render pattern: write to mktemp, validate, never print rendered content,
# trap-cleanup on any exit path.

set -euo pipefail
set +x
umask 077

usage() {
  cat >&2 <<'USAGE'
Usage: validate-env-render.sh <runtime>
   runtime: "backend" or "indexer"

Render deploy/<runtime>.env.template via `op inject`, validate the output
against deploy/secrets-inventory.md, then delete the rendered file.

Env vars:
  OP_SERVICE_ACCOUNT_TOKEN  Use a service-account token instead of the local
                            op session (lets you test under VPS-style scoping).
  STRICT=1                  Fail on TODO(operator) markers (required for PR 2.3).
  KEEP_TMPFILE=1            Debug only — don't delete the rendered file.
USAGE
  exit 2
}

[ "$#" -eq 1 ] || usage
runtime="$1"

case "$runtime" in
  backend|indexer) ;;
  *) echo "validate-env-render.sh: unknown runtime '$runtime'" >&2; usage ;;
esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
template="$repo_root/deploy/${runtime}.env.template"
inventory="$repo_root/deploy/secrets-inventory.md"

[ -f "$template" ] || { echo "validate-env-render.sh: missing template: $template" >&2; exit 1; }
[ -f "$inventory" ] || { echo "validate-env-render.sh: missing inventory: $inventory" >&2; exit 1; }

# Sanity check: op CLI present.
if ! command -v op >/dev/null 2>&1; then
  echo "validate-env-render.sh: 1Password CLI (op) not found in PATH" >&2
  echo "Install: brew install --cask 1password-cli" >&2
  exit 1
fi

# Sanity check: op session is usable (either OP_SERVICE_ACCOUNT_TOKEN or
# an active local session). We probe with a cheap read against a public
# field — `op vault list` is enough to surface an auth failure.
if ! op vault list >/dev/null 2>&1; then
  echo "validate-env-render.sh: op CLI is not authenticated" >&2
  echo "Either run 'eval \$(op signin)' or export OP_SERVICE_ACCOUNT_TOKEN." >&2
  exit 1
fi

# Tmpfile creation in a private dir we own. Trap-cleanup on every exit path.
tmpdir=$(mktemp -d -t validate-env-render.XXXXXX)
chmod 0700 "$tmpdir"
rendered="$tmpdir/${runtime}.env"

cleanup() {
  if [ "${KEEP_TMPFILE:-}" = "1" ]; then
    echo "validate-env-render.sh: KEEP_TMPFILE=1 — leaving $rendered" >&2
    echo "                       DELETE IT MANUALLY before doing anything else." >&2
  else
    [ -f "$rendered" ] && { dd if=/dev/urandom of="$rendered" bs=4096 count=1 conv=notrunc 2>/dev/null || true; rm -f "$rendered"; }
    rm -rf "$tmpdir"
  fi
}
trap cleanup EXIT

# STRICT-mode pre-check: refuse to render if the template still has
# TODO(operator) markers. PR 2.3 cutover must pass under STRICT=1.
if [ "${STRICT:-}" = "1" ]; then
  if grep -nE '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*=.*TODO\(operator\)' "$template" >/dev/null; then
    echo "validate-env-render.sh [STRICT]: template still has TODO(operator) markers:" >&2
    grep -nE '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*=.*TODO\(operator\)' "$template" | sed 's/^/    /' >&2
    echo "" >&2
    echo "Fill in the non-secret config values from the current /srv/agent-stack/${runtime}.env before merging the cutover PR." >&2
    exit 1
  fi
fi

# Render. `op inject` reads op:// references from the template and produces
# a fully-resolved env file. --cache=false ensures we always hit 1Password,
# never a stale local cache (CRITICAL for deploy paths).
#
# Both stdout (the resolved output path) and stderr (errors) are captured
# to a tmpfile. We never echo stdout to the terminal — even the path
# leaks unnecessary info. On failure, we print stderr only.
if ! op inject --in-file "$template" --out-file "$rendered" --cache=false \
    >"$tmpdir/op-inject.out" 2>"$tmpdir/op-inject.err"; then
  echo "validate-env-render.sh: op inject failed:" >&2
  sed 's/^/    /' < "$tmpdir/op-inject.err" >&2
  exit 1
fi
chmod 0400 "$rendered"

# Fail-closed: any unresolved op:// reference is a hard error. op inject
# returns 0 even if a reference fails to resolve under some conditions
# (e.g., placeholder syntax it doesn't recognize) — re-check ourselves.
if grep -q 'op://' "$rendered"; then
  echo "validate-env-render.sh: rendered output still contains unresolved op:// references" >&2
  echo "                       (not printing rendered content — inspect $rendered manually with KEEP_TMPFILE=1 if you must)" >&2
  exit 1
fi

# Critical-nonempty check. Pull the list from deploy/secrets-inventory.md
# rows that have "✅ yes" in the critical-nonempty column. The inventory
# is the source of truth; this script parses it instead of duplicating
# the list inline.
critical_vars=$(awk '
  /^\| `[A-Z][A-Z0-9_]*`[[:space:]]+\|/ {
    # row format: | `VAR_NAME` | op://... | <crit emoji> | owner | notes |
    match($0, /\| `[A-Z][A-Z0-9_]*` \|/)
    var = substr($0, RSTART+3, RLENGTH-5)  # strip "| `" prefix and "` |" suffix
    # split row on `|` and look at the critical-nonempty column (4th)
    n = split($0, cols, "|")
    if (n >= 4 && cols[4] ~ /yes/) print var
  }
' "$inventory")

missing_critical=""
while IFS= read -r var; do
  [ -z "$var" ] && continue
  # extract value without printing it: grep for `^VAR=` and check non-empty
  value_line=$(grep -E "^${var}=" "$rendered" || true)
  if [ -z "$value_line" ]; then
    missing_critical+="  - ${var} (declared critical-nonempty but not present in rendered output)
"
    continue
  fi
  # strip 'VAR=' prefix to get value length without revealing the value
  value_len=$(printf '%s' "${value_line#*=}" | wc -c | tr -d ' ')
  if [ "$value_len" -eq 0 ]; then
    missing_critical+="  - ${var} (declared critical-nonempty but rendered to empty)
"
  fi
done <<< "$critical_vars"

if [ -n "$missing_critical" ]; then
  echo "validate-env-render.sh: critical-nonempty variables failed:" >&2
  printf '%s' "$missing_critical" >&2
  exit 1
fi

# Final tally — counts only, never values.
total_lines=$(wc -l < "$rendered" | tr -d ' ')
secret_lines=$(grep -cE '^[A-Z][A-Z0-9_]*=' "$rendered" || true)

echo "validate-env-render.sh: $runtime template rendered cleanly"
echo "    template:           $template"
echo "    rendered (deleted): ${rendered##*/}"
echo "    total lines:        $total_lines"
echo "    KEY=value lines:    $secret_lines"
echo "    critical-nonempty:  $(printf '%s\n' "$critical_vars" | wc -l | tr -d ' ') vars validated"
[ "${STRICT:-}" = "1" ] && echo "    mode:               STRICT (TODO markers banned)" || echo "    mode:               permissive (TODO markers allowed)"
