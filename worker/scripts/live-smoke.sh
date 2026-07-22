#!/bin/sh
# Live smoke (operator-run): prove the worker end-to-end with a REAL model.
#
# Run this in the terminal where HARNESS_MODEL_API_KEY is exported. The key is
# read only from the environment, passed only to the harness process, and never
# printed. Do not add `set -x` to this script.
#
# Stage 1 (this script): a trusted, self-created fixture task on the local
# provider — a tiny repo with an off-by-one bug the model must fix so
# `node test.js` passes, with test.js broker-protected against tampering.
# This is deliberately a trusted/dev task: the local provider has no isolation,
# which is acceptable ONLY because the input is authored right here, not pulled
# from a public job. Real bounty jobs stay on the docker provider (see README).
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
worker_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
harness_repo=${HARNESS_REPO:-"$HOME/repo/agent-harness"}
harness_bin=${HARNESS_BIN:-"$harness_repo/.venv/bin/harness"}
postgres_port=${AVERRAY_WORKER_POSTGRES_PORT:-}
container_name="averray-worker-smoke-$$"
worker_pid=""
container_started=false

# The whole point of this smoke is a REAL model: never let a leftover scripted
# fixture hijack the run.
unset HARNESS_TEST_MODEL_SCRIPT

# --- model configuration (key is asserted present, never echoed) ---
: "${HARNESS_MODEL_API_KEY:?export HARNESS_MODEL_API_KEY in this terminal first (value is never printed)}"
: "${HARNESS_MODEL_REF:?export HARNESS_MODEL_REF (the executor model, e.g. an Ollama Cloud ref)}"
echo "model_ref=$HARNESS_MODEL_REF"
echo "model_base_url=${HARNESS_MODEL_BASE_URL:-adapter-default (https://ollama.com/v1)}"
echo "api_key=set (hidden)"

if [ ! -x "$harness_bin" ]; then
  echo "live smoke: harness executable not found: $harness_bin" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "live smoke: docker is required (disposable Postgres)" >&2
  exit 2
fi

# Retained after exit so the patch/report/summary can be inspected.
smoke_root=$(mktemp -d "${TMPDIR:-/tmp}/averray-worker-live-smoke.XXXXXX")
echo "smoke_output=$smoke_root"
worker_log="$smoke_root/harness-worker.log"
artifact_root="$smoke_root/artifacts"

