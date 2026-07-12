import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_SCRIPT = join(REPO_ROOT, "scripts/ops/deploy-production.sh");
// DERIVE_SETTLEMENT_ENV_SCRIPT was removed in PR 2.6: deploy-production.sh
// no longer calls derive-settlement-env.mjs at runtime (the template carries
// the settlement values directly, and CI enforces drift via
// scripts/ops/check-template-matches-manifest.mjs).

test("deploy wrapper retries frontend after an earlier failed indexer deploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-production-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "app"), { recursive: true });
  await mkdir(join(appRoot, "indexer"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  await writeExecutable(join(appRoot, "scripts/ops/redeploy-indexer.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo indexer >> \"$DEPLOY_LOG\"",
    "if [[ \"${FAIL_INDEXER:-0}\" == \"1\" ]]; then exit 1; fi"
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-frontend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo frontend >> \"$DEPLOY_LOG\""
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-backend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo backend >> \"$DEPLOY_LOG\""
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/check-hosted-stack.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo smoke >> \"$DEPLOY_LOG\""
  ].join("\n"));
  await writeExecutable(join(appRoot, "scripts/ops/render-caddyfile.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo caddy-render >> \"$DEPLOY_LOG\""
  ].join("\n"));

  for (const command of ["docker", "curl", "npm", "flock"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  await writeFile(join(appRoot, "app/README.md"), "base app\n");
  await writeFile(join(appRoot, "indexer/README.md"), "base indexer\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "app/page.tsx"), "export default function Page() { return null; }\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "frontend change");
  const frontendSha = revParse(appRoot, "HEAD");

  const firstRun = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: frontendSha,
    DEPLOY_LOG: deployLog,
    FAIL_INDEXER: "1",
    RUN_INDEXER: "1",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });
  assert.equal(firstRun.status, 1);
  assert.match(await readFile(deployLog, "utf8"), /^indexer$/m);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal((await readFile(join(stateDir, "frontend.last-good"), "utf8")).trim(), baseSha);

  await writeFile(join(appRoot, "indexer/fix.ts"), "export const fixed = true;\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "indexer fix");
  const indexerFixSha = revParse(appRoot, "HEAD");
  await writeFile(deployLog, "");

  const secondRun = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: frontendSha,
    DEPLOY_NEW_SHA: indexerFixSha,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal((await readFile(join(stateDir, "frontend.last-good"), "utf8")).trim(), indexerFixSha);
});

test("root workspace lock changes do not restart the independently packaged indexer", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-indexer-gate-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "indexer"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);
  await writeExecutable(join(appRoot, "scripts/ops/redeploy-indexer.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "echo indexer >> \"$DEPLOY_LOG\""
  ].join("\n"));
  for (const command of ["docker", "curl", "npm", "flock", "jq"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  await writeFile(join(appRoot, "indexer/package.json"), '{"name":"indexer","dependencies":{}}\n');
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(
    join(appRoot, "package-lock.json"),
    '{"lockfileVersion":3,"packages":{"app/node_modules/canonicalize":{"version":"3.0.0"}}}\n'
  );
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "app dependency");
  const appDependencySha = revParse(appRoot, "HEAD");

  const env = (oldSha, newSha) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: oldSha,
    DEPLOY_NEW_SHA: newSha,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "auto",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  const appOnlyRun = runDeploy(appRoot, env(baseSha, appDependencySha));
  assert.equal(appOnlyRun.status, 0, appOnlyRun.stderr);
  assert.match(appOnlyRun.stdout, /Skipping indexer deploy/u);
  assert.equal(await readFile(deployLog, "utf8").catch(() => ""), "");

  await writeFile(
    join(appRoot, "indexer/package.json"),
    '{"name":"indexer","dependencies":{"ponder":"0.16.6"}}\n'
  );
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "indexer dependency");
  const indexerDependencySha = revParse(appRoot, "HEAD");

  const indexerRun = runDeploy(appRoot, env(appDependencySha, indexerDependencySha));
  assert.equal(indexerRun.status, 0, indexerRun.stderr);
  assert.match(await readFile(deployLog, "utf8"), /^indexer$/m);
});

