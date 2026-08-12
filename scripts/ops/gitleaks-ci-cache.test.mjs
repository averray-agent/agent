import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("gitleaks release delivery is version-keyed, cached, integrity-checked, and fail-closed", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const job = workflow.slice(
    workflow.indexOf("  secrets-scan:"),
    workflow.indexOf("\n  # The single roll-up gate")
  );

  assert.match(job, /GITLEAKS_VERSION:\s*"8\.30\.1"/u);
  assert.match(job, /GITLEAKS_TARBALL_SHA256:\s*"[a-f0-9]{64}"/u);
  assert.match(
    job,
    /uses: actions\/cache@[a-f0-9]{40}\s+# v4/u,
    "the cache action must be immutable-SHA pinned"
  );
  assert.match(job, /id:\s*gitleaks-cache/u);
  assert.match(
    job,
    /key:\s*gitleaks-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-v\$\{\{ env\.GITLEAKS_VERSION \}\}-\$\{\{ env\.GITLEAKS_TARBALL_SHA256 \}\}/u,
    "the cache key must change with platform, version, or published archive digest"
  );
  const cacheMissStart = job.indexOf(
    'if [ "${{ steps.gitleaks-cache.outputs.cache-hit }}" != "true" ]; then'
  );
  const cacheMissEnd = job.indexOf("\n          fi", cacheMissStart);
  const releaseDownload = job.indexOf("curl -fsSL", cacheMissStart);
  assert.ok(cacheMissStart >= 0, "the install must branch on an exact cache miss");
  assert.ok(
    releaseDownload > cacheMissStart && releaseDownload < cacheMissEnd,
    "the release CDN must only be called inside the cache-miss branch"
  );
  assert.match(job, /sha256sum --check/u, "cached and freshly downloaded archives must both be verified");
  assert.match(job, /gitleaks detect/u, "delivery hardening must not weaken or skip the scan");
});