cleanup() {
  if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  if [ "$container_started" = true ]; then
    docker stop "$container_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

# --- trusted fixture workspace: fail-before, model must make it pass-after ---
workspace="$smoke_root/workspace"
mkdir -p "$workspace"
cat > "$workspace/add.js" <<'EOF'
function add(a, b) {
  return a + b + 1;
}

module.exports = { add };
EOF
cat > "$workspace/test.js" <<'EOF'
const { add } = require("./add.js");

if (add(2, 3) !== 5) {
  console.error("add(2, 3) must equal 5");
  process.exit(1);
}
console.log("ok");
EOF
git -C "$workspace" init -q
git -C "$workspace" -c user.email=smoke@localhost -c user.name="live-smoke" add add.js test.js
git -C "$workspace" -c user.email=smoke@localhost -c user.name="live-smoke" commit -qm "fixture: off-by-one"
if (cd "$workspace" && node test.js >/dev/null 2>&1); then
  echo "live smoke: fixture must fail before the fix" >&2
  exit 2
fi
echo "fixture_fails_before=true"

cat > "$smoke_root/job.json" <<'EOF'
{
  "id": "live-smoke-add-off-by-one",
  "title": "Fix the off-by-one bug in add.js",
  "description": "add(2, 3) currently returns 6 because of an off-by-one in add.js. Fix add.js so that `node test.js` exits 0. Do not modify test.js.",
  "acceptanceCriteria": ["`node test.js` exits 0."],
  "agentInstructions": ["Edit add.js only.", "Keep the change minimal."],
  "verification": { "suggestedCheck": "node test.js" }
}
EOF

# Generate the intent through the real adapter, adding broker-level protection
# for test.js (the emit-intent CLI intentionally has no forbidden-paths flag).
node -e '
  const fs = require("node:fs");
  const { pathToFileURL } = require("node:url");
  const [adapterPath, jobPath, workspacePath, outPath] = process.argv.slice(1);
  import(pathToFileURL(adapterPath).href)
    .then(({ mapJobToTaskIntent, serializeIntent }) => {
      const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
      const { intent, warnings } = mapJobToTaskIntent(job, {
        workspacePath,
        forbiddenPaths: ["test.js"],
      });
      if (warnings.length > 0) {
        console.error(warnings.join("\n"));
        process.exit(3);
      }
      fs.writeFileSync(outPath, serializeIntent(intent));
    })
    .catch((error) => {
      console.error(error);
      process.exit(2);
    });
' "$worker_root/src/job-adapter.js" "$smoke_root/job.json" "$workspace" "$smoke_root/intent.json"

# --- disposable durable plane (dedicated DB; never shared) ---
if [ -z "$postgres_port" ]; then
  postgres_port=$(node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  ')
fi
docker run --rm -d \
  --name "$container_name" \
  -p "127.0.0.1:$postgres_port:5432" \
  -e POSTGRES_PASSWORD=harness \
  -e POSTGRES_DB=postgres \
  postgres:18 >/dev/null
container_started=true
echo "postgres_port=$postgres_port"

attempt=0
until docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "live smoke: Postgres did not become ready" >&2
    exit 1
  fi
  sleep 0.5
done

database_url="postgresql://postgres:harness@127.0.0.1:$postgres_port/postgres"

run_harness() {
  (
    cd "$harness_repo"
    env \
      HARNESS_DATABASE_URL="$database_url" \
      HARNESS_PROFILES_ROOT="$worker_root/profiles" \
      HARNESS_ENV_PROVIDER=local \
      HARNESS_ARTIFACT_ROOT="$artifact_root" \
      "$harness_bin" "$@"
  )
}

run_harness db migrate >/dev/null
run_harness validate "$smoke_root/intent.json"

(
  cd "$harness_repo"
  exec env \
    HARNESS_DATABASE_URL="$database_url" \
    HARNESS_PROFILES_ROOT="$worker_root/profiles" \
    HARNESS_ENV_PROVIDER=local \
    HARNESS_ARTIFACT_ROOT="$artifact_root" \
    "$harness_bin" worker
) > "$worker_log" 2>&1 &
worker_pid=$!

attempt=0
until grep -q "worker ready" "$worker_log"; do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "live smoke: harness worker exited before readiness" >&2
    cat "$worker_log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 80 ]; then
    echo "live smoke: harness worker did not become ready" >&2
    cat "$worker_log" >&2
    exit 1
  fi
  sleep 0.25
done
echo "worker_ready=true"

run_id=$(run_harness run submit "$smoke_root/intent.json")
echo "run_id=$run_id"

# Real model: allow up to ~10 minutes.
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
  if [ "$attempt" -ge 300 ]; then
    echo "live smoke: timed out waiting for a terminal outcome" >&2
    printf '%s\n' "$status_output" >&2
    run_harness run events "$run_id" | tail -20 >&2
    exit 1
  fi
  sleep 2
done

printf '%s\n' "$status_output"
if ! printf '%s\n' "$status_output" | grep -q '^outcome=completed$'; then
  echo "live smoke: expected outcome=completed — recent events follow" >&2
  run_harness run events "$run_id" | tail -25 >&2
  echo "live smoke: worker log tail follows" >&2
  tail -20 "$worker_log" >&2
  exit 1
fi

deliverables_output=$(run_harness run deliverables "$run_id")
printf '%s\n' "$deliverables_output"

fetch_deliverable() {
  uri=$(printf '%s\n' "$deliverables_output" | awk -v type="$1" '$1 == type { print $2; exit }')
  if [ -z "$uri" ]; then
    echo "live smoke: $1 deliverable is missing" >&2
    exit 1
  fi
  run_harness artifacts get "$uri" --out "$smoke_root/$2" >/dev/null
}

fetch_deliverable workspace_patch workspace.patch
fetch_deliverable verification_report verification-report.json
fetch_deliverable change_summary change-summary.txt

node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (report.passed !== true) {
    console.error("verification report did not pass:", JSON.stringify(report));
    process.exit(1);
  }
' "$smoke_root/verification-report.json"

if ! grep -q '^diff --git' "$smoke_root/workspace.patch"; then
  echo "live smoke: workspace patch is empty" >&2
  exit 1
fi
if grep -E '^diff --git a/test\.js b/test\.js' "$smoke_root/workspace.patch" >/dev/null; then
  echo "live smoke: patch modified the protected test.js" >&2
  exit 1
fi

echo "--- verification report ---"
cat "$smoke_root/verification-report.json"
echo ""
echo "--- change summary ---"
cat "$smoke_root/change-summary.txt"
echo ""
echo "--- workspace patch (head) ---"
head -40 "$smoke_root/workspace.patch"
echo ""
echo "live_smoke=passed"
echo "artifacts_kept_in=$smoke_root"
