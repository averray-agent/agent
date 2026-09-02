#!/usr/bin/env bash
#
# render-vps-env-all.sh — render every runtime env file (backend +
# indexer) from its in-repo template via 1Password.
#
# Thin wrapper around render-vps-env.sh. Iterates the known runtimes,
# renders each, exits 0 only if ALL renders succeed.
#
# Called from two places:
#   1. The agent-stack-env-render.service systemd unit at boot
#      (before docker.service starts)
#   2. Operator hands during ad-hoc maintenance (e.g., after rotating
#      a 1Password value out-of-band)
#
# The deploy pipeline's render_runtime_envs in deploy-production.sh
# does NOT call this script — it has additional logic (drift
# detection, force-recreate flags for changed env content) that
# doesn't apply at boot. Keep that logic in deploy-production.sh; this
# wrapper is the minimal "fill in the files" path.
#
# Failure semantics:
#   • render-vps-env.sh is fail-closed per-runtime — a failure of
#     either runtime aborts immediately with the underlying exit
#     status.
#   • Pre-flight checks (token files exist, template files exist,
#     /run/agent-stack/ exists) match the deploy-pipeline's
#     conditions so a boot-time failure mirrors what the deploy
#     would see.
#
# Usage (on VPS, typically via systemd as root):
#   sudo /srv/agent-stack/app/scripts/ops/render-vps-env-all.sh
#
# Exit codes:
#   0   every runtime rendered successfully
#   1   at least one render failed
#   2   pre-flight check failed (missing token / template / runtime dir)

set -euo pipefail
set +x
umask 077

APP_ROOT="${AGENT_STACK_APP_ROOT:-/srv/agent-stack/app}"
RUNTIME_DIR="${AGENT_STACK_RUNTIME_DIR:-/run/agent-stack}"
TOKEN_DIR="${AGENT_STACK_TOKEN_DIR:-/etc/agent-stack}"
RENDER_SCRIPT="$APP_ROOT/scripts/ops/render-vps-env.sh"
# Add new runtimes here as they're introduced. Each entry expands to a
# template at $APP_ROOT/deploy/<name>.env.template, a target at
# $RUNTIME_DIR/<name>.env, and a token at $TOKEN_DIR/op-<name>.env.
RUNTIMES=(backend indexer)

log()  { echo "render-vps-env-all.sh: $*"; }
fail() { echo "render-vps-env-all.sh: $*" >&2; exit "${2:-1}"; }

# ── Pre-flight ─────────────────────────────────────────────────────────────

[ -x "$RENDER_SCRIPT" ] || fail "render-vps-env.sh missing or not executable at $RENDER_SCRIPT" 2
[ -d "$RUNTIME_DIR" ]   || fail "$RUNTIME_DIR does not exist (install /etc/tmpfiles.d/agent-stack.conf and run systemd-tmpfiles --create)" 2

for runtime in "${RUNTIMES[@]}"; do
  template="$APP_ROOT/deploy/${runtime}.env.template"
  token="$TOKEN_DIR/op-${runtime}.env"
  [ -f "$template" ] || fail "missing template: $template" 2
  [ -f "$token" ]    || fail "missing op-token file: $token (drop the service-account token per SECRETS_MIGRATION.md)" 2
done

# ── Render each runtime ────────────────────────────────────────────────────

failed=()
for runtime in "${RUNTIMES[@]}"; do
  template="$APP_ROOT/deploy/${runtime}.env.template"
  target="$RUNTIME_DIR/${runtime}.env"
  token="$TOKEN_DIR/op-${runtime}.env"
  log "rendering $runtime: $template -> $target"
  if ! bash "$RENDER_SCRIPT" "$template" "$target" "$token"; then
    log "render FAILED for $runtime"
    failed+=("$runtime")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  fail "render failed for: ${failed[*]}"
fi

log "all renders succeeded: ${RUNTIMES[*]}"
exit 0
