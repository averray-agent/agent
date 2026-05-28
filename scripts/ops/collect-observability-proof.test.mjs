import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "collect-observability-proof.sh"
);
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/hosted-observability-proof.yml"
);

async function writeExecutable(root, name, body) {
  const file = join(root, name);
  await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

test("collect-observability-proof emits sanitized hosted evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "observability-proof-"));
  const envFile = join(root, "backend.env");
  await writeFile(
    envFile,
    [
      "METRICS_BEARER_TOKEN=metrics-secret-token",
      "ALERT_WEBHOOK_URL=https://hooks.example.test/secret-webhook",
      "",
    ].join("\n"),
    "utf8"
  );

  const hostedCheck = await writeExecutable(root, "check-hosted-stack.sh", `
if [[ "\${CHECK_METRICS_AUTH:-}" != "1" ]]; then
  echo "missing metrics gate" >&2
  exit 1
fi
if [[ -z "\${METRICS_BEARER_TOKEN:-}" ]]; then
  echo "missing token" >&2
  exit 1
fi
echo "Hosted stack smoke check passed."
`);

  const alertWrapper = await writeExecutable(root, "check-hosted-stack-and-alert.sh", `
if [[ -z "\${ALERT_WEBHOOK_URL:-}" ]]; then
  echo "missing webhook" >&2
  exit 1
fi
echo "Alert sent to configured webhook." >&2
exit 1
`);

  const curl = await writeExecutable(root, "curl.sh", `
status=401
while [[ $# -gt 0 ]]; do
  case "$1" in
    -H)
      if [[ "$2" == authorization:* ]]; then
        status=200
      fi
      shift 2
      ;;
    --max-time|-o|-w)
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s' "$status"
`);

  const docker = await writeExecutable(root, "docker.sh", `
if [[ "$1" != "logs" ]]; then
  echo "unexpected docker command" >&2
  exit 1
fi
echo '{"level":30,"name":"averray-mcp","msg":"server.started","requestId":"req_123"}'
`);

  const { stdout } = await execFileAsync("bash", [scriptPath], {
    env: {
      ...process.env,
      BACKEND_ENV_FILE: envFile,
      STACK_ROOT: root,
      CHECK_HOSTED_STACK_SCRIPT: hostedCheck,
      ALERT_WRAPPER_SCRIPT: alertWrapper,
      CURL_BIN: curl,
      DOCKER_BIN: docker,
      OPERATOR_NAME: "CI",
      OPERATOR_SIGNATURE: "ci-proof",
      ALERT_CHANNEL: "ops-alerts",
      ALERT_CORRELATION_ID: "github-observability-alert-123",
    },
    timeout: 10_000,
  });

  const evidence = JSON.parse(stdout);
  assert.equal(evidence.schemaVersion, "observability-proof-v1");
  assert.equal(evidence.operator.name, "CI");
  assert.equal(evidence.metricsAuth.unauthenticatedStatus, 401);
  assert.equal(evidence.metricsAuth.authenticatedStatus, 200);
  assert.equal(evidence.alertDestination.messageId, "github-observability-alert-123");
  assert.equal(evidence.sentryLogging.decision, "log_only_deferred");
  assert.match(evidence.sentryLogging.observedLogLine, /server\.started/u);

  assert.doesNotMatch(stdout, /metrics-secret-token/u);
  assert.doesNotMatch(stdout, /secret-webhook/u);
});

test("collect-observability-proof fails closed without metrics token", async () => {
  const root = await mkdtemp(join(tmpdir(), "observability-proof-missing-"));
  const envFile = join(root, "backend.env");
  await writeFile(envFile, "ALERT_WEBHOOK_URL=https://hooks.example.test/secret-webhook\n", "utf8");

  await assert.rejects(
    () => execFileAsync("bash", [scriptPath], {
      env: {
        ...process.env,
        BACKEND_ENV_FILE: envFile,
      },
      timeout: 10_000,
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /METRICS_BEARER_TOKEN is missing/u);
      return true;
    }
  );
});

test("collect-observability-proof requires Sentry readiness when a DSN is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "observability-proof-sentry-"));
  const envFile = join(root, "backend.env");
  await writeFile(
    envFile,
    [
      "METRICS_BEARER_TOKEN=metrics-secret-token",
      "ALERT_WEBHOOK_URL=https://hooks.example.test/secret-webhook",
      "SENTRY_DSN=https://public@example.ingest.sentry.io/123",
      "",
    ].join("\n"),
    "utf8"
  );

  const hostedCheck = await writeExecutable(root, "check-hosted-stack.sh", 'echo "Hosted stack smoke check passed."');
  const alertWrapper = await writeExecutable(root, "check-hosted-stack-and-alert.sh", 'echo "Alert sent to configured webhook." >&2; exit 1');
  const curl = await writeExecutable(root, "curl.sh", `
status=401
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-H" && "$2" == authorization:* ]]; then
    status=200
  fi
  shift || true
done
printf '%s' "$status"
`);
  const docker = await writeExecutable(root, "docker.sh", 'echo \'{"level":30,"name":"averray-mcp","msg":"server.started"}\'');

  await assert.rejects(
    () => execFileAsync("bash", [scriptPath], {
      env: {
        ...process.env,
        BACKEND_ENV_FILE: envFile,
        STACK_ROOT: root,
        CHECK_HOSTED_STACK_SCRIPT: hostedCheck,
        ALERT_WRAPPER_SCRIPT: alertWrapper,
        CURL_BIN: curl,
        DOCKER_BIN: docker,
      },
      timeout: 10_000,
    }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /observability\.sentry_ready was not observed/u);
      assert.doesNotMatch(error.stderr, /example\.ingest\.sentry\.io/u);
      return true;
    }
  );
});

test("hosted observability proof workflow uses VPS runtime env and validates sanitized evidence", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /name: Hosted Observability Proof/u);
  assert.match(workflow, /OP_SERVICE_ACCOUNT_TOKEN_PROD_CI/u);
  assert.match(workflow, /VPS_SSH_KEY_OP: op:\/\/prod-ci\/vps-ssh-key\/private key/u);
  assert.match(workflow, /cd \/srv\/agent-stack\/app && \.\/scripts\/ops\/collect-observability-proof\.sh/u);
  assert.match(workflow, /ALERT_CORRELATION_ID: github-observability-alert-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(workflow, /check-observability-proof\.mjs/u);
  assert.match(workflow, /--max-completed-age-hours "\$MAX_COMPLETED_AGE_HOURS"/u);
  assert.doesNotMatch(workflow, /METRICS_BEARER_TOKEN:\s*\$\{\{ secrets\./u);
  assert.doesNotMatch(workflow, /ALERT_WEBHOOK_URL:\s*\$\{\{ secrets\./u);
});