test("deploy rebuilds and verifies the public site even when no site paths changed", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha } =
    await makeSiteFixture();

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_LOG: deployLog,
    FAKE_SERVED_DIR: join(appRoot, "site"),
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  // The deploy range only touches README.md — the retired path gate would
  // have skipped the build here, which is exactly how the 2026-06-28 stash
  // regression stayed live for 10 days.
  assert.match(await readFile(deployLog, "utf8"), /run build:site/u);
  assert.match(run.stdout, /Served .*\/ matches built site\/index\.html/u);
  assert.match(run.stdout, /Served .*\/console-stream\.js matches built site\/console-stream\.js/u);
  assert.equal((await readFile(join(stateDir, "site.last-good"), "utf8")).trim(), nextSha);
});

test("post-deploy site serve check fails closed when served bytes differ from the built site", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeSiteFixture();

  const staleDir = join(root, "stale-served");
  await mkdir(staleDir, { recursive: true });
  await writeFile(join(staleDir, "index.html"), "<title>Averray</title> stale pre-#409 copy\n");
  await writeFile(join(staleDir, "console-stream.js"), "// stale console stream\n");

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_LOG: deployLog,
    FAKE_SERVED_DIR: staleDir,
    SITE_SERVE_CHECK_ATTEMPTS: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not match the freshly built site\/index\.html/u);
});

test("frontend staleness detector seeds on first deploy and skips while frontend/ matches it", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  const env = (overrides) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0",
    ...overrides
  });

  // Docs-only range: the path gate would skip, but no build tree hash has
  // ever been recorded — the detector forces one build to seed it.
  const first = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: baseSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /no recorded frontend build tree hash/u);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  const seeded = (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim();
  assert.match(seeded, /^[0-9a-f]{64}$/u);

  // No-op redeploy with the build output still on disk: skip the rebuild.
  await writeFile(deployLog, "");
  const second = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: nextSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /matches the last recorded build tree hash/u);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal(
    (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim(),
    seeded
  );
});

test("frontend staleness detector force-rebuilds after an un-popped stash reverts the build output", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  const env = (overrides) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0",
    ...overrides
  });

  const first = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: baseSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(first.status, 0, first.stderr);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);

  // The 2026-06-28 incident, replayed: an ops rollback stashes the checkout
  // (untracked build output included) and never pops — frontend/ silently
  // reverts to the stale committed copies while the path gate sees nothing.
  git(appRoot, "stash", "push", "-u", "-m", "ops path-b backend rollback pre-state");
  assert.equal(
    (await readFile(join(appRoot, "frontend/index.html"), "utf8")).trim(),
    "stale committed operator shell"
  );

  await writeFile(deployLog, "");
  const second = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: nextSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /no longer matches the recorded last-build tree hash/u);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.equal(
    (await readFile(join(appRoot, "frontend/index.html"), "utf8")).trim(),
    "fresh operator build 1"
  );
});

test("frontend staleness detector fails closed when the hash tooling breaks", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  const brokenBin = join(root, "broken-bin");
  await mkdir(brokenBin, { recursive: true });
  await writeExecutable(join(brokenBin, "sha256sum"), "#!/usr/bin/env bash\nexit 1\n");
  const env = (overrides) => ({
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0",
    ...overrides
  });

  // Healthy first deploy seeds the recorded hash.
  const first = runDeploy(appRoot, env({ DEPLOY_OLD_SHA: baseSha, DEPLOY_NEW_SHA: nextSha }));
  assert.equal(first.status, 0, first.stderr);
  const seeded = (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim();

  // With sha256sum broken, the unhashable tree must force a rebuild
  // (fail-safe), and the deploy must then abort rather than record an
  // empty hash — recording it would make every later deploy claim a match
  // by comparing empty to empty.
  await writeFile(deployLog, "");
  const second = runDeploy(appRoot, env({
    PATH: `${brokenBin}:${fakeBin}:${process.env.PATH}`,
    DEPLOY_OLD_SHA: nextSha,
    DEPLOY_NEW_SHA: nextSha
  }));
  assert.equal(second.status, 1);
  assert.match(second.stdout, /could not compute the frontend tree hash/u);
  assert.match(await readFile(deployLog, "utf8"), /^frontend$/m);
  assert.match(second.stderr, /refusing to record it/u);
  assert.equal(
    (await readFile(join(stateDir, "frontend.built-tree-hash"), "utf8")).trim(),
    seeded
  );
});

