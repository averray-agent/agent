import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REDEPLOY_SCRIPT = join(REPO_ROOT, "scripts/ops/redeploy-indexer.sh");

test("redeploy-indexer emits startup diagnostics before rollback", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");
  const healthFailure = script.indexOf('if ! wait_for_ok "$HEALTH_URL"');
  const diagnostics = script.indexOf("dump_indexer_diagnostics", healthFailure);
  const rollback = script.indexOf("rollback", diagnostics);

  assert.ok(healthFailure > 0, "health failure branch should exist");
  assert.ok(diagnostics > healthFailure, "failed container logs must be emitted after health failure");
  assert.ok(rollback > diagnostics, "failed container logs must be emitted before rollback");
  assert.match(
    script,
    /MigrationError/u,
    "diagnostics must identify Ponder schema ownership/build identity failures"
  );
});

// Structural tests for the rollback() function in redeploy-indexer.sh.
// Mirrors the test pattern in redeploy-backend.test.mjs (#467). The
// indexer's rollback flow has the same shape as the backend's — git
// checkout PREVIOUS_SHA then rebuild — and had the same two gaps:
//
//   1. No verification that `git checkout` actually moved HEAD.
//   2. No re-render of /run/agent-stack/indexer.env from the rolled-back
//      template — restoring just the code while leaving the new env in
//      place can produce mismatched runtime state.
//
// Both gaps are closed by this PR. The tests below lock in the fixes so
// a future refactor that drops a guard fails here rather than at the
// next failed indexer deploy.

test("redeploy-indexer rollback verifies git checkout actually moved HEAD", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // Pre-fix the rollback called `git checkout PREVIOUS_SHA` and trusted
  // the exit code alone. After #467 hardened the same gap in
  // redeploy-backend.sh, this PR adds the symmetric guard to the
  // indexer rollback — re-read HEAD post-checkout and bail if it
  // doesn't equal PREVIOUS_SHA.
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

test("redeploy-indexer rollback re-renders /run/agent-stack/indexer.env from the rolled-back template", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // Same class of bug that prevented the Phase 5a Stage 2C-3 backend
  // rollback from restoring health (closed for the backend in #467):
  // rollback() restored the code via `git checkout` but the wrapping
  // deploy had already rendered the new (smaller) env from the failed-
  // deploy's template. The old code on disk now saw an env it didn't
  // expect — health failed. Fix: rollback() must re-run
  // render-vps-env.sh against the rolled-back template before
  // compose_up.
  assert.match(
    script,
    /render_script="\$APP_ROOT\/scripts\/ops\/render-vps-env\.sh"/u,
    "rollback must reference scripts/ops/render-vps-env.sh",
  );
  assert.match(
    script,
    /template="\$APP_ROOT\/deploy\/indexer\.env\.template"/u,
    "rollback must use deploy/indexer.env.template (not backend.env.template) at the rolled-back SHA",
  );
  assert.match(
    script,
    /target="\/run\/agent-stack\/indexer\.env"/u,
    "rollback must re-render to /run/agent-stack/indexer.env (the runtime env_file:)",
  );
  assert.match(
    script,
    /sudo bash "\$render_script" "\$template" "\$target" "\$token"/u,
    "rollback must invoke render-vps-env.sh with (template, target, token) args",
  );
});

test("redeploy-indexer rollback re-render runs AFTER the git checkout and BEFORE compose_up", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // Ordering matters in both directions. If render runs before checkout,
  // the env is rendered from the still-broken (failed-deploy) template;
  // if it runs after compose_up, the container has already booted with
  // the mismatched env. Both invariants live in rollback()'s body.
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

test("redeploy-indexer rollback fails loudly when env re-render fails (rather than silently continuing)", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // Half-rolled-back state (code from PREVIOUS_SHA, env from failed
  // deploy) is the failure mode this PR is preventing. If the render
  // fails for any reason — op session expired, template syntax error,
  // sudo refused — bail loudly rather than continuing into compose_up.
  assert.match(
    script,
    /Rollback env re-render failed[\s\S]*?exit 1/u,
    "render failure inside rollback must exit non-zero, not fall through to compose_up",
  );
});

test("redeploy-indexer rollback documents the skip path for not-yet-bootstrapped VPS", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");

  // The forward-deploy render step in deploy-production.sh has skip-
  // clean conditions for a not-yet-bootstrapped VPS (missing render
  // script, missing op token, missing /run dir). The rollback's render
  // call mirrors those conditions; the skip is logged loudly so a
  // deployed VPS hitting it is visible to the operator.
  assert.match(
    script,
    /Rollback skipping env re-render/u,
    "rollback should log when it skips the env re-render (and why)",
  );
});
