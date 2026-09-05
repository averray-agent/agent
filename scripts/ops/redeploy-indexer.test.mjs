import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

test("redeploy-indexer names schema ownership failure and points to indexer_fresh_schema", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");
  const ownershipMatch = script.indexOf("was previously used by a different Ponder app");
  const actionableError = script.indexOf("Ponder schema ownership mismatch", ownershipMatch);
  const recovery = script.indexOf("indexer_fresh_schema=1", actionableError);
  const rawLogs = script.indexOf('printf \'%s\\n\' "$indexer_log"', recovery);

  assert.ok(ownershipMatch > 0, "the exact Ponder ownership refusal must be recognized");
  assert.ok(actionableError > ownershipMatch, "the refusal must emit a named one-line cause");
  assert.ok(recovery > actionableError, "the named cause must carry the recovery input");
  assert.ok(rawLogs > recovery, "the actionable diagnosis must appear before repeated raw logs");
  assert.match(
    script,
    /grep -E [^\n]+[\s\S]*?awk '!seen\[\$0\]\+\+'[\s\S]*?head -20/u,
    "the generic fatal summary must deduplicate repeated exception lines",
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
    /INDEXER_ENV_TEMPLATE=\$\{INDEXER_ENV_TEMPLATE:-"\$APP_ROOT\/deploy\/indexer\.env\.template"\}/u,
    "testnet remains the default rollback template for a direct component invocation",
  );
  assert.match(
    script,
    /local template="\$INDEXER_ENV_TEMPLATE"[\s\S]*?local target="\$INDEXER_ENV_TARGET"/u,
    "rollback must use the selected network's template and runtime env target",
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

test("a second indexer deploy is rejected before it can race the schema claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "redeploy-indexer-lock-"));
  const appRoot = join(root, "app");
  const fakeBin = join(root, "bin");
  const composeFile = join(root, "docker-compose.yml");
  const dockerCalled = join(root, "docker-called");
  const scriptPath = join(appRoot, "scripts/ops/redeploy-indexer.sh");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, ".git"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(composeFile, "services: {}\n");
  await writeFile(scriptPath, await readFile(REDEPLOY_SCRIPT));
  await chmod(scriptPath, 0o755);
  for (const command of ["git", "curl"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeExecutable(
    join(fakeBin, "docker"),
    `#!/usr/bin/env bash\ntouch "${dockerCalled}"\nexit 0\n`
  );
  // Simulates flock -n observing an already-held descriptor. The production
  // host uses util-linux flock; this fixture only controls that one result so
  // the rejection path is deterministic on macOS CI/developer machines too.
  await writeExecutable(join(fakeBin, "flock"), "#!/usr/bin/env bash\nexit 1\n");

  const result = spawnSync("bash", [scriptPath], {
    cwd: appRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      STACK_ROOT: root,
      COMPOSE_FILE: composeFile,
      INDEXER_SCHEMA_LOCK_FILE: join(root, "indexer.lock")
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Another indexer deployment owns the schema claim lock/u);
  assert.equal(
    existsSync(dockerCalled),
    false,
    "lock contention must be rejected before docker can recreate the indexer"
  );
});

test("rollback restores the exact last-good schema before recreating the indexer", async () => {
  const script = await readFile(REDEPLOY_SCRIPT, "utf8");
  const rollbackStart = script.indexOf("\nrollback() {");
  const rollbackEnd = script.indexOf("\n}", rollbackStart);
  const rollbackBody = script.slice(rollbackStart, rollbackEnd);
  const restoreIndex = rollbackBody.indexOf('restore_indexer_schema "$ROLLBACK_INDEXER_SCHEMA"');
  const composeIndex = rollbackBody.lastIndexOf("compose_up");

  assert.ok(restoreIndex > 0, "rollback should restore ROLLBACK_INDEXER_SCHEMA");
  assert.ok(composeIndex > restoreIndex, "schema restoration must happen before container recreation");
  assert.match(
    script,
    /performing schema-only rollback/u,
    "an env-only schema failure should recover even when PREVIOUS_SHA equals current HEAD"
  );
});

async function writeExecutable(path, content) {
  await writeFile(path, `${content}\n`);
  await chmod(path, 0o755);
}

test("Ponder boot timeout is named and same-build restart gets one 240s health budget", async () => {
  const fixture = await runFailedIndexerFixture();
  const output = fixture.result.stdout + fixture.result.stderr;
  assert.equal(fixture.result.status, 1, output);
  assert.match(output, /timeout 240s/u);
  assert.match(output, /indexer boot RPC probe timed out against https:\/\/eth-rpc.polkadot.io\//u);
  assert.match(output, /docs\/PACKET_INDEXER_RECREATED_EVERY_DEPLOY_SINGLE_RPC_BOOT.md/u);
  assert.doesNotMatch(output, /no known fatal-startup patterns/u);
  assert.match(output, /same-build restart/u);
  assert.doesNotMatch(output, /serving the previous build|Rollback succeeded/u);
  assert.equal(fixture.starts, 1, "same-build failure must not reset Ponder's probe progress");
  assert.equal(fixture.probes, 1, "fake clock must observe one 240s gate, not two hidden budgets");
});

test("different SHA or schema retains real rollback and previous-build wording", async () => {
  for (const changed of ["sha", "schema"]) {
    const fixture = await runFailedIndexerFixture(changed);
    const output = fixture.result.stdout + fixture.result.stderr;
    assert.equal(fixture.result.status, 1, output);
    assert.equal(fixture.starts, 2, "a true rollback recreates after restoring its target");
    assert.match(output, /Rollback succeeded; indexer is serving the previous build/u);
    assert.doesNotMatch(output, /same-build restart/u);
    assert.match(fixture.env, /DATABASE_SCHEMA=same_owner/u);
    if (changed === "sha") assert.match(output, /Working tree restored to old_sha/u);
    else assert.match(output, /performing schema-only rollback/u);
  }
});

async function runFailedIndexerFixture(changed = "none") {
  const root = await mkdtemp(join(tmpdir(), "indexer-boot-budget-"));
  const appRoot = join(root, "app");
  const fakeBin = join(root, "bin");
  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, ".git"));
  await mkdir(fakeBin);
  const scriptPath = join(appRoot, "scripts/ops/redeploy-indexer.sh");
  await writeExecutable(scriptPath, await readFile(REDEPLOY_SCRIPT, "utf8"));
  await writeFile(join(root, "compose.yml"), "services: {}\n");
  await writeFile(join(root, "indexer.env"), `DATABASE_SCHEMA=${changed === "schema" ? "new_owner" : "same_owner"}\n`);
  for (const [name, content] of Object.entries({ head: "new_sha", clock: "0", starts: "0", probes: "0" })) {
    await writeFile(join(root, name), content);
  }
  await writeExecutable(join(fakeBin, "git"), `#!/usr/bin/env bash
case "$*" in
  *"checkout --quiet"*) echo "\${@: -1}" > "$FIXTURE_ROOT/head" ;;
  *"rev-parse HEAD"*) cat "$FIXTURE_ROOT/head" ;;
esac`);
  await writeExecutable(join(fakeBin, "docker"), `#!/usr/bin/env bash
case "$*" in
  *"up -d"*) n=$(cat "$FIXTURE_ROOT/starts"); echo $((n + 1)) > "$FIXTURE_ROOT/starts" ;;
  *"logs --tail="*"indexer"*)
    echo 'WARN JSON-RPC request unexpectedly surpassed timeout chain=polkadotHubMainnet hostname=custom_transport'
    echo 'WARN All JSON-RPC providers are inactive action=rpc_diagnostic chain=polkadotHubMainnet'
    echo 'TimeoutError: The request took too long to respond.'
    echo 'URL: https://eth-rpc.polkadot.io/'
    echo 'Request body: {"method":"eth_chainId"}' ;;
esac`);
  await writeExecutable(join(fakeBin, "date"), `#!/usr/bin/env bash
n=$(cat "$FIXTURE_ROOT/clock"); echo "$n"; echo $((n + 120)) > "$FIXTURE_ROOT/clock"`);
  await writeExecutable(join(fakeBin, "curl"), `#!/usr/bin/env bash
n=$(cat "$FIXTURE_ROOT/probes"); echo $((n + 1)) > "$FIXTURE_ROOT/probes"
[[ $(cat "$FIXTURE_ROOT/starts") -ge 2 ]]`);
  for (const command of ["sleep", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0");
  }
  const result = spawnSync("bash", [scriptPath], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FIXTURE_ROOT: root,
      COMPOSE_FILE: join(root, "compose.yml"), INDEXER_ENV_TARGET: join(root, "indexer.env"),
      INDEXER_SCHEMA_LOCK_HELD: "1", INDEXER_SCHEMA_PREFLIGHTED: "1", INDEXER_BUILD_IMAGE: "0",
      SKIP_GIT_UPDATE: "1", PRE_DEPLOY_SHA: changed === "sha" ? "old_sha" : "new_sha",
      ROLLBACK_INDEXER_SCHEMA: "same_owner", WAIT_FOR_READY: "0" },
    encoding: "utf8", timeout: 10_000,
  });
  return { result, starts: Number(await readFile(join(root, "starts"), "utf8")),
    probes: Number(await readFile(join(root, "probes"), "utf8")), env: await readFile(join(root, "indexer.env"), "utf8") };
}