test("RUN_FRONTEND=0 skips the frontend staleness detector loudly", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha, root } =
    await makeFrontendFixture();
  await writeFile(deployLog, "");

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(root, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_LOG: deployLog,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(await readFile(deployLog, "utf8"), /^frontend$/m);
  // Truth boundary: the escape hatch must say the disk check is off, not
  // just that the deploy step was skipped.
  assert.match(run.stdout, /frontend\/ disk staleness is also NOT checked/u);
});

test("docker node fallback persists product-proof evidence on the host", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");

  assert.match(
    script,
    /PRODUCT_PROOF_EVIDENCE_FILE="\$APP_ROOT\/\$PRODUCT_PROOF_EVIDENCE_FILE"/u,
    "relative evidence paths should be normalized before docker env propagation"
  );
  assert.match(
    script,
    /product_proof_evidence_dir="\$\(dirname "\$PRODUCT_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the host evidence directory"
  );
  assert.match(
    script,
    /mkdir -p "\$product_proof_evidence_dir"/u,
    "docker fallback should create the host evidence directory"
  );
  assert.match(
    script,
    /-v "\$product_proof_evidence_dir:\$product_proof_evidence_dir"/u,
    "docker fallback should mount the evidence directory at the same path"
  );
});

test("deploy wrapper can trigger a one-shot bootstrap self-report before smoke", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");

  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_SEND_NOW=\$\{BOOTSTRAP_SELF_REPORT_SEND_NOW:-0\}/u,
    "deploy wrapper should expose a fail-closed one-shot self-report toggle"
  );
  assert.match(
    script,
    /POST "\$api_base\/admin\/bootstrap-self-report\/send"/u,
    "one-shot trigger should use the admin self-report endpoint"
  );
  assert.match(
    script,
    /\.ok == true and\s+\.result\.status == "sent"/u,
    "one-shot trigger should require sent evidence before continuing"
  );
  const smokeIndex = script.indexOf('echo "Running hosted stack smoke check"');
  const triggerIndex = script.lastIndexOf("run_bootstrap_self_report_once", smokeIndex);
  assert.ok(
    triggerIndex > -1 && triggerIndex < smokeIndex,
    "one-shot trigger must run before the hosted smoke sent-evidence gate"
  );
});

test("indexer schema recovery persists across normal runtime-env renders", async () => {
  const script = await readFile(DEPLOY_SCRIPT, "utf8");
  const indexerTemplate = await readFile(join(REPO_ROOT, "deploy/indexer.env.template"), "utf8");

  assert.match(
    script,
    /INDEXER_ENV_FILE=\$\{INDEXER_ENV_FILE:-\/run\/agent-stack\/indexer\.env\}/u,
    "schema recovery should target the rendered /run indexer env"
  );
  assert.match(
    script,
    /INDEXER_SCHEMA_STATE_FILE=\$\{INDEXER_SCHEMA_STATE_FILE:-"\$DEPLOY_STATE_DIR\/indexer\.database-schema"\}/u,
    "schema recovery should have a persistent deploy-state file"
  );
  assert.match(
    script,
    /write_persisted_indexer_schema "\$target_schema"/u,
    "explicit or fresh schema overrides should persist for the next normal deploy"
  );
  assert.match(
    script,
    /Reapplying persisted indexer DATABASE_SCHEMA override/u,
    "normal deploys should reapply a persisted schema override after rendering the template"
  );
  assert.match(
    script,
    /render_runtime_envs\s+apply_indexer_database_schema/u,
    "schema override must run after op inject renders /run env files"
  );
  assert.match(
    indexerTemplate,
    /^DATABASE_SCHEMA=agent_indexer_20260516080108$/m,
    "the template should match the known-good production Ponder schema"
  );
});

test("deploy wrapper freezes contract surface changes without a manifest update", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha } = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore {}\n");
    },
    "contract surface change"
  );

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /D-03 contract compatibility freeze: refusing production deploy/u);
  assert.match(run.stderr, /contracts\/AgentAccountCore\.sol/u);
  assert.match(run.stderr, /deployments\/testnet\.json did not change/u);
});

