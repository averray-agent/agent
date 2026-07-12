import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REDEPLOY_SCRIPT = join(REPO_ROOT, "scripts/ops/redeploy-backend.sh");

// Structural tests for the rollback() function's contract. These are
// not full integration tests (no docker / sudo / curl stubbing) — they
// verify that the SCRIPT contains the specific safeguards that the
// Phase 5a Stage 2C-3 outage post-mortem identified as missing. Any
// future refactor that drops one of these lines should fail loudly
// here rather than at the next failed deploy in production.

test("redeploy-backend rollback verifies git checkout actually moved HEAD", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // The pre-fix rollback called `git checkout PREVIOUS_SHA` and trusted
  // the exit code. The 2026-05-21 outage post-mortem showed HEAD still
  // pointing at the failed-deploy SHA after this function claimed to
  // have rolled back. The guard reads HEAD post-checkout and bails if
  // it doesn't equal PREVIOUS_SHA.
  assert.match(
    script,
    /git -C "\$APP_ROOT" rev-parse HEAD[\s\S]*?\$checked_out_head[\s\S]*?\$PREVIOUS_SHA/u,
    "rollback must re-read HEAD after `git checkout` and compare to PREVIOUS_SHA",
  );
  assert.match(
    script,
    /Rollback checkout did NOT move HEAD/u,
    "rollback must emit a loud error when HEAD doesn't match PREVIOUS_SHA",
  );
});

test("redeploy-backend rollback re-renders /run/agent-stack/backend.env from the rolled-back template", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // The actual root cause of the Phase 5a Stage 2C-3 outage rollback's
  // inability to restore health: rollback() restored the code via `git
  // checkout` but the wrapping deploy had already rendered the new
  // (smaller) /run/agent-stack/backend.env. The old code on disk now
  // saw an env it didn't expect — boot failed. Fix: rollback() must
  // re-run render-vps-env.sh against the rolled-back template before
  // compose_up.
  assert.match(
    script,
    /render_script="\$APP_ROOT\/scripts\/ops\/render-vps-env\.sh"/u,
    "rollback must reference scripts/ops/render-vps-env.sh",
  );
  assert.match(
    script,
    /template="\$APP_ROOT\/deploy\/backend\.env\.template"/u,
    "rollback must use deploy/backend.env.template at the rolled-back SHA",
  );
  assert.match(
    script,
    /target="\/run\/agent-stack\/backend\.env"/u,
    "rollback must re-render to /run/agent-stack/backend.env (the runtime env_file:)",
  );
  assert.match(
    script,
    /sudo bash "\$render_script" "\$template" "\$target" "\$token"/u,
    "rollback must invoke render-vps-env.sh with (template, target, token) args",
  );
});

test("redeploy-backend rollback re-render runs AFTER the git checkout and BEFORE compose_up", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // Ordering matters. If render runs before checkout, the env is
  // rendered from the still-broken (failed-deploy) template; if it
  // runs after compose_up, the container has already booted with the
  // mismatched env. Both invariants live in rollback()'s body, so the
  // structural test scopes to that function.
  const fnStart = script.indexOf("\nrollback() {");
  assert.notEqual(fnStart, -1, "rollback() function should exist");
  const fnEnd = script.indexOf("\n}", fnStart);
  assert.notEqual(fnEnd, -1, "rollback() should be closed by `}`");
  const fnBody = script.slice(fnStart, fnEnd);

  const checkoutIdx = fnBody.indexOf("git -C \"$APP_ROOT\" checkout --quiet \"$PREVIOUS_SHA\"");
  const renderIdx = fnBody.indexOf("sudo bash \"$render_script\"");
  // Use lastIndexOf so the match is the actual `compose_up` call near
  // the end of the function, not a comment mentioning it earlier.
  const composeUpIdx = fnBody.lastIndexOf("compose_up");

  assert.ok(checkoutIdx > 0, "rollback should contain the git checkout call");
  assert.ok(renderIdx > 0, "rollback should contain the render-vps-env.sh invocation");
  assert.ok(composeUpIdx > 0, "rollback should contain compose_up");
  assert.ok(
    checkoutIdx < renderIdx,
    "render-vps-env.sh must be invoked AFTER git checkout (so it reads the rolled-back template)",
  );
  assert.ok(
    renderIdx < composeUpIdx,
    "render-vps-env.sh must be invoked BEFORE compose_up (so the container picks up the rolled-back env)",
  );
});

test("redeploy-backend rollback fails loudly when env re-render fails (rather than silently continuing)", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // Half-rolled-back state (code from PREVIOUS_SHA, env from failed
  // deploy) is the failure mode we're trying to avoid. If the render
  // fails for any reason — op session expired, template syntax error,
  // sudo refused — bail loudly rather than continuing into compose_up.
  assert.match(
    script,
    /Rollback env re-render failed[\s\S]*?exit 1/u,
    "render failure inside rollback must exit non-zero, not fall through to compose_up",
  );
});

test("redeploy-backend rollback documents the skip path for not-yet-bootstrapped VPS", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // The forward-deploy render step in deploy-production.sh has skip-
  // clean conditions for a not-yet-bootstrapped VPS (missing
  // render-vps-env.sh, missing op token, missing /run dir). The
  // rollback's render call mirrors those conditions; here we just
  // make sure the skip is logged loudly so a deployed VPS hitting it
  // is visible to the operator.
  assert.match(
    script,
    /Rollback skipping env re-render/u,
    "rollback should log when it skips the env re-render (and why)",
  );
});

test("redeploy-backend runs the named badge receipt signer preflight before container replacement", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");
  const preflightIdx = script.indexOf("preflight-badge-receipt-signer.sh");
  const rebuildIdx = script.indexOf('echo "Rebuilding backend container"');

  assert.ok(preflightIdx > 0, "backend deploy must invoke the badge receipt signer preflight");
  assert.ok(rebuildIdx > preflightIdx, "preflight must run before container replacement");
  assert.match(script, /env -u PREFLIGHT_NO_SUDO/u, "production must not inherit the test sudo bypass");
  assert.match(script, /-u PREFLIGHT_EXPECTED_OWNER_MODE/u, "production must require root:root mode 0400");
  assert.match(script, /\/etc\/agent-stack\/aws-config/u);
  assert.match(script, /badge-receipt-signer-cert\.pem/u);
  assert.match(script, /badge-receipt-signer-key\.pem/u);
});
