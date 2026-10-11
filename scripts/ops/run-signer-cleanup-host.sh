#!/usr/bin/env bash
# Host-side maintenance boundary. Operator invokes via the hosted workflow only.
set -euo pipefail
STACK_ROOT=${STACK_ROOT:-/srv/agent-stack}
APP_ROOT="$STACK_ROOT/app"
RUN_ID=${CLEANUP_RUN_ID:?CLEANUP_RUN_ID required}
[[ "$RUN_ID" =~ ^[0-9]+-[0-9]+$ ]] || { echo 'Invalid cleanup run id' >&2; exit 1; }
COMMIT=${CLEANUP_COMMIT:-0}
RECOVER=${1:-}
LOCK_FILE=${DEPLOY_LOCK_FILE:-/tmp/averray-production-deploy.lock}
MARKER="$STACK_ROOT/.deploy-state/signer-cleanup-$RUN_ID.stopped"
WORKER="signer-cleanup-$RUN_ID"
selector="$APP_ROOT/scripts/ops/run-caddy-network-selection.sh"
state="$STACK_ROOT/.deploy-state/caddy-network-selection.json"
status=$(STACK_ROOT="$STACK_ROOT" "$selector" status --state "$state" --live-caddy "$STACK_ROOT/Caddyfile")
printf '%s' "$status" | jq -e '.consistent == true' >/dev/null
target=$(STACK_ROOT="$STACK_ROOT" "$selector" deploy-target --state "$state" --stack-root "$STACK_ROOT" --app-root "$APP_ROOT")
[[ $(printf '%s' "$target" | jq -er '.network') == mainnet ]] || { echo 'Not the mainnet deploy target'; exit 1; }
compose_file=$(printf '%s' "$target" | jq -er '.composeFile')
project=$(printf '%s' "$target" | jq -er '.projectDirectory')
service=$(printf '%s' "$target" | jq -er '.backendService')
container=$(printf '%s' "$target" | jq -er '.backendContainer')
compose=(sudo docker compose --project-directory "$project" -f "$compose_file")
signer=$(jq -er '.verifier' "$APP_ROOT/deployments/mainnet.json")
mounts=(-v "$APP_ROOT/scripts:/app/scripts:ro" -v "$APP_ROOT/deployments:/app/deployments:ro" -v "$APP_ROOT/mcp-server:/app/mcp-server:ro")
mode=(--profile mainnet --expected-signer "$signer")
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
nonce() {
  timeout 25s "${compose[@]}" run --rm --no-deps -T "${mounts[@]}" "$service" \
    sh -lc 'cd /app && node scripts/ops/signer-cleanup.mjs "$@" --nonce-check' sh "${mode[@]}"
}
diagnostics() {
  sudo docker inspect --format '{{json .State}}' "$container" || true
  sudo docker logs --tail 60 "$container" 2>&1 || true
}
health() {
  local end=$((SECONDS + 120)) body
  while (( SECONDS < end )); do
    body=$(curl --fail --silent --show-error --max-time 10 https://api.averray.com/health) || body='{}'
    if printf '%s' "$body" | jq -e '.rewardBank.readable == true' >/dev/null; then
      log 'health HTTP 200 rewardBank.readable=true'; return 0
    fi
    sleep 5
  done
  echo '::error::Backend health did not recover with readable reward bank'
  diagnostics; return 1
}
restart() {
  [[ -f "$MARKER" ]] || return 0
  # Kill the one-off BEFORE restarting keepers, including after a dropped SSH.
  sudo docker rm -f "$WORKER" >/dev/null 2>&1 || true
  log 'backend restart requested'
  "${compose[@]}" start "$service" || { diagnostics; return 1; }
  log 'backend started; signer nonce follows (may be busy again with live keepers)'
  nonce || log 'post-restart nonce busy/unavailable; see preceding evidence'
  if health; then rm -f "$MARKER"; else return 1; fi
}
if [[ "$RECOVER" == --recover ]]; then
  # The independent always-step must not race a still-running cleanup or deploy.
  [[ -f "$MARKER" ]] || { log 'no stopped marker; recovery is a no-op'; exit 0; }
  exec 9>"$LOCK_FILE"
  flock -w 960 9 || { echo '::error::Recovery could not acquire deploy lock'; exit 1; }
  restart
  exit
fi
[[ -z "$RECOVER" ]] || { echo 'Unknown host option'; exit 1; }
if [[ "$COMMIT" != 1 ]]; then
  # No lock, stop, KMS, or restart on the read-only path.
  "${compose[@]}" run --rm --no-deps -T "${mounts[@]}" "$service" \
    sh -lc 'cd /app && node scripts/ops/signer-cleanup.mjs "$@"' sh "${mode[@]}"
  exit
fi
[[ ${CLEANUP_PLAN_HASH:-} =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid expected plan hash'; exit 1; }
[[ ${CLEANUP_CONFIRM:-} == "CLEANUP ${CLEANUP_PLAN_HASH:0:12}" ]] || { echo 'Invalid confirmation'; exit 1; }
exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'Production deploy/cleanup lock held; refusing'; exit 1; }
log 'production deploy lock acquired'
until_nonce=$((SECONDS + 120))
while ! nonce; do
  if (( SECONDS >= until_nonce )); then echo 'Signer did not drain within 120s; backend left running'; exit 1; fi
  sleep 5
done
watchdog=''
finish() {
  local result=$?
  trap - EXIT INT TERM HUP
  [[ -z "$watchdog" ]] || kill "$watchdog" 2>/dev/null || true
  restart || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# Persist before stop, so even a broken SSH session between stop and trap setup
# is recoverable by the independent always-step.
touch "$MARKER"
log 'backend stopping; pre-stop idle nonce recorded above'
"${compose[@]}" stop --timeout 30 "$service"
log 'backend stopped'
# Independent hard stopped-window budget; timeout below handles the normal case.
# This child inherits the deploy lock until it has restarted the service.
(
  trap - EXIT INT TERM HUP
  sleep 900 & timer=$!
  trap 'kill "$timer" 2>/dev/null || true; exit 0' TERM INT HUP
  wait "$timer"
  log '::error::15-minute stopped-window watchdog fired; terminating cleanup'
  restart
) &
watchdog=$!
nonce # Close the drain-to-stop race. Busy => trap restarts; never sign.
mode+=(--commit --use-kms --expected-plan-hash "$CLEANUP_PLAN_HASH" --confirm "$CLEANUP_CONFIRM")
timeout --foreground --signal=TERM --kill-after=10s 840s "${compose[@]}" run --rm --no-deps -T \
  --name "$WORKER" -e AWS_PROFILE=averray-signer -e AWS_SDK_LOAD_CONFIG=1 "${mounts[@]}" "$service" \
  sh -lc 'cd /app && node scripts/ops/signer-cleanup.mjs "$@"' sh "${mode[@]}"