test("deploy wrapper allows contract surface changes when the deployment manifest moves with them", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha } = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "contracts"), { recursive: true });
      await mkdir(join(appRoot, "deployments"), { recursive: true });
      await writeFile(join(appRoot, "contracts/AgentAccountCore.sol"), "contract AgentAccountCore {}\n");
      await writeFile(join(appRoot, "deployments/testnet.json"), '{"contracts":{"agentAccountCore":"0x0000000000000000000000000000000000000001"}}\n');
    },
    "contract surface plus manifest"
  );

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /contract-surface changes are paired with deployments\/testnet\.json; allowing deploy/u);
});

test("deploy wrapper exposes an explicit contract surface drift override", async () => {
  const { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha } = await makeDeployFreezeFixture(
    async (appRoot) => {
      await mkdir(join(appRoot, "mcp-server/src/blockchain"), { recursive: true });
      await writeFile(join(appRoot, "mcp-server/src/blockchain/abis.js"), "export const ABI = [];\n");
    },
    "backend contract abi change"
  );

  const run = runDeploy(appRoot, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    STACK_ROOT: stackRoot,
    COMPOSE_FILE: join(stackRoot, "docker-compose.yml"),
    DEPLOY_LOCK_FILE: join(appRoot, "deploy.lock"),
    DEPLOY_STATE_DIR: stateDir,
    DEPLOY_OLD_SHA: baseSha,
    DEPLOY_NEW_SHA: nextSha,
    DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT: "1",
    RUN_BACKEND: "0",
    RUN_INDEXER: "0",
    RUN_FRONTEND: "0",
    RUN_SITE: "0",
    RUN_CADDY: "0",
    RUN_SMOKE: "0"
  });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /D-03 contract compatibility freeze override set/u);
  assert.match(run.stdout, /mcp-server\/src\/blockchain\/abis\.js/u);
});

test("deploy workflow wires the D-03 contract surface override as manual-only", async () => {
  const workflow = await readFile(join(REPO_ROOT, ".github/workflows/deploy-production.yml"), "utf8");

  assert.match(
    workflow,
    /allow_contract_surface_drift:/u,
    "workflow_dispatch should expose a named D-03 override"
  );
  assert.match(
    workflow,
    /DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*inputs\.allow_contract_surface_drift\s*\|\|\s*'0'\s*\}\}/u,
    "automatic workflow_run deploys must leave the contract-surface drift override disabled"
  );
  assert.match(
    workflow,
    /printf 'APP_BASIC_AUTH_USER=.*DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT=%q /u,
    "the manual override must be forwarded through the SSH remote_env wrapper"
  );
  assert.match(
    workflow,
    /"\$DEPLOY_ALLOW_CONTRACT_SURFACE_DRIFT"/u,
    "remote_env must include the evaluated override value"
  );
});

async function writeExecutable(path, content) {
  await writeFile(path, `${content}\n`);
  await chmod(path, 0o755);
}

// Sandbox for the always-build site path: committed site/ files stand in
// for the build output (the fake npm only logs), and the fake curl serves
// bytes from $FAKE_SERVED_DIR so tests control what "Caddy" returns.
async function makeSiteFixture() {
  const root = await mkdtemp(join(tmpdir(), "deploy-site-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "site"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  for (const command of ["docker", "flock", "jq"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  await writeExecutable(join(fakeBin, "npm"), [
    "#!/usr/bin/env bash",
    "echo \"npm $*\" >> \"$DEPLOY_LOG\"",
    "exit 0"
  ].join("\n"));
  await writeExecutable(join(fakeBin, "curl"), [
    "#!/usr/bin/env bash",
    "# fake file_server: honours `-o <file> <url>`, serving from $FAKE_SERVED_DIR",
    "out=\"\"",
    "url=\"\"",
    "args=(\"$@\")",
    "for ((i=0; i<${#args[@]}; i++)); do",
    "  case \"${args[i]}\" in",
    "    -o|-H|--max-time) ((i+=1)); [[ \"${args[i-1]}\" == \"-o\" ]] && out=\"${args[i]}\" ;;",
    "    -*) ;;",
    "    *) url=\"${args[i]}\" ;;",
    "  esac",
    "done",
    "name=index.html",
    "case \"$url\" in */console-stream.js) name=console-stream.js ;; esac",
    "if [[ -n \"$out\" && -n \"${FAKE_SERVED_DIR:-}\" ]]; then",
    "  cp \"$FAKE_SERVED_DIR/$name\" \"$out\"",
    "fi",
    "exit 0"
  ].join("\n"));

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  await writeFile(join(appRoot, "site/index.html"), "<title>Averray</title> fresh build\n");
  await writeFile(join(appRoot, "site/console-stream.js"), "// fresh console stream\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "README.md"), "docs-only change\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "docs-only change");
  const nextSha = revParse(appRoot, "HEAD");

  return { root, appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha };
}

