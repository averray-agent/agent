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
  "check-hosted-stack-and-alert.sh"
);

async function makeStubScript(body) {
  const root = await mkdtemp(join(tmpdir(), "hosted-stack-alert-"));
  const stub = join(root, "check-hosted-stack-stub.sh");
  await writeFile(stub, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  await chmod(stub, 0o755);
  return stub;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function makeCurlCaptureScript() {
  const root = await mkdtemp(join(tmpdir(), "hosted-stack-alert-curl-"));
  const curl = join(root, "curl-capture.sh");
  const headersPath = join(root, "headers.txt");
  const payloadPath = join(root, "payload.json");
  const urlPath = join(root, "url.txt");

  await writeFile(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
payload=""
url=""
headers=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d)
      payload="$2"
      shift 2
      ;;
    -H)
      headers+=("$2")
      shift 2
      ;;
    --max-time)
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

printf '%s\\n' "$url" > ${shellQuote(urlPath)}
printf '%s\\n' "$payload" > ${shellQuote(payloadPath)}
printf '%s\\n' "\${headers[@]}" > ${shellQuote(headersPath)}
`,
    "utf8"
  );
  await chmod(curl, 0o755);

  return { curl, headersPath, payloadPath, urlPath };
}

async function runScript(env = {}) {
  try {
    const result = await execFileAsync(scriptPath, [], {
      env: {
        ...process.env,
        ...env,
      },
      timeout: 10_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("hosted stack alert wrapper exits cleanly when the smoke check passes", async () => {
  const stub = await makeStubScript('echo "hosted stack ok"');
  const result = await runScript({
    CHECK_HOSTED_STACK_SCRIPT: stub,
    ALERT_WEBHOOK_URL: "http://127.0.0.1:9/unused",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /hosted stack ok/);
  assert.equal(result.stderr, "");
});

test("hosted stack alert wrapper fails closed when no webhook is configured", async () => {
  const stub = await makeStubScript('echo "smoke failed"; echo "api down" >&2; exit 7');
  const result = await runScript({
    CHECK_HOSTED_STACK_SCRIPT: stub,
    ALERT_WEBHOOK_URL: "",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /smoke failed/);
  assert.match(result.stderr, /api down/);
  assert.match(result.stderr, /ALERT_WEBHOOK_URL is not set/);
});

test("hosted stack alert wrapper sends a structured webhook payload on failure", async () => {
  const stub = await makeStubScript('echo "smoke failed"; echo "indexer stale" >&2; exit 9');
  const curlCapture = await makeCurlCaptureScript();

  const result = await runScript({
    CHECK_HOSTED_STACK_SCRIPT: stub,
    ALERT_WEBHOOK_URL: "https://alerts.example.test/webhook",
    ALERT_SERVICE_NAME: "averray-smoke-test",
    ALERT_ENVIRONMENT: "ci",
    ALERT_CORRELATION_ID: "github-observability-alert-123",
    CURL_BIN: curlCapture.curl,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Alert sent to configured webhook/);

  const url = await readFile(curlCapture.urlPath, "utf8");
  assert.equal(url.trim(), "https://alerts.example.test/webhook");

  const headers = await readFile(curlCapture.headersPath, "utf8");
  assert.match(headers, /Content-Type: application\/json/);

  const body = await readFile(curlCapture.payloadPath, "utf8");
  const payload = JSON.parse(body);
  assert.equal(payload.status, "firing");
  assert.equal(
    payload.text,
    "averray-smoke-test smoke check failed in ci (correlation: github-observability-alert-123)"
  );
  assert.equal(payload.content, payload.text);
  assert.equal(payload.service, "averray-smoke-test");
  assert.equal(payload.environment, "ci");
  assert.equal(payload.correlationId, "github-observability-alert-123");
  assert.equal(payload.check, "scripts/ops/check-hosted-stack.sh");
  assert.equal(payload.summary, "Hosted stack smoke check failed");
  assert.match(payload.output, /smoke failed/);
  assert.match(payload.output, /indexer stale/);
  assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(body, /ALERT_WEBHOOK_URL|re_[A-Za-z0-9_-]{12,}/);
});
