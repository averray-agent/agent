#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
worker_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
harness_repo=${HARNESS_REPO:-"$HOME/repo/agent-harness"}
harness_bin=${HARNESS_BIN:-"$harness_repo/.venv/bin/harness"}
# Provider defaults to local; set HARNESS_ENV_PROVIDER=docker + HARNESS_ENV_IMAGE
# to exercise the isolated Docker path (Stage 2). The harness rejects the run if
# the container's NetworkMode is not "none", so a completed docker run proves it.
env_provider=${HARNESS_ENV_PROVIDER:-local}
env_image=${HARNESS_ENV_IMAGE:-}
postgres_port=${AVERRAY_WORKER_POSTGRES_PORT:-}
container_name="averray-worker-postgres-$$"
gate_tmp=$(mktemp -d "${TMPDIR:-/tmp}/averray-worker-integration.XXXXXX")
worker_pid=""
container_started=false

cleanup() {
  if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  if [ "$container_started" = true ]; then
    docker stop "$container_name" >/dev/null 2>&1 || true
  fi
  rm -rf "$gate_tmp"
}
trap cleanup EXIT HUP INT TERM

if [ ! -x "$harness_bin" ]; then
  echo "integration gate: harness executable not found: $harness_bin" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "integration gate: docker is required" >&2
  exit 2
fi
if [ ! -f "$harness_repo/tests/fixtures/model_scripts/finish.jsonl" ]; then
  echo "integration gate: harness scripted model fixture is missing" >&2
  exit 2
fi

# With no explicit port, let Docker bind an ephemeral host port atomically —
# a discover-then-bind probe races other processes for the same port.
if [ -n "$postgres_port" ]; then
  container_id=$(docker run --rm -d \
    --name "$container_name" \
    -p "127.0.0.1:$postgres_port:5432" \
    -e POSTGRES_PASSWORD=harness \
    -e POSTGRES_DB=postgres \
    postgres:18)
else
  container_id=$(docker run --rm -d \
    --name "$container_name" \
    -p 127.0.0.1::5432 \
    -e POSTGRES_PASSWORD=harness \
    -e POSTGRES_DB=postgres \
    postgres:18)
  postgres_port=$(docker port "$container_name" 5432/tcp | sed -n 's/.*://p' | head -1)
fi
container_started=true
if [ -z "$postgres_port" ]; then
  echo "integration gate: could not determine the Postgres host port" >&2
  exit 1
fi
echo "postgres_container=$container_id"
echo "postgres_port=$postgres_port"

attempt=0
until docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "integration gate: Postgres did not become ready" >&2
    exit 1
  fi
  sleep 0.5
done
echo "postgres_ready=true"

database_url="postgresql://postgres:harness@127.0.0.1:$postgres_port/postgres"
artifact_root="$gate_tmp/artifacts"
worker_log="$gate_tmp/worker.log"

run_harness() {
  (
    cd "$harness_repo"
    env \
      HARNESS_DATABASE_URL="$database_url" \
      HARNESS_PROFILES_ROOT="$worker_root/profiles" \
      HARNESS_ENV_PROVIDER="$env_provider" \
      ${env_image:+HARNESS_ENV_IMAGE="$env_image"} \
      HARNESS_MODEL_REF=scripted-model \
      HARNESS_MODEL_BASE_URL=http://localhost:11434/v1 \
      HARNESS_TEST_MODEL_SCRIPT="$harness_repo/tests/fixtures/model_scripts/finish.jsonl" \
      HARNESS_ARTIFACT_ROOT="$artifact_root" \
      "$harness_bin" "$@"
  )
}

run_harness db migrate

(
  cd "$harness_repo"
  exec env \
    HARNESS_DATABASE_URL="$database_url" \
    HARNESS_PROFILES_ROOT="$worker_root/profiles" \
    HARNESS_ENV_PROVIDER="$env_provider" \
    ${env_image:+HARNESS_ENV_IMAGE="$env_image"} \
    HARNESS_MODEL_REF=scripted-model \
    HARNESS_MODEL_BASE_URL=http://localhost:11434/v1 \
    HARNESS_TEST_MODEL_SCRIPT="$harness_repo/tests/fixtures/model_scripts/finish.jsonl" \
    HARNESS_ARTIFACT_ROOT="$artifact_root" \
    "$harness_bin" worker
) > "$worker_log" 2>&1 &
worker_pid=$!

attempt=0
until grep -q "worker ready" "$worker_log"; do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "integration gate: harness worker exited before readiness" >&2
    cat "$worker_log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 80 ]; then
    echo "integration gate: harness worker did not become ready" >&2
    cat "$worker_log" >&2
    exit 1
  fi
  sleep 0.25
done
echo "worker_ready=true"

run_id=$(run_harness run submit "$worker_root/examples/scripted-dry-run-intent.json")
echo "submitted_run_id=$run_id"

attempt=0
status_output=""
while :; do
  status_output=$(run_harness run status "$run_id")
  if printf '%s\n' "$status_output" | grep -q '^outcome='; then
    break
  fi
  if printf '%s\n' "$status_output" | grep -Eq '^state=(quarantined|cancelled)$'; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "integration gate: timed out waiting for a terminal outcome" >&2
    printf '%s\n' "$status_output" >&2
    exit 1
  fi
  sleep 0.5
done

printf '%s\n' "$status_output"
if ! printf '%s\n' "$status_output" | grep -q '^outcome=completed$'; then
  echo "integration gate: expected outcome=completed" >&2
  exit 1
fi
if ! printf '%s\n' "$status_output" | grep -q '^egress_policy=deny_all \[\]$'; then
  echo "integration gate: expected egress_policy=deny_all []" >&2
  exit 1
fi

# Self-verify which environment provider actually ran (reproduce, don't trust):
# the EnvironmentPrepared event records the provider the run really used.
environment_provider=$(run_harness run events "$run_id" \
  | sed -n 's/.*EnvironmentPrepared.*"provider":"\([a-z]*\)".*/\1/p' | head -1)
echo "environment_provider=$environment_provider"
if [ "$environment_provider" != "$env_provider" ]; then
  echo "integration gate: expected environment provider '$env_provider', ran '$environment_provider'" >&2
  exit 1
fi

deliverables_output=$(run_harness run deliverables "$run_id")
printf '%s\n' "$deliverables_output"
verification_uri=$(printf '%s\n' "$deliverables_output" | awk '$1 == "verification_report" { print $2; exit }')
if [ -z "$verification_uri" ]; then
  echo "integration gate: verification_report deliverable is missing" >&2
  exit 1
fi

report_path="$gate_tmp/verification-report.json"
run_harness artifacts get "$verification_uri" --out "$report_path"
printf 'verification_report='
cat "$report_path"
printf '\n'
node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (report.passed !== true) process.exit(1);
' "$report_path"
echo "scripted_dry_run=passed"