// Sandbox for the frontend staleness detector: the fake redeploy-frontend.sh
// stands in for the real Next build by leaving the same disk shape the real
// `npm run build:frontend` does — a tracked modification (index.html) plus an
// untracked build file (_next/chunk.js) layered over the stale committed
// frontend/ copies. `git stash push -u` in a test then reverts both, exactly
// like the 2026-06-28 VPS stash.
async function makeFrontendFixture() {
  const root = await mkdtemp(join(tmpdir(), "deploy-frontend-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");
  const deployLog = join(root, "deploy.log");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(join(appRoot, "frontend"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  await writeExecutable(join(appRoot, "scripts/ops/redeploy-frontend.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "APP_ROOT=$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/../..\" && pwd)",
    "echo frontend >> \"$DEPLOY_LOG\"",
    "printf 'fresh operator build %s\\n' \"${FAKE_FRONTEND_BUILD_STAMP:-1}\" > \"$APP_ROOT/frontend/index.html\"",
    "mkdir -p \"$APP_ROOT/frontend/_next\"",
    "printf '// chunk %s\\n' \"${FAKE_FRONTEND_BUILD_STAMP:-1}\" > \"$APP_ROOT/frontend/_next/chunk.js\""
  ].join("\n"));

  for (const command of ["docker", "curl", "npm", "flock", "jq"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  await writeFile(join(appRoot, "frontend/index.html"), "stale committed operator shell\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await writeFile(join(appRoot, "README.md"), "docs-only change\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "docs-only change");
  const nextSha = revParse(appRoot, "HEAD");

  return { root, appRoot, stackRoot, fakeBin, stateDir, deployLog, baseSha, nextSha };
}

async function makeDeployFreezeFixture(applyChange, message) {
  const root = await mkdtemp(join(tmpdir(), "deploy-contract-freeze-"));
  const appRoot = join(root, "app");
  const stackRoot = join(root, "stack");
  const fakeBin = join(root, "bin");
  const stateDir = join(root, "state");

  await mkdir(join(appRoot, "scripts/ops"), { recursive: true });
  await mkdir(stackRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(stackRoot, "docker-compose.yml"), "services: {}\n");
  await copyFile(DEPLOY_SCRIPT, join(appRoot, "scripts/ops/deploy-production.sh"));
  await chmod(join(appRoot, "scripts/ops/deploy-production.sh"), 0o755);

  for (const command of ["docker", "curl", "npm", "flock", "jq"]) {
    await writeExecutable(join(fakeBin, command), "#!/usr/bin/env bash\nexit 0\n");
  }

  git(appRoot, "init");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "Deploy Test");
  await writeFile(join(appRoot, "README.md"), "base\n");
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", "base");
  const baseSha = revParse(appRoot, "HEAD");

  await applyChange(appRoot);
  git(appRoot, "add", ".");
  git(appRoot, "commit", "-m", message);
  const nextSha = revParse(appRoot, "HEAD");

  return { appRoot, stackRoot, fakeBin, stateDir, baseSha, nextSha };
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function revParse(cwd, revision) {
  return execFileSync("git", ["rev-parse", revision], { cwd, encoding: "utf8" }).trim();
}

function runDeploy(cwd, env) {
  return spawnSync("bash", ["scripts/ops/deploy-production.sh"], {
    cwd,
    env: {
      ...process.env,
      ...env
    },
    encoding: "utf8"
  });
}
